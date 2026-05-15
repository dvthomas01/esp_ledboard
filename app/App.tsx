import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import ControlScreen from './screens/ControlScreen';
import PreviewScreen from './screens/PreviewScreen';
import GalleryScreen from './screens/GalleryScreen';
import ImportScreen from './screens/ImportScreen';

const URL_KEY = 'esp_base_url';

type Tab = 'control' | 'preview' | 'gallery' | 'import' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('control');
  const [baseUrl, setBaseUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const saved = await AsyncStorage.getItem(URL_KEY);
        if (saved) {
          setBaseUrl(saved);
          setUrlDraft(saved);
        }
      } catch (e) {
        console.warn('[App] AsyncStorage failed (continuing with empty URL)', e);
      }
    })();
  }, []);

  const saveUrl = async () => {
    const url = urlDraft.trim();
    setBaseUrl(url);
    await AsyncStorage.setItem(URL_KEY, url);
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="dark" />

      {__DEV__ ? (
        <View style={styles.devBanner}>
          <Text style={styles.devBannerText}>
            First load only: Expo Go needs Metro — run{' '}
            <Text style={styles.devBannerMono}>cd app && npx expo start</Text>
            {' '}and open this project (QR or manual URL). Phone and Mac should be able to
            talk (often same LAN, or{' '}
            <Text style={styles.devBannerMono}>expo start --tunnel</Text>
            ).
            {'\n\n'}
            Poster control runs over Wi‑Fi to the ESP base URL once this screen loaded;
            USB to the microcontroller is not involved. Leaving the laptop or unplugging USB
            is fine — keep Expo Go running and stay on Wi‑Fi with the board (reload/restoring
            the app requires Metro again).
          </Text>
        </View>
      ) : null}

      <View style={styles.header}>
        <Text style={styles.title}>LED Poster</Text>
        {baseUrl ? (
          <Text style={styles.urlBadge}>{baseUrl}</Text>
        ) : (
          <Text style={styles.urlMissing}>No ESP URL — go to Settings</Text>
        )}
      </View>

      <View style={styles.body}>
        {tab === 'control' && <ControlScreen baseUrl={baseUrl} />}
        {tab === 'preview' && <PreviewScreen />}
        {tab === 'gallery' && <GalleryScreen baseUrl={baseUrl} />}
        {tab === 'import' && <ImportScreen baseUrl={baseUrl} />}
        {tab === 'settings' && (
          <ScrollView contentContainerStyle={styles.settingsWrap} keyboardShouldPersistTaps="handled">
            <Text style={styles.settingsTitle}>Settings</Text>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Expo Go + Wi‑Fi</Text>
              <Text style={styles.hint}>
                Poster joins your Wi‑Fi from{' '}
                <Text style={{ fontWeight: '700' }}>firmware/include/wifi_config.h</Text>
                {' '}(SSID and password); flash again if you move networks.
                {'\n\n'}
                This project uses HTTP only: save the ESP base URL (below). Phone and ESP
                should be on the same LAN — no tether to your laptop except for downloading
                the JS bundle — use a portable battery bank for USB power where you want.
                {'\n\n'}
                If the board reboots, DHCP might give it a new IP; check your router DHCP list
                or serial log and update the URL.
              </Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>ESP Base URL</Text>
              <TextInput
                style={styles.input}
                placeholder="http://192.168.1.42"
                placeholderTextColor="#999"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                value={urlDraft}
                onChangeText={setUrlDraft}
              />
              <Pressable style={styles.saveBtn} onPress={() => void saveUrl()}>
                <Text style={styles.saveBtnText}>Save URL</Text>
              </Pressable>
              <Text style={styles.hint}>
                Phone and poster should be on the same Wi‑Fi (or same routed LAN). Use{' '}
                <Text style={{ fontWeight: '700' }}>http://</Text> and the board&apos;s IP;
                no trailing slash needed.
              </Text>
            </View>
          </ScrollView>
        )}
      </View>

      <View style={styles.tabBar}>
        <TabBtn label="Control" active={tab === 'control'} onPress={() => setTab('control')} />
        <TabBtn label="Preview" active={tab === 'preview'} onPress={() => setTab('preview')} />
        <TabBtn label="Import" active={tab === 'import'} onPress={() => setTab('import')} />
        <TabBtn label="Gallery" active={tab === 'gallery'} onPress={() => setTab('gallery')} />
        <TabBtn label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
    </SafeAreaView>
  );
}

function TabBtn(props: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.tabBtn} onPress={props.onPress}>
      <Text style={[styles.tabLabel, props.active && styles.tabLabelActive]}>
        {props.label}
      </Text>
      {props.active && <View style={styles.tabIndicator} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f5f5f5' },
  devBanner: {
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#0f172a',
  },
  devBannerText: {
    color: '#e2e8f0',
    fontSize: 12,
    lineHeight: 17,
  },
  devBannerMono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    color: '#93c5fd',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  title: { fontSize: 20, fontWeight: '700' },
  urlBadge: { fontSize: 12, color: '#059669', marginTop: 2 },
  urlMissing: { fontSize: 12, color: '#dc2626', marginTop: 2 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e5e5e5',
    paddingBottom: 4,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabLabel: { fontSize: 12, fontWeight: '600', color: '#888' },
  tabLabelActive: { color: '#2563eb' },
  tabIndicator: {
    width: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#2563eb',
    marginTop: 4,
  },
  settingsWrap: { padding: 16, paddingBottom: 40 },
  settingsTitle: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', marginBottom: 12, color: '#111' },
  input: {
    backgroundColor: '#f9f9f9',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
  },
  saveBtn: {
    backgroundColor: '#2563eb',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginTop: 12,
    minWidth: 140,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '600' },
  hint: { fontSize: 13, color: '#777', lineHeight: 20 },
});
