import AsyncStorage from '@react-native-async-storage/async-storage';
import type { GalleryItem } from './types';
import { parseAnimationData } from './types';

const GALLERY_KEY = 'led_poster_gallery';

export async function loadGallery(): Promise<GalleryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(GALLERY_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as GalleryItem[];
  } catch {
    return [];
  }
}

async function saveGallery(items: GalleryItem[]): Promise<void> {
  await AsyncStorage.setItem(GALLERY_KEY, JSON.stringify(items));
}

export async function addToGallery(json: string, name?: string): Promise<GalleryItem | null> {
  const anim = parseAnimationData(json);
  if (!anim) return null;

  const item: GalleryItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name || anim.meta.name || 'Untitled',
    createdAt: new Date().toISOString(),
    json,
    width: anim.config.width,
    height: anim.config.height,
    frameCount: anim.frames.length,
  };

  const items = await loadGallery();
  items.unshift(item);
  await saveGallery(items);
  return item;
}

export async function removeFromGallery(id: string): Promise<void> {
  const items = await loadGallery();
  await saveGallery(items.filter((i) => i.id !== id));
}
