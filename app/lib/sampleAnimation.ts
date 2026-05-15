import type { AnimationData } from './types';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from './gridConstants';
import { embedCenter } from './embedSprite';

/** 8×7 heart (two frames) — centered on the 32×48 logical grid; matches firmware boot style. */
const HEART_8x7: [number, number, number][][] = [
  [
    [0, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
  ],
  [
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
  ],
  [
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
  ],
  [
    [0, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
  ],
  [
    [0, 0, 0],
    [0, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [255, 0, 0],
    [255, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
  [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
];

function flatHeart(rows: typeof HEART_8x7): [number, number, number][] {
  return rows.flat() as [number, number, number][];
}

const heartAnim: AnimationData = {
  version: 1,
  type: 'animation',
  meta: {
    name: 'Heart Blink',
    created_at: '2026-04-05T00:00:00Z',
  },
  config: {
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    fps: 2,
    loop: true,
    brightness: 0.8,
  },
  frames: [
    embedCenter(DISPLAY_WIDTH, DISPLAY_HEIGHT, 8, 7, flatHeart(HEART_8x7)),
    embedCenter(DISPLAY_WIDTH, DISPLAY_HEIGHT, 8, 7, Array.from({ length: 8 * 7 }, () => [0, 0, 0] as [number, number, number])),
  ],
};

/** Valid animation JSON string for textarea / API tests (32×48). */
export const SAMPLE_HEART_ANIMATION = JSON.stringify(heartAnim, null, 2);
