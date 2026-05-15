import type { Frame, RGBTriple } from '../types';
import type { LedFlattenOrder } from './types';

/**
 * Apply a uniform linear brightness scale to an RGB triple.
 *
 * All three channels are multiplied by the same factor, which preserves hue
 * exactly.  Gamma encoding is intentionally NOT performed here:
 *
 *   • The WebView Canvas returns sRGB values (already gamma-encoded for
 *     display).  Re-encoding them with pow(x, 1/γ) would lift dark values
 *     non-uniformly, shifting hues and washing out colours.
 *   • Physical LED gamma compensation (WS2812B / NeoPixel) is handled by
 *     the firmware via AnimationData.config.brightness, not in the app.
 *
 * The `gamma` parameter is accepted for API compatibility and future use
 * (e.g. a correct sRGB→linear→LED decode path) but is currently ignored.
 *
 * TODO Phase 2+: if we ever want sRGB→linear decoding for linear LEDs, the
 * correct operation is pow(x/255, γ) (γ=2.2), which DARKENS mid-tones —
 * the opposite of what the old code was doing with pow(x/255, 1/γ).
 */
export function applyLedGammaAndBrightness(
  rgb: RGBTriple,
  _gamma: number,
  brightness: number
): RGBTriple {
  const b = Math.min(1, Math.max(0, brightness));
  return [
    Math.round(Math.min(255, Math.max(0, (rgb[0] ?? 0) * b))),
    Math.round(Math.min(255, Math.max(0, (rgb[1] ?? 0) * b))),
    Math.round(Math.min(255, Math.max(0, (rgb[2] ?? 0) * b))),
  ];
}

/** Row-major (y * width + x) * 3. Serpentine placeholder reverses every other row (logical only). */
export function flattenRgbFrame(
  frame: Frame,
  width: number,
  height: number,
  order: LedFlattenOrder
): Uint8Array {
  const expected = width * height;
  if (frame.length !== expected) {
    throw new Error(`flattenRgbFrame: expected ${expected} pixels, got ${frame.length}`);
  }
  const out = new Uint8Array(expected * 3);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const reverse = order === 'serpentine_placeholder' && y % 2 === 1;
    for (let xi = 0; xi < width; xi++) {
      const x = reverse ? width - 1 - xi : xi;
      const p = frame[y * width + x] ?? [0, 0, 0];
      out[o++] = p[0];
      out[o++] = p[1];
      out[o++] = p[2];
    }
  }
  return out;
}
