import { useRef, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import LedGrid from '../components/LedGrid';
import { PROCESSOR_HTML } from '../lib/processorHtml';
import { addToGallery } from '../lib/gallery';
import { normalizeBaseUrl, postAnimationJson, postEmpty, getDeviceCaps } from '../lib/api';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from '../lib/gridConstants';
import { mergeLedProcessOptions } from '../lib/ledMedia/options';
import { buildProcessImageInjection } from '../lib/ledMedia/webInject';
import type { LedProcessOptions } from '../lib/ledMedia/types';
import type { AnimationData, Frame } from '../lib/types';

interface Props {
  baseUrl: string;
  gridWidth?: number;
  gridHeight?: number;
  /** Override any LED processing option (e.g. to force 'sketch' mode). */
  ledOptions?: Partial<LedProcessOptions>;
}

export default function ImportScreen({
  baseUrl,
  gridWidth = DISPLAY_WIDTH,
  gridHeight = DISPLAY_HEIGHT,
  ledOptions,
}: Props) {
  const webViewRef = useRef<WebView>(null);
  const resolveRef = useRef<((v: ProcessResult) => void) | null>(null);

  const [processing, setProcessing] = useState(false);
  const [animation, setAnimation] = useState<AnimationData | null>(null);
  const [name, setName] = useState('Imported');
  const [fps, setFps] = useState('10');
  const [brightness, setBrightness] = useState(0.8);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploadLabel, setUploadLabel] = useState('');

  // Dynamic frame cap from /caps endpoint — adapts automatically to whatever
  // heap the ESP has free right now.  Falls back to default 24 if unreachable.
  const [deviceMaxGifFrames, setDeviceMaxGifFrames] = useState(24);

  useEffect(() => {
    const url = normalizeBaseUrl(baseUrl);
    if (!url) return;
    getDeviceCaps(url)
      .then(result => {
        if (result.ok && result.caps && result.caps.maxFrames > 0) {
          setDeviceMaxGifFrames(result.caps.maxFrames);
          if (__DEV__) {
            console.log(
              `[ImportScreen] /caps: maxFrames=${result.caps.maxFrames} ` +
              `freeHeap=${result.caps.freeHeap} largestBlock=${result.caps.largestBlock}`
            );
          }
        }
      })
      .catch(() => {}); // silently ignore — firmware may be an older build
  }, [baseUrl]);

  type ProcessResult =
    | { frames: Frame[]; fps: number; delaysMs?: number[]; __debug?: Record<string, unknown> }
    | { error: string };

  const onWebViewMessage = (event: WebViewMessageEvent) => {
    try {
      const data: ProcessResult = JSON.parse(event.nativeEvent.data) as ProcessResult;
      resolveRef.current?.(data);
    } catch {
      resolveRef.current?.({ error: 'Failed to parse WebView response' });
    }
    resolveRef.current = null;
  };

  const processInWebView = (base64: string, mime: string): Promise<ProcessResult> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;

      // Merge caller overrides, then inject the live device cap so the
      // WebView trims GIF frames to exactly what the ESP can hold.
      const opts = mergeLedProcessOptions({
        maxGifFrames: deviceMaxGifFrames,
        ...ledOptions,
      });
      const js = buildProcessImageInjection(base64, mime, gridWidth, gridHeight, opts);
      webViewRef.current?.injectJavaScript(js);

      setTimeout(() => {
        if (resolveRef.current === resolve) {
          resolveRef.current = null;
          resolve({ error: 'Processing timed out' });
        }
      }, 45_000);
    });
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to import images.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    setProcessing(true);
    setError('');

    try {
      // ── Step 1: read raw bytes first ────────────────────────────────────
      // We must read before any manipulateAsync call so we can detect the
      // actual file type from magic bytes.  iOS routinely misreports GIF
      // MIME types as image/png or image/jpeg for files downloaded from the
      // internet, and manipulateAsync with SaveFormat.JPEG strips all
      // animation frames — so we MUST know it's a GIF before we scale.
      const rawBase64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 });

      // ── Step 2: detect GIF by file magic bytes ───────────────────────────
      // All GIF files (GIF87a and GIF89a) start with bytes that base64-encode
      // to exactly 'R0lGOD'.  This is more reliable than asset.mimeType on iOS.
      const isGif = rawBase64.startsWith('R0lGOD');
      const mime  = isGif ? 'image/gif' : (asset.mimeType ?? 'image/png');

      // ── Step 3: produce final base64 ────────────────────────────────────
      let base64: string;

      if (isGif) {
        // Use raw bytes directly — manipulateAsync would strip animation frames.
        base64 = rawBase64;
      } else {
        // Pre-scale large photos down to maxWorkingSide before injecting into
        // the WebView.  This reduces the injected base64 from potentially
        // 7–10 MB (12 MP photo) to ~200 KB without losing any quality that
        // matters at 32×48 LED resolution.
        // Aspect-ratio fit and crop are handled by fitToGridCanvas inside the
        // WebView; we only scale here, never crop.
        const opts = mergeLedProcessOptions(ledOptions);
        const maxSide = opts.maxWorkingSide;
        const srcLong = Math.max(asset.width ?? 1, asset.height ?? 1);
        if (srcLong > maxSide) {
          const resizeAction =
            (asset.width ?? 0) >= (asset.height ?? 0)
              ? { resize: { width: maxSide } }
              : { resize: { height: maxSide } };
          const scaled = await manipulateAsync(asset.uri, [resizeAction], {
            compress: 0.92,
            format: SaveFormat.JPEG,
          });
          base64 = await readAsStringAsync(scaled.uri, { encoding: EncodingType.Base64 });
        } else {
          base64 = rawBase64;  // reuse already-read bytes for small images
        }
      }

      const data = await processInWebView(base64, mime);

      if ('error' in data) {
        setError(data.error);
        setAnimation(null);
        return;
      }

      // Log debug metadata in development
      if (__DEV__ && data.__debug) {
        console.log('[ImportScreen] WebView debug:', JSON.stringify(data.__debug));
      }

      // Frames from the WebView are sRGB 0–255 values — use them as-is.
      // Brightness is kept at the firmware level (config.brightness) so that:
      //   • All RGB values stay exactly as the SAID pipeline produced them.
      //   • The ControlScreen brightness slider works independently.
      //   • No hue shift occurs from per-channel non-linear scaling.
      const fpsVal = data.fps ?? 10;
      setFps(String(fpsVal));

      const anim: AnimationData = {
        version: 1,
        type: 'animation',
        meta: { name, created_at: new Date().toISOString() },
        config: {
          width: gridWidth,
          height: gridHeight,
          fps: fpsVal,
          loop: true,
          brightness,   // firmware applies this; keeps full colour range in frames
        },
        frames: data.frames as Frame[],
      };
      setAnimation(anim);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      setAnimation(null);
    } finally {
      setProcessing(false);
    }
  };

  const updateFps = (val: string) => {
    setFps(val);
    if (animation) {
      const n = Math.min(Math.max(parseInt(val, 10) || 1, 1), 30);
      setAnimation({ ...animation, config: { ...animation.config, fps: n } });
    }
  };

  const updateName = (val: string) => {
    setName(val);
    if (animation) {
      setAnimation({ ...animation, meta: { ...animation.meta, name: val } });
    }
  };

  const adjustBrightness = (delta: number) => {
    const next = Math.min(1.0, Math.max(0.1, Math.round((brightness + delta) * 10) / 10));
    setBrightness(next);
    if (animation) {
      setAnimation({ ...animation, config: { ...animation.config, brightness: next } });
    }
  };

  const sendToDevice = async () => {
    if (!animation) return;
    const url = normalizeBaseUrl(baseUrl);
    if (!url) { Alert.alert('No ESP URL', 'Set the ESP base URL in Settings.'); return; }
    setSending(true);
    setUploadLabel('Starting upload…');
    try {
      const res = await postAnimationJson(baseUrl, animation, {
        onFrameUploaded: ({ frame, total }) => {
          setUploadLabel(`Uploading frame ${frame}/${total}…`);
        },
      });
      if (res.ok) {
        await postEmpty(baseUrl, '/play');
        Alert.alert('Sent', `"${animation.meta.name}" is playing on the LED grid.`);
      } else {
        Alert.alert('Error', res.error ?? 'Failed to send');
      }
    } finally {
      setSending(false);
      setUploadLabel('');
    }
  };

  const saveToGallery = async () => {
    if (!animation) return;
    const item = await addToGallery(JSON.stringify(animation), animation.meta.name);
    if (item) Alert.alert('Saved', `"${item.name}" added to gallery.`);
    else Alert.alert('Error', 'Failed to save');
  };

  return (
    <View style={styles.root}>
      <WebView
        ref={webViewRef}
        source={{ html: PROCESSOR_HTML }}
        onMessage={onWebViewMessage}
        style={styles.hiddenWebView}
        originWhitelist={['*']}
        javaScriptEnabled
      />

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionTitle}>Import Image / GIF</Text>
        <Text style={styles.hint}>
          Pick a photo or animated GIF. It will be scaled to {gridWidth}×{gridHeight} pixels for
          your LED grid using edge-aware downscaling.
        </Text>

        <Pressable style={styles.pickBtn} onPress={() => void pickImage()} disabled={processing}>
          <Text style={styles.pickBtnText}>
            {processing ? 'Processing…' : 'Pick from Photo Library'}
          </Text>
        </Pressable>

        {processing && <ActivityIndicator size="large" style={{ marginVertical: 16 }} />}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {animation && (
          <>
            <View style={styles.previewWrap}>
              <LedGrid animation={animation} playing />
            </View>

            <Text style={styles.info}>
              {animation.frames.length} frame{animation.frames.length !== 1 ? 's' : ''} at{' '}
              {animation.config.fps} fps
            </Text>

            <Text style={styles.label}>Name</Text>
            <TextInput style={styles.input} value={name} onChangeText={updateName} />

            {animation.frames.length > 1 && (
              <>
                <Text style={styles.label}>FPS (1–30)</Text>
                <TextInput
                  style={styles.input}
                  value={fps}
                  onChangeText={updateFps}
                  keyboardType="number-pad"
                />
              </>
            )}

            <Text style={styles.label}>Brightness</Text>
            <View style={styles.brightnessRow}>
              <Pressable style={styles.stepBtn} onPress={() => adjustBrightness(-0.1)}>
                <Text style={styles.stepBtnText}>−</Text>
              </Pressable>
              <Text style={styles.brightnessVal}>{Math.round(brightness * 100)}%</Text>
              <Pressable style={styles.stepBtn} onPress={() => adjustBrightness(0.1)}>
                <Text style={styles.stepBtnText}>+</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>
              Applied by firmware at playback. 80% default protects LED longevity.
            </Text>

            {uploadLabel ? (
              <Text style={styles.uploadStatus}>{uploadLabel}</Text>
            ) : null}

            <View style={styles.actions}>
              <Pressable
                style={[styles.btn, sending && { opacity: 0.6 }]}
                onPress={() => void sendToDevice()}
                disabled={sending}
              >
                <Text style={styles.btnText}>{sending ? 'Sending…' : 'Send to device'}</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnGreen]} onPress={() => void saveToGallery()}>
                <Text style={styles.btnText}>Save to gallery</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hiddenWebView: { width: 1, height: 1, opacity: 0, position: 'absolute' },
  scroll: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  hint: { fontSize: 13, color: '#666', marginBottom: 16, lineHeight: 19 },
  pickBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  pickBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  error: { color: '#dc2626', fontSize: 14, marginTop: 12 },
  previewWrap: {
    alignItems: 'center',
    marginTop: 16,
    backgroundColor: '#0a0a0a',
    borderRadius: 12,
    paddingVertical: 14,
  },
  info: { textAlign: 'center', color: '#555', fontSize: 13, marginTop: 8 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 14, marginBottom: 4, color: '#333' },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  brightnessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  },
  stepBtn: {
    backgroundColor: '#e5e7eb',
    borderRadius: 8,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnText: { fontSize: 22, fontWeight: '700', color: '#111', lineHeight: 28 },
  brightnessVal: { fontSize: 18, fontWeight: '600', minWidth: 52, textAlign: 'center' },
  uploadStatus: { fontSize: 14, color: '#2563eb', fontWeight: '600', marginTop: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnGreen: { backgroundColor: '#059669' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
