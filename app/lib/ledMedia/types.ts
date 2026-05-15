import type { Frame, RGBTriple } from '../types';

/** User-facing processing preset (maps to SAID / quantization params). */
export type LedQualityMode = 'fast' | 'balanced' | 'high_quality';

/** Content hint; `auto` runs lightweight heuristics inside the WebView. */
export type LedProcessingMode = 'auto' | 'sketch' | 'photo' | 'icon' | 'gif';

/** How source media is fitted to the LED aspect ratio before downscaling. */
export type LedFitMode = 'contain' | 'cover' | 'smart_crop';

/**
 * Row-major flatten order for physical wiring (logical row-major remains default).
 * Firmware may apply serpentine; see hardware profile / protocol spec.
 */
export type LedFlattenOrder = 'row_major' | 'serpentine_placeholder';

export interface LedProcessOptions {
  /** Max longest side of the internal working image (before SAID downscale to LED size). */
  maxWorkingSide: number;
  processingMode: LedProcessingMode;
  quality: LedQualityMode;
  fitMode: LedFitMode;
  /** When fitMode is auto: sketches/icons tend toward contain; photos toward cover. */
  autoFitSketchContain: boolean;
  /** RGB background for letterboxing and transparent pixels (0–255). */
  padColor: RGBTriple;
  /** Display gamma (decode). post = linear * pow(linear, 1/gammaLed) * brightness — applied in `applyLedGammaAndBrightness`. */
  gamma: number;
  /** Multiplier 0–1 applied after gamma (preview + sent frames; firmware may also scale). */
  brightness: number;
  /** K=0 keeps full 8-bit RGB after SAID; K>0 runs k-means in WebView (Paper 4–inspired simplification). */
  paletteSize: number;
  /** Mild error diffusion gated by edge map (Paper 4). Off by default for sketches. */
  dithering: 'none' | 'edge_aware';
  /** Per-channel: if abs(delta) < threshold, keep previous GIF frame color (Paper 5). */
  temporalRgbThreshold: number;
  /** Caps GIF output fps after processing. */
  maxGifFps: number;
  /**
   * Hard cap on the number of frames sent to the device.
   * Frames are subsampled evenly (not just trimmed from the end) so the full
   * animation duration is preserved at a lower frame rate.
   * 0 = no cap.  Default 24 is safe for the ESP32-C3 heap.
   */
  maxGifFrames: number;
  flattenOrder: LedFlattenOrder;
}

export interface LedDecodedStill {
  kind: 'still';
  mime: string;
  base64: string;
}

export interface LedDecodedGif {
  kind: 'gif';
  mime: string;
  base64: string;
}

export type LedDecodedMedia = LedDecodedStill | LedDecodedGif;

/** WebView postMessage payload (success). */
export interface LedWebProcessOk {
  frames: Frame[];
  fps: number;
  /** Optional ms per frame when source is GIF (for future schema / preview). */
  delaysMs?: number[];
}

export interface LedWebProcessErr {
  error: string;
}

export type LedWebProcessResult = LedWebProcessOk | LedWebProcessErr;
