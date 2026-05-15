import type { AnimationData, RGBTriple, Frame } from './types';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from './gridConstants';
import { embedCenter } from './embedSprite';

type C = RGBTriple;
const Wc = DISPLAY_WIDTH;   // 32
const Hc = DISPLAY_HEIGHT;  // 48
const _: C = [0, 0, 0];    // transparent / background in sprite maps

// ─── Twinkling Stars (32×48) ─────────────────────────────────────────────────
// Fix: "off" state uses the sky colour — eliminated the dim-yellow random-pixel
// artefact from the previous version.  Stars now cycle through 4 brightness
// levels; each star is offset by its index so the field twinkles staggered.

function buildStarFrames(): Frame[] {
  const SKY: C = [0, 0, 22];
  const CYCLE: C[] = [
    [255, 255, 215],  // phase 0 – bright
    [120, 120,  88],  // phase 1 – mid
    [28,  28,  22],   // phase 2 – dim  (barely above sky)
    [0,   0,   22],   // phase 3 – off  (= sky, invisible)
  ];

  const stars = Array.from<never, [number, number]>({ length: 150 }, (_, i) => [
    (i * 17 + 3)                % Wc,
    (i * 23 + (i % 11) * 5 + 5) % Hc,
  ]);

  return [0, 1, 2, 3].map(phase => {
    const f: Frame = Array.from({ length: Wc * Hc }, () => [...SKY] as RGBTriple);
    stars.forEach(([x, y], s) => {
      f[y * Wc + x] = [...CYCLE[(s + phase) & 3]] as RGBTriple;
    });
    return f;
  });
}

export const STARS: AnimationData = {
  version: 1, type: 'animation',
  meta: { name: 'Twinkling Stars', created_at: '2026-04-06T00:00:00Z' },
  config: { width: Wc, height: Hc, fps: 3, loop: true, brightness: 0.8 },
  frames: buildStarFrames(),
};

// ─── Running Dog  (22 × 10 pixel-art sprite, centred on 32 × 48) ─────────────
// Roughly 3× bigger than the original 8×7.  The body/head/tail are identical
// across all four frames; only the two leg rows change (gallop ↔ trot).

const dB: C = [190, 128,  52];  // body tan
const dD: C = [110,  68,  22];  // dark brown
const dW: C = [238, 212, 158];  // cream / white patches
const dN: C = [ 10,  10,  10];  // black  (nose, eye outline)
const dT: C = [212, 162,  68];  // tail highlight
const dP: C = [240,  88,  98];  // tongue pink

