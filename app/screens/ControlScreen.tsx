import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
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

import {
  getStatus,
  normalizeBaseUrl,
  postAnimationJson,
  postEmpty,
  postJson,
} from '../lib/api';
import { addToGallery } from '../lib/gallery';
import { ALL_SAMPLES, animationToJson } from '../lib/sampleAnimations';

interface Props {
  baseUrl: string;
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export default function ControlScreen({ baseUrl }: Props) {
  // Large 32×48 sample JSON blocks the first paint if set synchronously; defer after mount.
  const [animationJson, setAnimationJson] = useState('');
  const [brightness, setBrightness] = useState('0.5');
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      setAnimationJson(animationToJson(ALL_SAMPLES[0]));
    }, 250);
    return () => clearTimeout(id);
  }, []);

  const appendLog = useCallback((title: string, payload: unknown) => {
    setLog((prev) => `[${title}]\n${formatJson(payload)}\n\n` + prev);
  }, []);

  const run = useCallback(
    async (title: string, fn: () => Promise<{ ok: boolean; data?: unknown; error?: string }>) => {
      const url = normalizeBaseUrl(baseUrl);
      if (!url) {
        appendLog(title, { error: 'Set ESP URL in Settings tab' });
        return;
      }
      setBusy(true);
      try {
        const res = await fn();
        appendLog(title, res.ok ? res.data ?? { ok: true } : { error: res.error, data: res.data });
      } finally {
        setBusy(false);
      }
    },
    [appendLog, baseUrl]
  );

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <View style={styles.row}>
        <Btn label="Status" disabled={busy} onPress={() => run('GET /status', () => getStatus(baseUrl))} />
        <Btn label="Play" disabled={busy} onPress={() => run('POST /play', () => postEmpty(baseUrl, '/play'))} />
        <Btn label="Pause" disabled={busy} onPress={() => run('POST /pause', () => postEmpty(baseUrl, '/pause'))} />
      </View>
      <View style={styles.row}>
        <Btn label="Stop" disabled={busy} onPress={() => run('POST /stop', () => postEmpty(baseUrl, '/stop'))} />
        <Btn label="Clear" disabled={busy} onPress={() => run('POST /clear', () => postEmpty(baseUrl, '/clear'))} />
      </View>

      <Text style={styles.label}>Brightness (0–1)</Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.inputSmall, styles.inputText]}
          placeholder="0.5"
          placeholderTextColor="#999"
          keyboardType="decimal-pad"
          value={brightness}
          onChangeText={setBrightness}
          autoFocus={false}
        />
        <Btn
          label="Set"
          disabled={busy}
          onPress={() =>
            run('POST /brightness', () =>
              postJson(baseUrl, '/brightness', { value: parseFloat(brightness) || 0 })
            )
          }
        />
      </View>

      <Text style={styles.label}>Load a sample</Text>
      <View style={styles.row}>
        {ALL_SAMPLES.map((s) => (
          <Pressable
            key={s.meta.name}
            style={styles.sampleBtn}
            onPress={() => setAnimationJson(animationToJson(s))}
          >
            <Text style={styles.sampleBtnText}>{s.meta.name}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <Btn
          label="Send"
          disabled={busy}
          onPress={() => run('POST /animation', () => postAnimationJson(baseUrl, animationJson))}
        />
        <Btn
          label="Save to gallery"
          disabled={busy}
          color="#059669"
          onPress={async () => {
            const item = await addToGallery(animationJson);
            appendLog('Gallery', item ? { saved: item.name } : { error: 'Invalid animation JSON' });
          }}
        />
      </View>

      <View style={styles.jsonHeader}>
        <Text style={styles.label}>Animation JSON</Text>
        <View style={styles.jsonActions}>
          <Pressable
            style={[styles.iconBtn, { backgroundColor: '#2563eb' }]}
            onPress={async () => {
              await Clipboard.setStringAsync(animationJson);
              appendLog('Clipboard', { copied: `${animationJson.length} chars` });
            }}
          >
            <Text style={styles.iconBtnText}>Copy</Text>
          </Pressable>
          <Pressable
            style={[styles.iconBtn, { backgroundColor: '#6b7280' }]}
            onPress={() => {
              Alert.alert('Clear JSON', 'Remove the animation JSON from the editor?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Clear', style: 'destructive', onPress: () => setAnimationJson('') },
              ]);
            }}
          >
            <Text style={styles.iconBtnText}>Clear</Text>
          </Pressable>
          <Pressable
            style={[styles.iconBtn, { backgroundColor: '#059669' }]}
            onPress={async () => {
              const text = await Clipboard.getStringAsync();
              if (text) {
                setAnimationJson(text);
                appendLog('Clipboard', { pasted: `${text.length} chars` });
              } else {
                appendLog('Clipboard', { error: 'Clipboard is empty' });
              }
            }}
          >
            <Text style={styles.iconBtnText}>Paste</Text>
          </Pressable>
        </View>
      </View>
      <TextInput
        style={styles.jsonBox}
        multiline
        value={animationJson}
        onChangeText={setAnimationJson}
        textAlignVertical="top"
        placeholder="Loading sample (large 32×48 JSON)…"
        placeholderTextColor="#888"
        scrollEnabled
        autoFocus={false}
        autoCorrect={false}
        autoCapitalize="none"
      />

      <Text style={styles.label}>Log</Text>
      {busy && <ActivityIndicator style={{ marginVertical: 8 }} />}
      <Text style={styles.log} selectable>
        {log || 'Responses appear here.'}
      </Text>
    </ScrollView>
  );
}

function Btn(props: { label: string; disabled?: boolean; color?: string; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.btn, { backgroundColor: props.color ?? '#2563eb' }, props.disabled && styles.btnDisabled]}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text style={styles.btnText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 6, color: '#333' },
  input: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  inputSmall: { flex: 1, marginRight: 8 },
  inputText: { color: '#111' },
  jsonBox: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 11,
    fontFamily: 'Menlo',
    minHeight: 120,
    maxHeight: 260,
    color: '#111',
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' },
  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  sampleBtn: { borderWidth: 1, borderColor: '#2563eb', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  sampleBtnText: { color: '#2563eb', fontWeight: '600', fontSize: 13 },
  log: {
    backgroundColor: '#111',
    color: '#e5e5e5',
    fontFamily: 'Menlo',
    fontSize: 11,
    padding: 12,
    borderRadius: 8,
    minHeight: 100,
  },
  jsonHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
    marginBottom: 6,
  },
  jsonActions: { flexDirection: 'row', gap: 6 },
  iconBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  iconBtnText: { color: '#fff', fontWeight: '600', fontSize: 12 },
});
