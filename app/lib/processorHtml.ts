/**
 * Self-contained HTML page for a hidden WebView.
 *
 * Implements Phases 1–5 of the media-to-LED pipeline:
 *   Phase 1 — SAID-style edge-aware downscaling (Sobel + unsharp mask + fusion)
 *   Phase 2 — Auto content classification; mode-specific SAID params; sketch line thickening
 *   Phase 3 — k-means palette quantization (auto K by mode)
 *   Phase 4 — GIF: SAID per-frame, single global palette, temporal hysteresis, deduplication
 *   Phase 5 — Edge-aware Floyd-Steinberg dithering (photo mode, opt-in)
 *
 * Communication
 *   RN → WebView:  injectJavaScript(`processImage(base64, mime, w, h, optsJson)`)
 *   WebView → RN:  ReactNativeWebView.postMessage(JSON.stringify(result))
 *
 * Success: { frames: [[[r,g,b],...]], fps, delaysMs?, __debug? }
 * Error:   { error: string }
 *
 * Paper references
 *   [P2] Structure-Aware Image Downscaling (SAID)
 *   [P3] Pixelated Image Abstraction — palette & region concepts
 *   [P4] Edge-Aware Color Quantization — weighted RGB distance; dithering
 *   [P5] Spatio-Temporal Downsampling — GIF temporal hysteresis & global palette
 */

export const PROCESSOR_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>canvas{display:none}</style></head>
<body>
<canvas id="c"></canvas>
<canvas id="gc"></canvas>
<script>
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   DEFAULT OPTIONS  (mirror of app/lib/ledMedia/options.ts — keep in sync)
   ═══════════════════════════════════════════════════════════════════════════ */

var DEFAULT_OPTS = {
  maxWorkingSide: 768,       // longest side of internal working canvas
  processingMode: 'auto',    // 'auto'|'sketch'|'icon'|'photo'
  quality: 'balanced',       // 'fast'|'balanced'|'high_quality'  (high_quality → Phase 6)
  fitMode: 'cover',          // 'contain'|'cover'
  padColor: [0, 0, 0],
  paletteSize: 0,            // 0=auto by mode; -1=force off; >0=exact K
  dithering: 'none',         // 'none'|'edge_aware'  (photo mode only)
  temporalRgbThreshold: 18,  // GIF hysteresis: |dR|+|dG|+|dB| < threshold → keep prev
  maxGifFps: 24,
  // Hard cap on output frames. ESP32-C3 heap: ~200 KB free with WiFi active.
  // 1536 px × 3 bytes × 24 frames = 110 KB — safe with 70 KB headroom for HTTP buffers.
  maxGifFrames: 24,
};

