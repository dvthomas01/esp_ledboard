import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { AnimationData, RGBTriple } from '../lib/types';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from '../lib/gridConstants';

interface Props {
  animation: AnimationData | null;
  playing?: boolean;
  /** If omitted, size is chosen to fit typical phone width. */
  pixelSize?: number;
  gap?: number;
}

function rgbString([r, g, b]: RGBTriple): string {
  return `rgb(${r},${g},${b})`;
}

const OFF: RGBTriple = [0, 0, 0];

function defaultPixelSize(gridW: number, screenW: number): number {
  const maxW = Math.max(200, screenW - 48);
  const raw = Math.floor((maxW - 12) / gridW);
  return Math.max(4, Math.min(14, raw));
}

export default function LedGrid({
  animation,
  playing = true,
  pixelSize: pixelSizeProp,
  gap: gapProp,
}: Props) {
  const [frameIdx, setFrameIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { width: screenW, height: screenH } = useWindowDimensions();

  const width = animation?.config.width ?? DISPLAY_WIDTH;
  const height = animation?.config.height ?? DISPLAY_HEIGHT;
  const frames = animation?.frames ?? [];
  const fps = animation?.config.fps ?? 10;

  const pixelSize = pixelSizeProp ?? defaultPixelSize(width, screenW);
  const gap = gapProp ?? (pixelSize <= 8 ? 1 : 2);

  useEffect(() => {
    setFrameIdx(0);
  }, [animation]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!playing || frames.length <= 1) return;

    timerRef.current = setInterval(() => {
      setFrameIdx((prev) => {
        const next = prev + 1;
        if (next >= frames.length) {
          return animation?.config.loop ? 0 : prev;
        }
        return next;
      });
    }, 1000 / fps);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [playing, frames.length, fps, animation?.config.loop]);

  const frame = frames[frameIdx] ?? [];
  const gridWidth = width * pixelSize + (width - 1) * gap;
  const gridHeight = height * pixelSize + (height - 1) * gap;

  const maxPreviewH = Math.min(screenH * 0.55, 520);
  const needVScroll = gridHeight > maxPreviewH;
  const needHScroll = gridWidth > screenW - 28;

  const inner = (
    <View style={[styles.grid, { width: gridWidth, backgroundColor: '#111' }]}>
      {Array.from({ length: height }, (_, row) => (
        <View key={row} style={[styles.row, { gap }]}>
          {Array.from({ length: width }, (_, col) => {
            const idx = row * width + col;
            const pixel: RGBTriple = (frame[idx] as RGBTriple) ?? OFF;
            const isOn = pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0;
            return (
              <View
                key={col}
                style={[
                  styles.pixel,
                  {
                    width: pixelSize,
                    height: pixelSize,
                    backgroundColor: isOn ? rgbString(pixel) : '#1a1a1a',
                    borderRadius: pixelSize * 0.15,
                  },
                ]}
              />
            );
          })}
        </View>
      ))}
    </View>
  );

  return (
    <ScrollView
      nestedScrollEnabled
      scrollEnabled={needVScroll}
      style={{ maxHeight: maxPreviewH }}
      contentContainerStyle={{ alignItems: 'center' }}
      showsVerticalScrollIndicator={needVScroll}
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        scrollEnabled={needHScroll}
        showsHorizontalScrollIndicator={needHScroll}
        contentContainerStyle={{ alignItems: 'flex-start', paddingHorizontal: needHScroll ? 4 : 0 }}
      >
        {inner}
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  grid: {
    padding: 6,
    borderRadius: 10,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginVertical: 1,
  },
  pixel: {},
});
