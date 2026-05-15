export interface AnimationMeta {
  name: string;
  created_at: string;
  author?: string;
}

export interface AnimationConfig {
  width: number;
  height: number;
  fps: number;
  loop: boolean;
  brightness: number;
}

export type RGBTriple = [number, number, number];
export type Frame = RGBTriple[];

export interface AnimationData {
  version: number;
  type: 'animation';
  meta: AnimationMeta;
  config: AnimationConfig;
  frames: Frame[];
}

export interface GalleryItem {
  id: string;
  name: string;
  createdAt: string;
  json: string;
  width: number;
  height: number;
  frameCount: number;
}

export function parseAnimationData(json: string): AnimationData | null {
  try {
    const obj = JSON.parse(json) as AnimationData;
    if (
      obj.version === 1 &&
      obj.type === 'animation' &&
      obj.config?.width > 0 &&
      obj.config?.height > 0 &&
      Array.isArray(obj.frames) &&
      obj.frames.length > 0
    ) {
      return obj;
    }
  } catch {
    /* invalid */
  }
  return null;
}
