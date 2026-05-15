import type { LedProcessOptions } from './types';

export const DEFAULT_LED_PROCESS_OPTIONS: LedProcessOptions = {
  maxWorkingSide: 768,
  processingMode: 'auto',
  quality: 'balanced',
  fitMode: 'cover',
  autoFitSketchContain: true,
  padColor: [0, 0, 0],
  gamma: 2.2,
  brightness: 1,
  paletteSize: 0,
  dithering: 'none',
  temporalRgbThreshold: 6,
  maxGifFps: 24,
  maxGifFrames: 24,
  flattenOrder: 'row_major',
};

export function mergeLedProcessOptions(
  partial?: Partial<LedProcessOptions>
): LedProcessOptions {
  return { ...DEFAULT_LED_PROCESS_OPTIONS, ...partial };
}
