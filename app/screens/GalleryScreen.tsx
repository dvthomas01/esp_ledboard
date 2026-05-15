import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import LedGrid from '../components/LedGrid';
import { loadGallery, removeFromGallery } from '../lib/gallery';
import { parseAnimationData } from '../lib/types';
import type { AnimationData, GalleryItem } from '../lib/types';
import { normalizeBaseUrl, postAnimationJson, postEmpty } from '../lib/api';

interface Props {
  baseUrl: string;
}

export default function GalleryScreen({ baseUrl }: Props) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [selected, setSelected] = useState<GalleryItem | null>(null);
  const [animation, setAnimation] = useState<AnimationData | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState('');

  const refresh = useCallback(async () => {
    const list = await loadGallery();
    setItems(list);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = (item: GalleryItem) => {
    setSelected(item);
    setAnimation(parseAnimationData(item.json));
  };

  const sendToDevice = async (item: GalleryItem) => {
    const url = normalizeBaseUrl(baseUrl);
    if (!url) {
      Alert.alert('No ESP URL', 'Set the ESP base URL in Settings.');
      return;
    }
    const anim = parseAnimationData(item.json);
    if (!anim) {
      Alert.alert('Error', 'This saved item is not a valid animation.');
      return;
    }
    setSendingId(item.id);
    setUploadProgress('');
    try {
      const res = await postAnimationJson(baseUrl, anim, {
        onFrameUploaded: ({ frame, total }) => {
          setUploadProgress(`${frame}/${total}`);
        },
      });
      if (res.ok) {
        await postEmpty(baseUrl, '/play');
        Alert.alert('Sent', `"${item.name}" is playing on the LED grid.`);
      } else {
        Alert.alert('Error', res.error ?? 'Failed to send animation');
      }
    } finally {
      setSendingId(null);
      setUploadProgress('');
    }
  };

  const deleteItem = (item: GalleryItem) => {
    Alert.alert('Delete', `Remove "${item.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await removeFromGallery(item.id);
          if (selected?.id === item.id) {
            setSelected(null);
            setAnimation(null);
          }
          await refresh();
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: GalleryItem }) => {
    const isSelected = selected?.id === item.id;
    return (
      <View style={[styles.card, isSelected && styles.cardSelected]}>
        <Pressable style={styles.cardBody} onPress={() => select(item)}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.cardSub}>
            {item.width}x{item.height} — {item.frameCount} frame{item.frameCount !== 1 ? 's' : ''}
          </Text>
        </Pressable>
        <View style={styles.cardActions}>
          <Pressable
            style={[styles.sendBtn, sendingId !== null && { opacity: 0.5 }]}
            disabled={sendingId !== null}
            onPress={() => void sendToDevice(item)}
          >
            <Text style={styles.sendBtnText}>
              {sendingId === item.id ? 'Sending…' : 'Send'}
            </Text>
          </Pressable>
          <Pressable onPress={() => deleteItem(item)}>
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.root}>
      {animation && selected && (
        <View style={styles.previewWrap}>
          <LedGrid animation={animation} playing />
          <Text style={styles.previewLabel}>{selected.name}</Text>
          {sendingId === selected.id && uploadProgress ? (
            <Text style={styles.uploadProgress}>Uploading {uploadProgress}…</Text>
          ) : null}
        </View>
      )}

      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No saved animations yet.</Text>
          <Text style={styles.emptyHint}>Use "Save to gallery" in the Control tab.</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          onRefresh={() => void refresh()}
          refreshing={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  previewWrap: { alignItems: 'center', paddingVertical: 12, backgroundColor: '#0a0a0a' },
  previewLabel: { color: '#ccc', fontSize: 13, marginTop: 6 },
  uploadProgress: { color: '#93c5fd', fontSize: 12, marginTop: 4, fontWeight: '600' },
  list: { paddingHorizontal: 16, paddingBottom: 24, paddingTop: 8 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#555' },
  emptyHint: { fontSize: 14, color: '#888', marginTop: 8 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  cardSelected: { borderColor: '#2563eb', borderWidth: 2 },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  cardSub: { fontSize: 12, color: '#777', marginTop: 2 },
  cardActions: { alignItems: 'center', gap: 6, marginLeft: 8 },
  sendBtn: { backgroundColor: '#2563eb', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 },
  sendBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  deleteText: { color: '#dc2626', fontSize: 13, fontWeight: '600' },
});