// rows 0-7: body, head, tail — same for every frame (22 pixels wide each)
const DOG_BODY: C[][] = [
  [_,dT,dT,dT,dT,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  [dD,dD,dT,dT,dT,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_,_],
  [_,dD,dD,dB,dB,dB,dB,_,_,_,_,_,_,dD,dD,dD,_,_,_,_,_,_],
  [_,_,dD,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dD,dD,dD,_,_,_,_,_],
  [_,_,_,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dD,dN,dN,_,_,_,_],
  [_,_,_,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dB,dD,dN,dW,dW,_,_,_,_],
  [_,_,_,_,dB,dB,dB,dB,dB,dB,dB,dB,dW,dW,dB,dN,_,dW,dW,_,_,_],
  [_,_,_,_,_,dB,dB,dB,dB,dB,dB,dW,dW,dB,dB,dN,_,dP,_,_,_,_],
];

// rows 8-9: gallop — back leg stretches left, front leg stretches right
const DOG_LEGS_GALLOP: C[][] = [
  [dD,dB,_,_,_,_,dB,dB,dB,dB,dB,dB,dB,dB,dB,dD,_,_,_,_,_,_],
  [dD,_,_,_,_,_,dD,dB,dD,_,_,dD,dB,dD,_,dD,_,_,_,_,_,_],
];

// rows 8-9: trot — both legs collected under the body
const DOG_LEGS_TROT: C[][] = [
  [_,_,_,_,_,_,dB,dB,dB,_,_,dB,dB,dB,_,_,_,_,_,_,_,_],
  [_,_,_,_,_,_,dD,dB,dD,_,_,dD,dB,dD,_,_,_,_,_,_,_,_],
];

const makeDogFrame = (legs: C[][]): Frame => {
  const rows = [...DOG_BODY, ...legs];
  return embedCenter(Wc, Hc, 22, rows.length, rows.flat() as RGBTriple[]);
};

export const DOG: AnimationData = {
  version: 1, type: 'animation',
  meta: { name: 'Running Dog', created_at: '2026-04-06T00:00:00Z' },
  config: { width: Wc, height: Hc, fps: 5, loop: true, brightness: 0.85 },
  frames: [
    makeDogFrame(DOG_LEGS_GALLOP),
    makeDogFrame(DOG_LEGS_TROT),
    makeDogFrame(DOG_LEGS_GALLOP),
    makeDogFrame(DOG_LEGS_TROT),
  ],
};

// ─── Pac-Man Scene  (full 32 × 48 canvas, programmatic) ──────────────────────
// Pac-Man: 18 px diameter circle (radius 9) drawn with atan2 mouth cutout.
// Scene: 5 pellets to the right, red ghost (Blinky) below that bobs up/down.
// 4-frame animation: mouth open → half → closed (eats 1st pellet) → half.

function buildPacManFrames(): Frame[] {
  const BG:  C = [0,   0,  18];   // dark background
  const YEL: C = [255, 215,  0];  // Pac-Man yellow
  const EYE: C = [0,   0,  50];   // Pac-Man eye (dark blue dot)
  const PEL: C = [200, 200, 175]; // pellet dot
  const GR:  C = [210,  28,  28]; // ghost body red
  const GW:  C = [255, 255, 255]; // ghost eye sclera
  const GP:  C = [28,   28, 200]; // ghost eye pupil (looking left toward Pac-Man)

  const CX = 11, CY = 19, R = 9; // Pac-Man: left-centred, extends x=2..20  y=10..28

  const blank = (): Frame =>
    Array.from({ length: Wc * Hc }, () => [...BG] as RGBTriple);

  const set = (f: Frame, x: number, y: number, c: C): void => {
    if (x >= 0 && x < Wc && y >= 0 && y < Hc)
      f[y * Wc + x] = [...c] as RGBTriple;
  };

  // Draw Pac-Man with a wedge mouth opening to the RIGHT.
  // mouthDeg = total mouth angle in degrees (0 = fully closed).
  const drawPac = (f: Frame, mouthDeg: number): void => {
    for (let y = CY - R - 1; y <= CY + R + 1; y++) {
      for (let x = CX - R - 1; x <= CX + R + 1; x++) {
        const dx = x - CX, dy = y - CY;
        if (dx * dx + dy * dy <= R * R) {
          // atan2(-dy, dx): right=0°, top=+90°, bottom=−90°
          const a = Math.atan2(-dy, dx) * (180 / Math.PI);
          if (Math.abs(a) >= mouthDeg / 2) set(f, x, y, YEL);
        }
      }
    }
    // 2-pixel eye above centre-left
    set(f, CX - 3, CY - 4, EYE);
    set(f, CX - 2, CY - 4, EYE);
  };

  // Draw an 8 × 10 ghost at top-left corner (gx, gy).
  // Pupils face LEFT (toward Pac-Man who is to the ghost's left).
  const drawGhost = (f: Frame, gx: number, gy: number): void => {
    const rows = [
      '  RRRR  ',   // rounded dome
      ' RRRRRR ',
      'RRRRRRRR',
      'RRRRRRRR',
      'RRRRRRRR',
      'RWWRRWWR',   // eye sclera
      'RPWRRPWR',   // pupils at left edge of each eye → looking left
      'RRRRRRRR',
      'RR RR RR',   // wavy bottom
      'R  RR  R',
    ];
    rows.forEach((row, dy) => {
      Array.from(row).forEach((ch, dx) => {
        const c = ch === 'R' ? GR : ch === 'W' ? GW : ch === 'P' ? GP : null;
        if (c) set(f, gx + dx, gy + dy, c);
      });
    });
  };

  // Draw up to 5 pellets; skip the first `eaten` ones (already consumed).
  const drawPellets = (f: Frame, eaten: number): void => {
    [22, 24, 26, 28, 30].forEach((px, i) => {
      if (i >= eaten) set(f, px, CY, PEL);
    });
  };

  // Ghost at x=22 bobs 1 pixel up/down each frame; mouth cycles open→closed.
  const configs = [
    { mouth: 72, ghostDy: 0, eaten: 0 },  // mouth wide open
    { mouth: 36, ghostDy: 1, eaten: 0 },  // mouth half open
    { mouth:  5, ghostDy: 0, eaten: 1 },  // nearly closed — ate 1st pellet
    { mouth: 36, ghostDy:-1, eaten: 1 },  // half open again
  ];

  return configs.map(({ mouth, ghostDy, eaten }) => {
    const f = blank();
    drawPac(f, mouth);
    drawPellets(f, eaten);
    drawGhost(f, 22, 28 + ghostDy);
    return f;
  });
}

export const PACMAN: AnimationData = {
  version: 1, type: 'animation',
  meta: { name: 'Pacman', created_at: '2026-04-06T00:00:00Z' },
  config: { width: Wc, height: Hc, fps: 4, loop: true, brightness: 0.9 },
  frames: buildPacManFrames(),
};

export const ALL_SAMPLES = [STARS, DOG, PACMAN] as const;

export function animationToJson(anim: AnimationData): string {
  return JSON.stringify(anim, null, 2);
}
