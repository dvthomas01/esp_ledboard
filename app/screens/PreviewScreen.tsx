import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import LedGrid from '../components/LedGrid';
import { ALL_SAMPLES, animationToJson } from '../lib/sampleAnimations';
import { parseAnimationData } from '../lib/types';
import type { AnimationData } from '../lib/types';

export default function PreviewScreen() {
  const [jsonText, setJsonText] = useState('');
  const [animation, setAnimation] = useState<AnimationData | null>(null);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const a = ALL_SAMPLES[0];
    setAnimation(a);
    setJsonText(animationToJson(a));
  }, []);

  const loadPreview = () => {
    const parsed = parseAnimationData(jsonText);
    if (parsed) {
      setAnimation(parsed);
      setError('');
    } else {
      setError('Invalid animation JSON');
    }
  };

  const loadSample = (anim: AnimationData) => {
    const json = animationToJson(anim);
    setJsonText(json);
    setAnimation(anim);
    setError('');
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionTitle}>Preview</Text>

      <LedGrid animation={animation} playing={playing} />

      {animation && (
        <Text style={styles.info}>
          {animation.meta.name} — {animation.config.width}x{animation.config.height},{' '}
          {animation.frames.length} frame{animation.frames.length !== 1 ? 's' : ''},{' '}
          {animation.config.fps} fps
        </Text>
      )}

      <View style={styles.row}>
        <Pressable
          style={[styles.btn, { backgroundColor: playing ? '#dc2626' : '#059669' }]}
          onPress={() => setPlaying((p) => !p)}
        >
          <Text style={styles.btnText}>{playing ? 'Pause' : 'Play'}</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Load a sample</Text>
      <View style={styles.row}>
        {ALL_SAMPLES.map((s) => (
          <Pressable key={s.meta.name} style={styles.sampleBtn} onPress={() => loadSample(s)}>
            <Text style={styles.sampleBtnText}>{s.meta.name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Animation JSON</Text>
      <TextInput
        style={styles.jsonBox}
        multiline
        value={jsonText}
        onChangeText={setJsonText}
        textAlignVertical="top"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.btn} onPress={loadPreview}>
        <Text style={styles.btnText}>Load preview</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },
  sectionTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  info: { textAlign: 'center', color: '#555', fontSize: 13, marginTop: 10 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 6, color: '#333' },
  jsonBox: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    fontSize: 11,
    fontFamily: 'Menlo',
    minHeight: 140,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, justifyContent: 'center' },
  btn: {
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginTop: 8,
    alignSelf: 'center',
  },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 14, textAlign: 'center' },
  sampleBtn: {
    borderWidth: 1,
    borderColor: '#2563eb',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  sampleBtnText: { color: '#2563eb', fontWeight: '600', fontSize: 13 },
  error: { color: '#dc2626', fontSize: 13, marginTop: 6 },
});