function mergeOpts(u) {
  var m = {};
  for (var k in DEFAULT_OPTS) m[k] = DEFAULT_OPTS[k];
  if (u) for (var k in u) m[k] = u[k];
  return m;
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEIGHTED PERCEPTUAL RGB DISTANCE  [P4]
   Approximates luminance contribution of each channel.
   ═══════════════════════════════════════════════════════════════════════════ */

function wDist(a, b) {
  var dr = a[0]-b[0], dg = a[1]-b[1], db = a[2]-b[2];
  return 0.30*dr*dr + 0.59*dg*dg + 0.11*db*db;
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTO PALETTE SIZE  [Phase 3 / Phase 4, P3 / P4]
   paletteSize=0  → auto by mode
   paletteSize=-1 → always off
   paletteSize>0  → exact K override
   For photo + edge_aware dithering a palette is required even though photo
   normally disables quantization.
   ═══════════════════════════════════════════════════════════════════════════ */

function autoPaletteSize(mode, userK, dithering, isGif) {
  if (userK === -1)  return 0;
  if (userK > 0)     return userK;
  // GIFs: no forced global palette by default.
  // 16 colors was too few for action/photographic GIFs and washed out colours badly.
  // Temporal hysteresis (threshold=6) already suppresses per-frame flicker without needing
  // a shared colour map.  User can override with paletteSize > 0.
  if (isGif)         return 0;
  if (mode === 'sketch') return 3;
  if (mode === 'icon')   return 12;
  if (mode === 'photo' && dithering === 'edge_aware') return 24;
  return 0;  // photo without dithering: keep full RGB
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIXEL ARRAY HELPERS  (ImageData ↔ [[r,g,b],...])
   ═══════════════════════════════════════════════════════════════════════════ */

function imgDataToPixels(imgData) {
  var d = imgData.data, n = d.length / 4, px = new Array(n);
  for (var i = 0; i < n; i++) px[i] = [d[i*4], d[i*4+1], d[i*4+2]];
  return px;
}

function pixelsToImgData(pixels, w, h) {
  var out = new ImageData(w, h), od = out.data;
  for (var i = 0; i < pixels.length; i++) {
    od[i*4] = pixels[i][0]; od[i*4+1] = pixels[i][1]; od[i*4+2] = pixels[i][2]; od[i*4+3] = 255;
  }
  return out;
}

function imgDataToFrame(imgData) {
  return imgDataToPixels(imgData);
}

/* ═══════════════════════════════════════════════════════════════════════════
   K-MEANS CENTROIDS (k-means++ init)  [Phase 3 / Phase 4, P3 / P4]
   Reusable core — called by both still-image and GIF pipelines.
   ═══════════════════════════════════════════════════════════════════════════ */

function kMeansCentroids(pixels, k, iters) {
  var n = pixels.length;
  if (n === 0 || k <= 0) return [];

  // k-means++ initialisation: first centroid random, subsequent ones
  // sampled proportional to squared distance from nearest existing centroid
  var centroids = [pixels[Math.floor(Math.random() * n)].slice()];
  for (var c = 1; c < k; c++) {
    var dists = new Float32Array(n), total = 0;
    for (var i = 0; i < n; i++) {
      var minD = Infinity;
      for (var j = 0; j < centroids.length; j++) {
        var d = wDist(pixels[i], centroids[j]);
        if (d < minD) minD = d;
      }
      dists[i] = minD; total += minD;
    }
    var thr = Math.random() * total, cum = 0;
    var picked = pixels[n - 1];
    for (var i = 0; i < n; i++) { cum += dists[i]; if (cum >= thr) { picked = pixels[i]; break; } }
    centroids.push(picked.slice());
  }

  // Iterative refinement
  var assignments = new Int32Array(n);
  for (var iter = 0; iter < iters; iter++) {
    var sums = [], counts = new Int32Array(k);
    for (var c = 0; c < k; c++) sums.push([0, 0, 0]);
    for (var i = 0; i < n; i++) {
      var best = 0, bestD = Infinity;
      for (var c = 0; c < k; c++) { var d = wDist(pixels[i], centroids[c]); if (d < bestD) { bestD = d; best = c; } }
      assignments[i] = best;
      sums[best][0] += pixels[i][0]; sums[best][1] += pixels[i][1]; sums[best][2] += pixels[i][2];
      counts[best]++;
    }
    for (var c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c][0] = Math.round(sums[c][0] / counts[c]);
        centroids[c][1] = Math.round(sums[c][1] / counts[c]);
        centroids[c][2] = Math.round(sums[c][2] / counts[c]);
      }
    }
  }
  return centroids;
}

/* ═══════════════════════════════════════════════════════════════════════════
   APPLY PALETTE  (map each pixel to nearest centroid)
   ═══════════════════════════════════════════════════════════════════════════ */

function applyPaletteToPixels(pixels, centroids) {
  return pixels.map(function(p) {
    var best = 0, bestD = Infinity;
    for (var c = 0; c < centroids.length; c++) { var d = wDist(p, centroids[c]); if (d < bestD) { bestD = d; best = c; } }
    return centroids[best].slice();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   QUANTIZE IMAGE DATA  [Phase 3]
   Returns { imgData, centroids } — centroids needed by edge-aware dithering.
   ═══════════════════════════════════════════════════════════════════════════ */

function quantizeImgData(imgData, w, h, k) {
  var pixels    = imgDataToPixels(imgData);
  var centroids = kMeansCentroids(pixels, k, 24);
  var quantized = applyPaletteToPixels(pixels, centroids);
  return { imgData: pixelsToImgData(quantized, w, h), centroids: centroids };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONTENT CLASSIFICATION  [Phase 2, P3 heuristics]
   Runs on a 64×64 thumbnail; returns mode + diagnostic metrics.
   ═══════════════════════════════════════════════════════════════════════════ */

function classifyContent(workCanvas) {
  var TW = 64, TH = 64;
  var tc = document.createElement('canvas');
  tc.width = TW; tc.height = TH;
  var tx = tc.getContext('2d');
  tx.imageSmoothingEnabled = true;
  tx.drawImage(workCanvas, 0, 0, TW, TH);
  var d = tx.getImageData(0, 0, TW, TH).data;
  var n = TW * TH;

  var buckets = {}, grayCount = 0, total = 0, totalSat = 0;
  var gray = new Float32Array(n);

  for (var i = 0; i < n; i++) {
    var r = d[i*4], g = d[i*4+1], b = d[i*4+2];
    buckets[((r>>3)<<10)|((g>>3)<<5)|(b>>3)] = 1;
    var lum = 0.299*r + 0.587*g + 0.114*b;
    gray[i] = lum / 255;
    if (Math.abs(r-lum) < 18 && Math.abs(g-lum) < 18 && Math.abs(b-lum) < 18) grayCount++;
    var mx = Math.max(r,g,b), mn = Math.min(r,g,b);
    totalSat += mx > 0 ? (mx-mn)/mx : 0;
    total++;
  }

  // Sobel edge density on the 64×64 thumbnail
  var edgeCount = 0;
  for (var y = 1; y < TH-1; y++) {
    for (var x = 1; x < TW-1; x++) {
      var ii = y*TW+x;
      var gx = -gray[ii-TW-1]-2*gray[ii-1]-gray[ii+TW-1]+gray[ii-TW+1]+2*gray[ii+1]+gray[ii+TW+1];
      var gy = -gray[ii-TW-1]-2*gray[ii-TW]-gray[ii-TW+1]+gray[ii+TW-1]+2*gray[ii+TW]+gray[ii+TW+1];
      if (Math.sqrt(gx*gx+gy*gy) > 0.25) edgeCount++;
    }
  }

  var uniqueColors = Object.keys(buckets).length;
  var grayFraction = total > 0 ? grayCount/total : 0;
  var avgSat       = total > 0 ? totalSat/total : 0;
  var edgeDensity  = edgeCount / ((TW-2)*(TH-2));

  // SKETCH: must be nearly achromatic (avgSat < 0.08).  Coloured pixel-art on a grey
  //   background has high grayFraction + low uniqueColors but IS NOT a sketch — without
  //   the saturation gate it enters preprocessSketch which destroys all colour data.
  //   The black canvas padding from 'contain' mode makes bgLum=0 from corner sampling,
  //   inverting the ink/background detection and erasing the character outlines entirely.
  //
  // ICON: few unique colours AND well-defined edges (cartoon outlines).
  //   Smooth-gradient photos (sky, sunsets) have few quantised colours but low
  //   edgeDensity, so edgeDensity > 0.05 prevents them reaching the icon path.
  var mode = grayFraction > 0.60 && uniqueColors < 600 && avgSat < 0.08 ? 'sketch'
           : uniqueColors < 800 && avgSat > 0.10 && edgeDensity > 0.05  ? 'icon'
           :                                                                'photo';

  return {
    mode: mode, uniqueColors: uniqueColors,
    grayFraction: Math.round(grayFraction*100)/100,
    avgSat:       Math.round(avgSat*100)/100,
    edgeDensity:  Math.round(edgeDensity*100)/100,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   SKETCH PREPROCESSING  [Phase 2, P3 "important edges" preservation]
   Estimates background, detects line pixels, dilates 1 px (cross-shaped SE).
   Mutates workCanvas in place.
   ═══════════════════════════════════════════════════════════════════════════ */

function preprocessSketch(workCanvas) {
  var w = workCanvas.width, h = workCanvas.height;
  var ctx = workCanvas.getContext('2d');
  var imgData = ctx.getImageData(0, 0, w, h);
  var d = imgData.data, n = w * h;

  // Estimate background from 5×5 corner patches
  var bgSum = 0, bgCnt = 0;
  var corners = [[0,0],[w-5,0],[0,h-5],[w-5,h-5]];
  for (var ci = 0; ci < corners.length; ci++) {
    var cx0 = corners[ci][0], cy0 = corners[ci][1];
    for (var cy = cy0; cy < cy0+5 && cy < h; cy++) {
      for (var cx = cx0; cx < cx0+5 && cx < w; cx++) {
        var ii = (cy*w+cx)*4;
        bgSum += 0.299*d[ii] + 0.587*d[ii+1] + 0.114*d[ii+2];
        bgCnt++;
      }
    }
  }
  var bgLum = bgCnt > 0 ? bgSum/bgCnt : 200;
  var darkOnLight = bgLum > 128, lineThresh = 55;

  var lum = new Float32Array(n), isLine = new Uint8Array(n);
  var lineR = 0, lineG = 0, lineB = 0, lineCnt = 0;

  for (var i = 0; i < n; i++) {
    var L = 0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2];
    lum[i] = L;
    var isL = darkOnLight ? L < bgLum - lineThresh : L > bgLum + lineThresh;
    isLine[i] = isL ? 1 : 0;
    if (isL) { lineR += d[i*4]; lineG += d[i*4+1]; lineB += d[i*4+2]; lineCnt++; }
  }

  var avgLR = lineCnt > 0 ? Math.round(lineR/lineCnt) : (darkOnLight ? 20 : 235);
  var avgLG = lineCnt > 0 ? Math.round(lineG/lineCnt) : (darkOnLight ? 20 : 235);
  var avgLB = lineCnt > 0 ? Math.round(lineB/lineCnt) : (darkOnLight ? 20 : 235);

  // Cross-shaped 1-px dilation
  var dilated = new Uint8Array(n);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var ii = y*w+x;
      dilated[ii] = (isLine[ii]
        || (x > 0   && isLine[ii-1])
        || (x < w-1 && isLine[ii+1])
        || (y > 0   && isLine[ii-w])
        || (y < h-1 && isLine[ii+w])) ? 1 : 0;
    }
  }

  var out = ctx.createImageData(w, h), od = out.data;
  for (var i = 0; i < n; i++) {
    if (isLine[i]) {
      od[i*4]=d[i*4]; od[i*4+1]=d[i*4+1]; od[i*4+2]=d[i*4+2];
    } else if (dilated[i]) {
      od[i*4]=avgLR; od[i*4+1]=avgLG; od[i*4+2]=avgLB;
    } else {
      od[i*4]=d[i*4]; od[i*4+1]=d[i*4+1]; od[i*4+2]=d[i*4+2];
    }
    od[i*4+3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SOBEL EDGE MAP  [P2 — SAID step 1]
   ═══════════════════════════════════════════════════════════════════════════ */

function computeSobelEdgeMap(imgData, w, h) {
  var d = imgData.data;
  var gray = new Float32Array(w*h);
  for (var i = 0; i < w*h; i++)
    gray[i] = (0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2]) / 255;

  var edge = new Float32Array(w*h), maxE = 0;
  for (var y = 1; y < h-1; y++) {
    for (var x = 1; x < w-1; x++) {
      var ii = y*w+x;
      var tl=gray[ii-w-1],tc=gray[ii-w],tr=gray[ii-w+1];
      var ml=gray[ii-1],                 mr=gray[ii+1];
      var bl=gray[ii+w-1],bc=gray[ii+w],br=gray[ii+w+1];
      var gx=-tl-2*ml-bl+tr+2*mr+br, gy=-tl-2*tc-tr+bl+2*bc+br;
      var mag=Math.sqrt(gx*gx+gy*gy);
      edge[ii]=mag; if (mag>maxE) maxE=mag;
    }
  }
  if (maxE > 0) for (var i = 0; i < edge.length; i++) edge[i] /= maxE;
  return edge;
}

/* ═══════════════════════════════════════════════════════════════════════════
   BOX BLUR helpers  (sliding window, separable)
   Two H+V passes ≈ Gaussian sigma ≈ 1.3  (for radius=2)
   ═══════════════════════════════════════════════════════════════════════════ */

function boxBlurH(src, w, h, r) {
  var dst = new Float32Array(w*h);
  for (var y = 0; y < h; y++) {
    var sum = 0, cnt = 0;
    for (var x = 0; x <= r && x < w; x++) { sum += src[y*w+x]; cnt++; }
    for (var x = 0; x < w; x++) {
      dst[y*w+x] = sum/cnt;
      if (x+r+1 < w) { sum += src[y*w+x+r+1]; cnt++; }
      if (x-r >= 0)  { sum -= src[y*w+x-r];   cnt--; }
    }
  }
  return dst;
}

function boxBlurV(src, w, h, r) {
  var dst = new Float32Array(w*h);
  for (var x = 0; x < w; x++) {
    var sum = 0, cnt = 0;
    for (var y = 0; y <= r && y < h; y++) { sum += src[y*w+x]; cnt++; }
    for (var y = 0; y < h; y++) {
      dst[y*w+x] = sum/cnt;
      if (y+r+1 < h) { sum += src[(y+r+1)*w+x]; cnt++; }
      if (y-r >= 0)  { sum -= src[(y-r)*w+x];   cnt--; }
    }
  }
  return dst;
}

/* ═══════════════════════════════════════════════════════════════════════════
   UNSHARP MASK  [P2 — SAID: Is = I + amount*(I − blur(I))]
   ═══════════════════════════════════════════════════════════════════════════ */

function applyUnsharpMask(imgData, w, h, amount) {
  var d = imgData.data, n = w*h;
  var rc = new Float32Array(n), gc = new Float32Array(n), bc = new Float32Array(n);
  for (var i = 0; i < n; i++) { rc[i]=d[i*4]/255; gc[i]=d[i*4+1]/255; bc[i]=d[i*4+2]/255; }

  var br = boxBlurV(boxBlurH(boxBlurV(boxBlurH(rc,w,h,2),w,h,2),w,h,2),w,h,2);
  var bg = boxBlurV(boxBlurH(boxBlurV(boxBlurH(gc,w,h,2),w,h,2),w,h,2),w,h,2);
  var bb = boxBlurV(boxBlurH(boxBlurV(boxBlurH(bc,w,h,2),w,h,2),w,h,2),w,h,2);

  var out = new ImageData(w,h), od = out.data;
  for (var i = 0; i < n; i++) {
    od[i*4]  =Math.round(Math.min(1,Math.max(0,rc[i]+amount*(rc[i]-br[i])))*255);
    od[i*4+1]=Math.round(Math.min(1,Math.max(0,gc[i]+amount*(gc[i]-bg[i])))*255);
    od[i*4+2]=Math.round(Math.min(1,Math.max(0,bc[i]+amount*(bc[i]-bb[i])))*255);
    od[i*4+3]=d[i*4+3];
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   EDGE MAP DOWNSCALE (box average)  [P2]
   ═══════════════════════════════════════════════════════════════════════════ */

function downscaleEdgeMap(edge, srcW, srcH, dstW, dstH) {
  var out = new Float32Array(dstW*dstH);
  var xS = srcW/dstW, yS = srcH/dstH;
  for (var dy = 0; dy < dstH; dy++) {
    for (var dx = 0; dx < dstW; dx++) {
      var x0=Math.floor(dx*xS), x1=Math.min(Math.ceil((dx+1)*xS),srcW);
      var y0=Math.floor(dy*yS), y1=Math.min(Math.ceil((dy+1)*yS),srcH);
      var sum=0, cnt=0;
      for (var sy=y0;sy<y1;sy++) for (var sx=x0;sx<x1;sx++) { sum+=edge[sy*srcW+sx]; cnt++; }
      out[dy*dstW+dx] = cnt > 0 ? sum/cnt : 0;
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIT SOURCE TO WORKING CANVAS (contain / cover)
   Working canvas has LED aspect ratio at integer workScale up to maxWorkingSide.
   ═══════════════════════════════════════════════════════════════════════════ */

function fitToGridCanvas(src, targetW, targetH, fitMode, padColor, maxWorkingSide) {
  var workScale = Math.max(1, Math.floor(maxWorkingSide / Math.max(targetW, targetH)));
  var wW = targetW * workScale, wH = targetH * workScale;

  var wc = document.createElement('canvas');
  wc.width = wW; wc.height = wH;
  var ctx = wc.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = 'rgb('+padColor[0]+','+padColor[1]+','+padColor[2]+')';
  ctx.fillRect(0, 0, wW, wH);

  var srcW = src.videoWidth||src.naturalWidth||src.width||targetW;
  var srcH = src.videoHeight||src.naturalHeight||src.height||targetH;
  var scale = fitMode === 'contain' ? Math.min(wW/srcW,wH/srcH) : Math.max(wW/srcW,wH/srcH);
  var drawW = srcW*scale, drawH = srcH*scale;
  ctx.drawImage(src, (wW-drawW)/2, (wH-drawH)/2, drawW, drawH);
  return wc;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STRUCTURE-AWARE DOWNSCALE (SAID)  [Phases 1–2, P2]
   Returns { imgData, edgeLR } — edgeLR needed by Phase 5 dithering.
   sharpAmount selected per classified mode.
   ═══════════════════════════════════════════════════════════════════════════ */

function structureAwareDownscale(workCanvas, targetW, targetH, mode) {
  var wW = workCanvas.width, wH = workCanvas.height;
  var wCtx = workCanvas.getContext('2d');
  var workID = wCtx.getImageData(0, 0, wW, wH);

  // Mode-specific sharpening strength  [P2 parameter guidance]
  var sharpAmount = mode === 'sketch' ? 1.0 : mode === 'icon' ? 0.8 : 0.5;

  // Step 1: browser-resampled base at LED size
  // (imageSmoothingQuality='high' = bilinear/trilinear; engine-dependent, NOT bicubic)
  var baseC = document.createElement('canvas');
  baseC.width = targetW; baseC.height = targetH;
  var bCtx = baseC.getContext('2d');
  bCtx.imageSmoothingEnabled = true; bCtx.imageSmoothingQuality = 'high';
  bCtx.drawImage(workCanvas, 0, 0, targetW, targetH);
  var baseData = bCtx.getImageData(0, 0, targetW, targetH);

  // Step 2: Sobel edge map at working resolution  [P2 step 1]
  var edgeHR = computeSobelEdgeMap(workID, wW, wH);

  // Step 3: unsharp mask working image  [P2 step 3: Is = I + γ*(I − blur(I))]
  var sharpWork = applyUnsharpMask(workID, wW, wH, sharpAmount);
  var stC = document.createElement('canvas');
  stC.width = wW; stC.height = wH;
  stC.getContext('2d').putImageData(sharpWork, 0, 0);

  // Step 4: browser-resample sharpened image to LED size  [P2 step 3]
  var shpC = document.createElement('canvas');
  shpC.width = targetW; shpC.height = targetH;
  var sCtx = shpC.getContext('2d');
  sCtx.imageSmoothingEnabled = true; sCtx.imageSmoothingQuality = 'high';
  sCtx.drawImage(stC, 0, 0, targetW, targetH);
  var sharpData = sCtx.getImageData(0, 0, targetW, targetH);

  // Step 5: downscale edge map to LED size  [P2 step 4]
  var edgeLR = downscaleEdgeMap(edgeHR, wW, wH, targetW, targetH);

  // Step 6: per-pixel edge-guided fusion  [P2 step 5: out=(1−e)*base + e*sharp]
  var n = targetW * targetH;
  var fused = new ImageData(targetW, targetH);
  var fd = fused.data, bd = baseData.data, sd = sharpData.data;
  for (var i = 0; i < n; i++) {
    var e = edgeLR[i];
    fd[i*4]  =Math.round((1-e)*bd[i*4]  +e*sd[i*4]);
    fd[i*4+1]=Math.round((1-e)*bd[i*4+1]+e*sd[i*4+1]);
    fd[i*4+2]=Math.round((1-e)*bd[i*4+2]+e*sd[i*4+2]);
    fd[i*4+3]=255;
  }
  return { imgData: fused, edgeLR: edgeLR };
}

/* ═══════════════════════════════════════════════════════════════════════════
   EDGE-AWARE FLOYD-STEINBERG DITHERING  [Phase 5, P4]
   Diffuses quantization error using the standard F-S kernel (7/16 3/16 5/16 1/16)
   but reduces diffusion weight across strong edges so dithering noise does not
   bleed across object boundaries.
   Only called for photo mode when opts.dithering === 'edge_aware'.
   ═══════════════════════════════════════════════════════════════════════════ */

function edgeAwareDither(imgData, edgeLR, centroids, tw, th) {
  var d = imgData.data, n = tw * th;
  var MAX_ERR = 48;  // cap propagated error to prevent LED sparkle pixels

  // Float error accumulation buffers initialised from input pixels
  var er = new Float32Array(n), eg = new Float32Array(n), eb = new Float32Array(n);
  for (var i = 0; i < n; i++) { er[i]=d[i*4]; eg[i]=d[i*4+1]; eb[i]=d[i*4+2]; }

  var out = new ImageData(tw, th), od = out.data;

  for (var y = 0; y < th; y++) {
    for (var x = 0; x < tw; x++) {
      var i = y*tw+x;
      var cr=Math.min(255,Math.max(0,Math.round(er[i])));
      var cg=Math.min(255,Math.max(0,Math.round(eg[i])));
      var cb=Math.min(255,Math.max(0,Math.round(eb[i])));

      // Nearest palette colour
      var best=0, bestD=Infinity;
      for (var c=0;c<centroids.length;c++) {
        var dd=wDist([cr,cg,cb],centroids[c]); if (dd<bestD){bestD=dd;best=c;}
      }
      od[i*4]=centroids[best][0]; od[i*4+1]=centroids[best][1];
      od[i*4+2]=centroids[best][2]; od[i*4+3]=255;

      // Quantization error (clamped)
      var qr=Math.min(MAX_ERR,Math.max(-MAX_ERR,cr-centroids[best][0]));
      var qg=Math.min(MAX_ERR,Math.max(-MAX_ERR,cg-centroids[best][1]));
      var qb=Math.min(MAX_ERR,Math.max(-MAX_ERR,cb-centroids[best][2]));

      var eC = edgeLR[i];

      // Floyd-Steinberg kernel: gate each weight by 1 − avg(edge[src], edge[dst])
      // so error does not bleed across strong object boundaries.  [P4]
      var ni, gate, w;
      if (x+1 < tw) {
        ni=i+1; gate=1-Math.min(1,(eC+edgeLR[ni])/2); w=(7/16)*gate;
        er[ni]+=qr*w; eg[ni]+=qg*w; eb[ni]+=qb*w;
      }
      if (y+1 < th) {
        if (x-1 >= 0) {
          ni=(y+1)*tw+(x-1); gate=1-Math.min(1,(eC+edgeLR[ni])/2); w=(3/16)*gate;
          er[ni]+=qr*w; eg[ni]+=qg*w; eb[ni]+=qb*w;
        }
        ni=(y+1)*tw+x; gate=1-Math.min(1,(eC+edgeLR[ni])/2); w=(5/16)*gate;
        er[ni]+=qr*w; eg[ni]+=qg*w; eb[ni]+=qb*w;
        if (x+1 < tw) {
          ni=(y+1)*tw+(x+1); gate=1-Math.min(1,(eC+edgeLR[ni])/2); w=(1/16)*gate;
          er[ni]+=qr*w; eg[ni]+=qg*w; eb[ni]+=qb*w;
        }
      }
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SATURATION BOOST  (pixel-array version)
   SAID downscaling averages large source regions, which naturally desaturates
   colours (mixing nearby hues toward grey).  This restores perceived vividness.
   Works in sRGB — intentionally so, since that matches how displays perceive colour.

   ADAPTIVE: the per-pixel boost is scaled down when a pixel is already vivid
   (max − min channel gap ≥ 80).  Vivid pixels are boosted by at most +50 % of
   the requested amount to prevent them from being pushed into clipping
   territory and producing artifactual green/pink hues.
   ═══════════════════════════════════════════════════════════════════════════ */

function boostSaturation(pixels, amount) {
  return pixels.map(function(px) {
    var r = px[0], g = px[1], b = px[2];
    var lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Scale back the boost for already-vivid pixels so clipping on one channel
    // doesn't shift the hue (e.g. a slightly greenish pixel with R already near
    // 255 would lose green headroom first, turning pink/magenta).
    var vividness = Math.max(r, g, b) - Math.min(r, g, b);  // 0–255
    var effectiveAmount = vividness > 80
      ? 1 + (amount - 1) * 0.5   // only half-boost vivid pixels
      : amount;
    return [
      Math.min(255, Math.max(0, Math.round(lum + (r - lum) * effectiveAmount))),
      Math.min(255, Math.max(0, Math.round(lum + (g - lum) * effectiveAmount))),
      Math.min(255, Math.max(0, Math.round(lum + (b - lum) * effectiveAmount))),
    ];
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   GIF TEMPORAL HYSTERESIS  [Phase 4, P5]
   For each LED in frame N: if |dR|+|dG|+|dB| < threshold, keep frame N-1.
   Suppresses single-pixel flicker caused by rounding/palette differences.
   ═══════════════════════════════════════════════════════════════════════════ */

function applyTemporalHysteresis(frames, threshold) {
  if (frames.length <= 1 || threshold <= 0) return frames;
  var result = [frames[0]];
  for (var fi = 1; fi < frames.length; fi++) {
    var prev = result[result.length - 1];
    var curr = frames[fi];
    var next = new Array(curr.length);
    for (var i = 0; i < curr.length; i++) {
      var delta = Math.abs(curr[i][0]-prev[i][0])
                + Math.abs(curr[i][1]-prev[i][1])
                + Math.abs(curr[i][2]-prev[i][2]);
      next[i] = delta < threshold ? prev[i] : curr[i];
    }
    result.push(next);
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GIF FRAME DEDUPLICATION  [Phase 4, P5]
   Consecutive frames are merged only when they are essentially identical —
   i.e. no single LED pixel changed by more than a small threshold.

   WHY THE OLD METRIC WAS WRONG
   ─────────────────────────────
   The old code used:  total / pixelCount / 3 < 8  (avg per-pixel, per-channel)
   For a 32×48 = 1536 pixel grid, even Pac-Man moving 10 LED pixels by large
   colour amounts gives avg ≈ 10×470 / 4608 ≈ 1.0 — far below 8 — so virtually
   all meaningful animation frames were being merged into one "super-frame" and
   played as a single freeze, causing the discrete/jumpy appearance.

   NEW METRIC: count of meaningfully changed pixels (total |dR|+|dG|+|dB| > 15).
   Temporal hysteresis already suppressed sub-6 SAID noise before we get here,
   so surviving delta values are either 0 (truly static) or ≥ 6 (real change).
   We keep any frame that has at least 1 pixel with delta > 15, which covers:
     - Pac-Man moving 1 LED               → 2 px change each ~470  → kept ✓
     - Mouth open/close                   → 3-4 px change          → kept ✓
     - Dot eaten                          → 1 px white→black       → kept ✓
     - Ghost position shift               → 4-9 px change          → kept ✓
   Only truly identical frames (0 pixels changed after hysteresis)  → merged ✓
   ═══════════════════════════════════════════════════════════════════════════ */

function deduplicateFrames(frames, delays) {
  if (frames.length <= 1) return { frames: frames, delays: delays };
  var CHANGE_THRESH = 15;  // |dR|+|dG|+|dB| for a pixel to count as "changed"

  var outF = [frames[0]], outD = [delays[0]];
  for (var fi = 1; fi < frames.length; fi++) {
    var prev = outF[outF.length-1], curr = frames[fi];
    var changed = 0;
    for (var i = 0; i < curr.length; i++) {
      if (Math.abs(curr[i][0]-prev[i][0])
        + Math.abs(curr[i][1]-prev[i][1])
        + Math.abs(curr[i][2]-prev[i][2]) > CHANGE_THRESH) { changed++; }
    }
    if (changed < 1) {
      outD[outD.length-1] += delays[fi];  // truly identical — fold delay
    } else {
      outF.push(curr); outD.push(delays[fi]);
    }
  }
  return { frames: outF, delays: outD };
}

/* ═══════════════════════════════════════════════════════════════════════════
   LZW DECODER (GIF variant) — unchanged
   ═══════════════════════════════════════════════════════════════════════════ */

function lzwDecode(min, data) {
  var CC=1<<min, EOI=CC+1, cs=min+1, mask=(1<<cs)-1, nc=EOI+1;
  var tbl=new Array(4096);
  for (var i=0;i<CC;i++) tbl[i]=[i];
  var bits=0,buf=0,bp=0,out=[],prev=null;
  function rd(){
    while(bits<cs){buf|=(bp<data.length?data[bp++]:0)<<bits;bits+=8;}
    var c=buf&mask;buf>>=cs;bits-=cs;return c;
  }
  while(true){
    var code=rd();
    if(code===EOI)break;
    if(code===CC){
      cs=min+1;mask=(1<<cs)-1;nc=EOI+1;tbl.length=nc;
      for(var j=0;j<CC;j++)tbl[j]=[j];prev=null;continue;
    }
    var entry;
    if(code<nc){entry=tbl[code];}
    else if(code===nc&&prev){entry=prev.concat(prev[0]);}
    else break;
    for(var k=0;k<entry.length;k++)out.push(entry[k]);
    if(prev!==null&&nc<4096){
      tbl[nc]=prev.concat(entry[0]);nc++;
      if(nc>mask&&cs<12){cs++;mask=(1<<cs)-1;}
    }
    prev=entry;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEINTERLACE GIF ROWS — unchanged
   ═══════════════════════════════════════════════════════════════════════════ */

function deinterlace(px,w,h){
  var out=new Array(px.length);
  var passes=[{s:0,d:8},{s:4,d:8},{s:2,d:4},{s:1,d:2}];
  var src=0;
  for(var p=0;p<4;p++){
    for(var y=passes[p].s;y<h;y+=passes[p].d){
      var so=src*w,dso=y*w;
      for(var x=0;x<w;x++)out[dso+x]=px[so+x];
      src++;
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   GIF PARSER — unchanged
   ═══════════════════════════════════════════════════════════════════════════ */

function parseGif(d){
  var p=0;
  function u8(){return d[p++];}
  function u16(){var v=d[p]|(d[p+1]<<8);p+=2;return v;}
  function ctbl(n){var t=[];for(var i=0;i<n;i++)t.push([u8(),u8(),u8()]);return t;}

  var sig=String.fromCharCode(d[p],d[p+1],d[p+2],d[p+3],d[p+4],d[p+5]);p+=6;
  if(sig!=='GIF87a'&&sig!=='GIF89a')throw 'Not a GIF';

  var W=u16(),H=u16(),pk=u8();u8();u8();
  var gctF=(pk>>7)&1,gctSz=gctF?(1<<((pk&7)+1)):0;
  var gct=gctF?ctbl(gctSz):null;

  var frames=[],gce=null;
  while(p<d.length){
    var b=u8();
    if(b===0x3B)break;
    if(b===0x21){
      var lbl=u8();
      if(lbl===0xF9){
        u8();var gp=u8(),del=u16(),ti=u8();u8();
        gce={disp:(gp>>2)&7,trans:(gp&1)?ti:-1,delay:Math.max(del*10,20)};
      }else{while(true){var sz=u8();if(!sz)break;p+=sz;}}
      continue;
    }
    if(b===0x2C){
      var fl=u16(),ft=u16(),fw=u16(),fh=u16(),ip=u8();
      var lctF=(ip>>7)&1,intl=(ip>>6)&1;
      var lctSz=lctF?(1<<((ip&7)+1)):0;
      var lct=lctF?ctbl(lctSz):null;
      var ct=lct||gct;
      var mcs=u8(),ld=[];
      while(true){var bs=u8();if(!bs)break;for(var i=0;i<bs;i++)ld.push(d[p++]);}
      var idx=lzwDecode(mcs,ld);
      if(intl)idx=deinterlace(idx,fw,fh);
      var px=new Uint8ClampedArray(fw*fh*4);
      var tr=gce?gce.trans:-1;
      for(var n=0;n<fw*fh;n++){
        var ci=n<idx.length?idx[n]:0;
        if(ci===tr){px[n*4+3]=0;}
        else if(ct&&ci<ct.length){px[n*4]=ct[ci][0];px[n*4+1]=ct[ci][1];px[n*4+2]=ct[ci][2];px[n*4+3]=255;}
      }
      frames.push({l:fl,t:ft,w:fw,h:fh,px:px,disp:gce?gce.disp:0,delay:gce?gce.delay:100});
      gce=null;continue;
    }
    break;
  }
  return{w:W,h:H,gct:gct,frames:frames};
}

/* ═══════════════════════════════════════════════════════════════════════════
   GIF COMPOSITING HELPER
   Composites one parsed GIF frame onto the accumulator canvas (gc / gx).
   Returns the ImageData of the composited frame (for SAID or simple extract).
   ═══════════════════════════════════════════════════════════════════════════ */

function compositeGifFrame(f, gx, gc, bc, bx, tc) {
  if (f.disp === 3) { bx.clearRect(0,0,gc.width,gc.height); bx.drawImage(gc,0,0); }
  tc.width = f.w; tc.height = f.h;
  tc.getContext('2d').putImageData(new ImageData(f.px, f.w, f.h), 0, 0);
  gx.drawImage(tc, f.l, f.t);
}

function restoreGifDisposal(f, gx, gc, bc, bx) {
  if (f.disp === 2) gx.clearRect(f.l, f.t, f.w, f.h);
  else if (f.disp === 3) { gx.clearRect(0,0,gc.width,gc.height); gx.drawImage(bc,0,0); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROCESS GIF  [Phase 4 — SAID per-frame + global palette + hysteresis]
   Falls back to plain drawImage path if Phase 4 processing throws.
   ═══════════════════════════════════════════════════════════════════════════ */

function processGif(bytes, tw, th, opts) {
  var gif;
  try { gif = parseGif(bytes); } catch(e) { return { error: String(e) }; }
  if (!gif.frames.length) return { error: 'No frames found in GIF' };

  try {
    return processGifPhase4(gif, tw, th, opts);
  } catch (e) {
    // Fallback: plain Canvas drawImage per frame (original Phase 1 path)
    return processGifSimple(gif, tw, th, opts);
  }
}

function processGifPhase4(gif, tw, th, opts) {
  // Use a smaller working canvas for GIF to keep per-frame SAID fast.
  // 320 px max-side gives workScale=6 (192×288 for 32×48) — good balance.
  var gifMaxSide = Math.min(opts.maxWorkingSide, Math.max(gif.w * 2, tw * 4), 320);

  var gc = document.getElementById('gc');
  gc.width = gif.w; gc.height = gif.h;
  var gx = gc.getContext('2d');
  gx.clearRect(0, 0, gif.w, gif.h);

  var bc = document.createElement('canvas');
  bc.width = gif.w; bc.height = gif.h;
  var bx = bc.getContext('2d');
  var tc = document.createElement('canvas');

  var rawFrames = [], delays = [];

  for (var fi = 0; fi < gif.frames.length; fi++) {
    var f = gif.frames[fi];
    compositeGifFrame(f, gx, gc, bc, bx, tc);

    // SAID downscale: gc (full GIF size) → working canvas → LED canvas  [P2]
    var workCanvas = fitToGridCanvas(gc, tw, th, opts.fitMode, opts.padColor, gifMaxSide);
    var sad = structureAwareDownscale(workCanvas, tw, th, 'photo');
    // Restore saturation lost through SAID region-averaging (15 % boost, adaptive)
    var framePixels = boostSaturation(imgDataToPixels(sad.imgData), 1.15);
    rawFrames.push(framePixels);
    delays.push(f.delay);

    restoreGifDisposal(f, gx, gc, bc, bx);
  }

  // Global palette: build one palette from pixels sampled across ALL frames  [P5]
  var paletteK = autoPaletteSize('photo', opts.paletteSize, opts.dithering, true);
  var quantFrames = rawFrames;

  if (paletteK > 0) {
    // Sample pixels: at most ~6000 total training points for k-means speed
    var totalPixels = rawFrames.length * rawFrames[0].length;
    var sampleStep = Math.max(1, Math.floor(totalPixels / 6000));
    var allPixels = [];
    for (var fi = 0; fi < rawFrames.length; fi++) {
      for (var pi = 0; pi < rawFrames[fi].length; pi += sampleStep) {
        allPixels.push(rawFrames[fi][pi]);
      }
    }
    var centroids = kMeansCentroids(allPixels, paletteK, 24);

    // Quantize every frame to the SAME global palette  [P5]
    quantFrames = rawFrames.map(function(frame) {
      return applyPaletteToPixels(frame, centroids);
    });
  }

  // ── Subsample BEFORE hysteresis + dedup  [P4] ────────────────────────────
  // Subsampling on the raw timeline first ensures even coverage of visually
  // distinct moments.  If near-duplicate frames are clustered (e.g. 20 similar
  // frames at the tail of a loop), subsampling-after-dedup could over-represent
  // that cluster while discarding unique frames from earlier in the sequence.
  // Doing it before dedup avoids that bias entirely.
  var maxF = opts.maxGifFrames || 0;
  var preDedupCount = quantFrames.length;
  var workFrames = quantFrames;
  var workDelays = delays;
  if (maxF > 0 && quantFrames.length > maxF) {
    var step = quantFrames.length / maxF;
    var sampledF = [], sampledD = [];
    for (var si = 0; si < maxF; si++) {
      var idx = Math.min(Math.round(si * step), quantFrames.length - 1);
      sampledF.push(quantFrames[idx]);
      sampledD.push(delays[idx]);
    }
    workFrames = sampledF;
    workDelays = sampledD;
  }

  // Temporal hysteresis  [P5]
  var smoothedFrames = applyTemporalHysteresis(workFrames, opts.temporalRgbThreshold);

  // Remove near-duplicate consecutive frames  [P5]
  var deduped = deduplicateFrames(smoothedFrames, workDelays);

  var avg = deduped.delays.reduce(function(a,b){return a+b;},0) / deduped.delays.length;
  var fps = Math.min(Math.max(Math.round(1000/avg), 1), opts.maxGifFps || 24);

  return {
    frames:    deduped.frames,
    fps:       fps,
    delaysMs:  deduped.delays,
    __debug: {
      pipeline:        'GIF-phase4',
      gifSize:         gif.w + 'x' + gif.h,
      gifMaxSide:      gifMaxSide,
      originalFrames:  gif.frames.length,
      afterPalette:    preDedupCount,
      afterSubsample:  workFrames.length,
      finalFrames:     deduped.frames.length,
      paletteK:        paletteK,
      subsampledTo:    maxF > 0 && preDedupCount > maxF ? maxF : null,
    },
  };
}

function processGifSimple(gif, tw, th, opts) {
  var gc = document.getElementById('gc');
  gc.width = gif.w; gc.height = gif.h;
  var gx = gc.getContext('2d');
  gx.clearRect(0, 0, gif.w, gif.h);

  var c = document.getElementById('c');
  c.width = tw; c.height = th;
  var cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';

  var bc = document.createElement('canvas');
  bc.width = gif.w; bc.height = gif.h;
  var bx = bc.getContext('2d');
  var tc = document.createElement('canvas');
  var frames = [], delays = [];

  for (var fi = 0; fi < gif.frames.length; fi++) {
    var f = gif.frames[fi];
    compositeGifFrame(f, gx, gc, bc, bx, tc);
    cx.clearRect(0, 0, tw, th);
    cx.drawImage(gc, 0, 0, tw, th);
    var sd = cx.getImageData(0, 0, tw, th).data;
    var px = [];
    for (var j = 0; j < sd.length; j += 4) px.push([sd[j], sd[j+1], sd[j+2]]);
    frames.push(px);
    delays.push(f.delay);
    restoreGifDisposal(f, gx, gc, bc, bx);
  }

  var maxF = opts.maxGifFrames || 0;
  if (maxF > 0 && frames.length > maxF) {
    var step = frames.length / maxF;
    var sf = [], sd2 = [];
    for (var si = 0; si < maxF; si++) {
      var idx = Math.min(Math.round(si * step), frames.length - 1);
      sf.push(frames[idx]);
      sd2.push(delays[idx]);
    }
    frames = sf; delays = sd2;
  }

  var avg = delays.reduce(function(a,b){return a+b;},0) / delays.length;
  var fps = Math.min(Math.max(Math.round(1000/avg), 1), opts.maxGifFps || 24);
  return { frames: frames, fps: fps, delaysMs: delays,
           __debug: { pipeline: 'GIF-fallback', finalFrames: frames.length } };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 6 — PIXEL-ART SUPERPIXEL ABSTRACTION

   Drop-in alternative to structureAwareDownscale activated when
   opts.quality === 'high_quality'.

   For each LED output pixel its corresponding source tile (rW×rH source px)
   is reduced to a single colour via a SALIENCY-WEIGHTED MEAN IN LINEAR RGB:

     weight_px = 1 + sobel_magnitude[px] × edgeBoost
     edgeBoost  = sketch:8, icon:4, photo:2

   Averaging in linear RGB (not sRGB) is physically correct for LED panels
   which emit light additively.  Edge pixels dominate the final colour, so
   boundaries and outlines are preserved rather than washed out.

   A gentle per-LED contrast stretch is then applied (sketch+30%, icon+10%)
   to compensate for the slight flattening effect of any averaging.

   Returns { imgData, edgeLR } — identical signature to structureAwareDownscale.
   ═══════════════════════════════════════════════════════════════════════════ */

function srgbToLin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToSrgb(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  var s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function pixelArtAbstract(workCanvas, tw, th, mode) {
  var wW = workCanvas.width;
  var wH = workCanvas.height;
  var ctx = workCanvas.getContext('2d');
  var imgData = ctx.getImageData(0, 0, wW, wH);
  var d = imgData.data;

  // Sobel edge map at working resolution — reuse existing helper
  var edgeHR = computeSobelEdgeMap(imgData, wW, wH);  // Float32 [0..1], length wW*wH

  // Edge weight multiplier per mode
  var edgeBoost = mode === 'sketch' ? 8 : mode === 'icon' ? 4 : 2;

  // Per-LED contrast factor (compensates slight flattening from averaging)
  var contrastFactor = mode === 'sketch' ? 1.3 : mode === 'icon' ? 1.1 : 1.0;

  var out = new ImageData(tw, th);
  var od  = out.data;

  var rW = wW / tw;  // source px per LED column
  var rH = wH / th;  // source px per LED row

  for (var ledY = 0; ledY < th; ledY++) {
    for (var ledX = 0; ledX < tw; ledX++) {
      var x0 = Math.floor(ledX * rW);
      var y0 = Math.floor(ledY * rH);
      var x1 = Math.min(Math.ceil((ledX + 1) * rW), wW);
      var y1 = Math.min(Math.ceil((ledY + 1) * rH), wH);

      // Saliency-weighted sum in linear RGB.
      // For sketch mode we also track the single pixel with the highest Sobel
      // magnitude so we can detect thin lines even when they occupy only 1-2px
      // within a 16×16 tile (where they would be overwhelmed by the background
      // in a weighted average).
      var sumR = 0, sumG = 0, sumB = 0, sumW = 0;
      var maxEdgePx = 0, maxER = 0, maxEG = 0, maxEB = 0;

      for (var sy = y0; sy < y1; sy++) {
        for (var sx = x0; sx < x1; sx++) {
          var ii = sy * wW + sx;
          var ev = edgeHR[ii];
          var w  = 1 + ev * edgeBoost;
          sumR += srgbToLin(d[ii * 4])     * w;
          sumG += srgbToLin(d[ii * 4 + 1]) * w;
          sumB += srgbToLin(d[ii * 4 + 2]) * w;
          sumW += w;
          if (ev > maxEdgePx) {
            maxEdgePx = ev;
            maxER = d[ii * 4]; maxEG = d[ii * 4 + 1]; maxEB = d[ii * 4 + 2];
          }
        }
      }

      var ledIdx = ledY * tw + ledX;
      if (sumW > 0) {
        var outR, outG, outB;

        if (mode === 'sketch' && maxEdgePx > 0.08) {
          // Ink line detected in this tile: use the strongest-edge pixel's colour
          // directly rather than the weighted mean.  This preserves even single-pixel
          // lines that would otherwise be diluted by the surrounding background.
          outR = maxER; outG = maxEG; outB = maxEB;
        } else {
          // Photo / icon / sketch background: saliency-weighted linear mean
          var linR = sumR / sumW;
          var linG = sumG / sumW;
          var linB = sumB / sumW;

          if (contrastFactor !== 1.0) {
            var mid = 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;
            linR = Math.max(0, Math.min(1, mid + (linR - mid) * contrastFactor));
            linG = Math.max(0, Math.min(1, mid + (linG - mid) * contrastFactor));
            linB = Math.max(0, Math.min(1, mid + (linB - mid) * contrastFactor));
          }

          outR = linToSrgb(linR);
          outG = linToSrgb(linG);
          outB = linToSrgb(linB);
        }

        od[ledIdx * 4]     = outR;
        od[ledIdx * 4 + 1] = outG;
        od[ledIdx * 4 + 2] = outB;
      }
      od[ledIdx * 4 + 3] = 255;
    }
  }

  // Downscale the HR edge map to LED resolution for downstream dithering
  var edgeLR = new Float32Array(tw * th);
  for (var ly = 0; ly < th; ly++) {
    for (var lx = 0; lx < tw; lx++) {
      var ex0 = Math.floor(lx * rW), ey0 = Math.floor(ly * rH);
      var ex1 = Math.min(Math.ceil((lx + 1) * rW), wW);
      var ey1 = Math.min(Math.ceil((ly + 1) * rH), wH);
      var maxE = 0;
      for (var ey = ey0; ey < ey1; ey++) {
        for (var ex = ex0; ex < ex1; ex++) {
          var v = edgeHR[ey * wW + ex];
          if (v > maxE) maxE = v;
        }
      }
      edgeLR[ly * tw + lx] = maxE;
    }
  }

  return { imgData: out, edgeLR: edgeLR };
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEUTRAL BACKGROUND REMOVAL  (icon / pixel-art images)

   Sprite sheets and cartoon icons often have a neutral (grey, white, or
   other desaturated) background.  When that background is included in the
   working canvas it bleeds into border-tile colour averages in SAID and
   makes the character look washed out on the LED grid.

   Algorithm:
     1. Build a luminance histogram of all NEUTRAL (saturation < 0.20) pixels
        that are not already padColor.
     2. Find the most common neutral luma bucket → candidate background colour.
     3. Guard: skip if the background is near-white (>235) — likely intentional
        art (white shirt, etc.), or near padColor — already handled.
     4. Replace every pixel within Euclidean RGB distance 45 of the background
        with padColor so the character stands on a clean black LED backdrop.

   Only called for 'icon' mode.  Mutates the canvas in-place.
   ═══════════════════════════════════════════════════════════════════════════ */

function removeNeutralBackground(workCanvas, padColor) {
  var w = workCanvas.width, h = workCanvas.height;
  var ctx = workCanvas.getContext('2d');
  var imgData = ctx.getImageData(0, 0, w, h);
  var d = imgData.data, n = w * h;
  var pR = padColor[0], pG = padColor[1], pB = padColor[2];

  // Histogram of neutral (low-saturation) non-padColor pixels
  var hist = new Int32Array(256);
  var hR   = new Float64Array(256);
  var hG   = new Float64Array(256);
  var hB   = new Float64Array(256);

  for (var i = 0; i < n; i++) {
    var r = d[i*4], g = d[i*4+1], b = d[i*4+2];
    if (Math.abs(r-pR) + Math.abs(g-pG) + Math.abs(b-pB) < 20) continue; // skip padColor
    var mx = Math.max(r,g,b), mn = Math.min(r,g,b);
    if (mx > 0 && (mx-mn)/mx > 0.20) continue;  // coloured pixel – not background
    var lum = Math.round(0.299*r + 0.587*g + 0.114*b);
    hist[lum]++; hR[lum] += r; hG[lum] += g; hB[lum] += b;
  }

  // Find dominant luma bucket
  var peak = 0, peakLum = -1;
  for (var l = 0; l < 256; l++) { if (hist[l] > peak) { peak = hist[l]; peakLum = l; } }

  // Need > 5 % of pixels to be this colour before calling it a background
  if (peakLum < 0 || peak < n * 0.05) return;

  var bgR = hR[peakLum]/peak, bgG = hG[peakLum]/peak, bgB = hB[peakLum]/peak;

  // Don't remove near-white backgrounds (would erase white character elements)
  if (bgR > 235 && bgG > 235 && bgB > 235) return;

  // Don't remove if background IS already padColor (nothing to do)
  if (Math.abs(bgR-pR) + Math.abs(bgG-pG) + Math.abs(bgB-pB) < 30) return;

  // Replace background pixels with padColor (Euclidean tolerance = 45)
  var tol2 = 45 * 45;
  for (var i = 0; i < n; i++) {
    var dr = d[i*4]-bgR, dg = d[i*4+1]-bgG, db = d[i*4+2]-bgB;
    if (dr*dr + dg*dg + db*db < tol2) {
      d[i*4] = pR; d[i*4+1] = pG; d[i*4+2] = pB;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROCESS STILL IMAGE  (Phases 1–3 + Phase 5 dithering + Phase 6 pixel-art)

   Flow:
     fitToGridCanvas
       → classifyContent → [preprocessSketch?] → [icon: removeNeutralBackground]
         → [quality=high_quality → pixelArtAbstract]
            OR [structureAwareDownscale]   (both return {imgData, edgeLR})
           → [quantizeImgData | edgeAwareDither]
             → return frame + debug

   Falls back to plain Canvas resize on any error.
   ═══════════════════════════════════════════════════════════════════════════ */

function processStatic(bytes, mime, tw, th, opts) {
  return new Promise(function(resolve) {
    var blob = new Blob([bytes], { type: mime });
    var url  = URL.createObjectURL(blob);
    var img  = new Image();

    img.onload = function() {
      var t0 = Date.now();
      try {
        // ── Phase 1: fit ─────────────────────────────────────────────────
        var workCanvas = fitToGridCanvas(img, tw, th, opts.fitMode, opts.padColor, opts.maxWorkingSide);

        // ── Phase 2: classify ─────────────────────────────────────────────
        var classification = classifyContent(workCanvas);
        var effectiveMode  = (opts.processingMode && opts.processingMode !== 'auto')
          ? opts.processingMode : classification.mode;

        // Auto fit-mode: sketches/icons → contain (don't crop the artwork)
        if (opts.processingMode === 'auto' && opts.fitMode === 'cover'
            && (effectiveMode === 'sketch' || effectiveMode === 'icon')) {
          workCanvas = fitToGridCanvas(img, tw, th, 'contain', opts.padColor, opts.maxWorkingSide);
        }

        // ── Phase 2: sketch preprocessing ────────────────────────────────
        if (effectiveMode === 'sketch') preprocessSketch(workCanvas);

        // ── Icon: remove neutral/grey artistic background ─────────────────
        // Sprite sheets and cartoons often sit on a neutral background that
        // bleeds into SAID tile averages and washes out the character colours.
        // Replace neutral background pixels with padColor (black) so the
        // character stands on a clean LED backdrop.
        if (effectiveMode === 'icon') removeNeutralBackground(workCanvas, opts.padColor);

        // ── Phase 1+2 / Phase 6: downscale ───────────────────────────────
        // high_quality → pixel-art superpixel abstraction (Phase 6)
        // otherwise    → SAID structure-aware downscale  (Phases 1+2)
        var usePixelArt = (opts.quality === 'high_quality');
        var sad    = usePixelArt
          ? pixelArtAbstract(workCanvas, tw, th, effectiveMode)
          : structureAwareDownscale(workCanvas, tw, th, effectiveMode);
        var ledID  = sad.imgData;
        var edgeLR = sad.edgeLR;

        // ── Phase 3 / 5: palette + optional dithering ────────────────────
        var paletteK  = autoPaletteSize(effectiveMode, opts.paletteSize, opts.dithering, false);
        var finalID   = ledID;

        if (opts.dithering === 'edge_aware' && effectiveMode === 'photo') {
          // Phase 5: dither instead of plain quantize  [P4]
          var k = paletteK > 0 ? paletteK : 24;
          var centroids = kMeansCentroids(imgDataToPixels(ledID), k, 24);
          finalID = edgeAwareDither(ledID, edgeLR, centroids, tw, th);
          paletteK = k;  // reflect actual K in debug
        } else if (paletteK > 0) {
          // Phase 3: plain k-means quantization  [P3 / P4]
          var qr = quantizeImgData(ledID, tw, th, paletteK);
          finalID = qr.imgData;
        }

        URL.revokeObjectURL(url);
        resolve({
          frames: [imgDataToFrame(finalID)],
          fps: 1,
          __debug: {
            processingTimeMs: Date.now() - t0,
            pipeline:         (usePixelArt ? 'PixelArtP6' : 'SAID-phase1-2-3')
                              + (opts.dithering === 'edge_aware' ? '+5' : ''),
            quality:          opts.quality,
            workingSize:      workCanvas.width + 'x' + workCanvas.height,
            classifiedMode:   classification.mode,
            effectiveMode:    effectiveMode,
            uniqueColors:     classification.uniqueColors,
            grayFraction:     classification.grayFraction,
            avgSat:           classification.avgSat,
            edgeDensity:      classification.edgeDensity,
            paletteK:         paletteK,
            dithering:        opts.dithering,
          },
        });

      } catch (e) {
        // ── Fallback: plain high-quality Canvas resize ────────────────────
        try {
          var c = document.getElementById('c');
          c.width = tw; c.height = th;
          var cx = c.getContext('2d');
          cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
          cx.drawImage(img, 0, 0, tw, th);
          var sd = cx.getImageData(0, 0, tw, th).data;
          var frame = [];
          for (var i = 0; i < sd.length; i += 4) frame.push([sd[i], sd[i+1], sd[i+2]]);
          URL.revokeObjectURL(url);
          resolve({ frames: [frame], fps: 1,
                    __debug: { pipeline: 'fallback-canvas', reason: String(e) } });
        } catch (e2) {
          URL.revokeObjectURL(url);
          resolve({ error: 'Image processing failed: ' + String(e2) });
        }
      }
    };

    img.onerror = function() {
      URL.revokeObjectURL(url);
      resolve({ error: 'Image decode failed' });
    };

    img.src = url;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENTRY POINT — called from React Native via injectJavaScript
   processImage(base64, mime, tw, th [, optsJson])
   Backward-compatible: optsJson is optional (4-argument calls still work).
   ═══════════════════════════════════════════════════════════════════════════ */

function processImage(base64, mime, tw, th, optsJson) {
  try {
    var opts  = mergeOpts(optsJson ? JSON.parse(optsJson) : {});
    var raw   = atob(base64);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    // Belt-and-suspenders GIF detection: verify file magic bytes regardless of
    // the declared MIME type.  All GIF files (87a and 89a) base64-encode their
    // first 4 bytes to 'R0lG' and the 5th–6th to 'OD', giving 'R0lGOD'.
    // ImportScreen already fixes the MIME before this call, but this guard
    // catches any remaining edge cases (e.g. Files-app picks with wrong headers).
    var isGif = (mime === 'image/gif') || (base64.substring(0, 6) === 'R0lGOD');

    if (isGif) {
      var result = processGif(bytes, tw, th, opts);
      window.ReactNativeWebView.postMessage(JSON.stringify(result));
    } else {
      processStatic(bytes, mime, tw, th, opts).then(function(result) {
        window.ReactNativeWebView.postMessage(JSON.stringify(result));
      });
    }
  } catch (e) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ error: String(e) }));
  }
}
</script>
</body></html>`;
