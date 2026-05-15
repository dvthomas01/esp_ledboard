import type { Frame, RGBTriple } from './types';

/** Place a small row-major sprite centered on a larger canvas (logical top-left coords). */
export function embedCenter(
  canvasW: number,
  canvasH: number,
  spriteW: number,
  spriteH: number,
  sprite: RGBTriple[],
): Frame {
  const out: Frame = Array.from({ length: canvasW * canvasH }, () => [0, 0, 0] as RGBTriple);
  const ox = Math.floor((canvasW - spriteW) / 2);
  const oy = Math.floor((canvasH - spriteH) / 2);
  for (let sy = 0; sy < spriteH; sy++) {
    for (let sx = 0; sx < spriteW; sx++) {
      out[(oy + sy) * canvasW + (ox + sx)] = sprite[sy * spriteW + sx];
    }
  }
  return out;
}
