/**
 * The phone app for VSCode Portal.
 *
 * First run: scan the QR code VS Code shows (or paste its link). The pairing key in it goes into the
 * iOS Keychain / Android Keystore. After that the app opens straight into the phone UI from
 * extension/web, bundled inside the app (src/webBundle.ts), which reaches the computer through the
 * end-to-end encrypted relay named in the link.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Share } from 'react-native';
import {
  ActivityIndicator, Alert, Linking, PermissionsAndroid, Platform, Pressable, Settings, StatusBar, StyleSheet, Text, TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Camera, CameraType } from 'react-native-camera-kit';
import * as Keychain from 'react-native-keychain';
import Clipboard from '@react-native-clipboard/clipboard';
import { trigger as haptic } from 'react-native-haptic-feedback';
import { activateKeepAwake, deactivateKeepAwake } from '@sayem314/react-native-keep-awake';
import WEB_HTML from './src/webBundle';

type Pairing = { relay: string; key: string; room: string };

const KEYCHAIN_SERVICE = 'com.nabeelmumtaz.vscodeportal.pairing';
const BG = '#1e1e1e';

// "https://relay.example.com/#pair=KEY.ROOM" → { relay, key, room }
// Also accepts the app's own link, codeportal://pair?link=<that link, URL-encoded>
export function parsePairingLink(text: string): Pairing | null {
  const own = String(text).trim().match(/^codeportal:\/\/pair\?link=(.+)$/);
  if (own) { try { return parsePairingLink(decodeURIComponent(own[1])); } catch { return null; } }
  const m = String(text).trim().match(/^(https?:\/\/[^/#?\s]+)\/?#pair=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{16,64})$/);
  return m ? { relay: m[1], key: m[2], room: m[3] } : null;
}

async function loadPairing(): Promise<Pairing | null> {
  const saved = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
  if (!saved) return null;
  try { return JSON.parse(saved.password); } catch { return null; }
}
const savePairing = (p: Pairing) =>
  Keychain.setGenericPassword('pairing', JSON.stringify(p), {
    service: KEYCHAIN_SERVICE, accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
const forgetPairing = () => Keychain.resetGenericPassword({ service: KEYCHAIN_SERVICE });

function App() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  // A pairing that arrives while the saved one is still loading wins
  useEffect(() => {
    loadPairing().then((p) => setPairing((now) => (now === undefined ? p : now))).catch(() => setPairing((now) => now ?? null));
  }, []);

  const paired = useCallback((p: Pairing) => {
    setPairing(p);
    savePairing(p).catch((e) => console.warn(`Couldn't save the pairing: ${e}`));
  }, []);
  // A codeportal://pair link (from a browser, a message, or a QR code) pairs this phone
  useEffect(() => {
    const open = (url?: string | null) => { const p = url && parsePairingLink(url); if (p) paired(p); };
    Linking.getInitialURL().then(open);
    // Testing on the iOS Simulator: xcrun simctl launch <device> <bundle id> -pairLink '<link>'
    if (Platform.OS === 'ios') { console.log('pairLink launch argument:', Settings.get('pairLink') ? 'present' : 'none'); open(Settings.get('pairLink')); }
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, [paired]);
  const unpair = useCallback(async () => { await forgetPairing(); setPairing(null); }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      {pairing === undefined ? <View style={styles.fill}><ActivityIndicator color="#888" style={styles.fill} /></View>
        : pairing ? <Portal pairing={pairing} onUnpair={unpair} />
          : <Welcome onPaired={paired} />}
    </SafeAreaProvider>
  );
}

// ---------- Pairing ----------

function Welcome({ onPaired }: { onPaired: (p: Pairing) => void }) {
  const [scanning, setScanning] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState('');

  const startScan = async () => {
    if (Platform.OS === 'android') {
      const ok = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
      if (ok !== PermissionsAndroid.RESULTS.GRANTED) {
        return Alert.alert('Camera needed', 'Allow the camera to scan the QR code, or paste the link instead.');
      }
    }
    setScanning(true);
  };
  const usePasted = () => {
    const p = parsePairingLink(link);
    if (!p) return Alert.alert('That isn\'t a pairing link', 'Copy the "From anywhere" link in VS Code: click Portal in the status bar, then Copy link.');
    onPaired(p);
  };

  if (scanning) return <Scanner onCode={onPaired} onCancel={() => setScanning(false)} />;
  return (
    <SafeAreaView style={[styles.fill, styles.welcome]}>
      <View style={styles.logo}><Text style={styles.logoText}>{'</>'}</Text></View>
      <Text style={styles.title}>Connect to your computer</Text>
      <Text style={styles.body}>
        On your computer, open VS Code with the VSCode Portal extension and click <Text style={styles.bold}>Portal</Text> in
        the status bar. Then scan the QR code under <Text style={styles.bold}>From anywhere</Text>.
      </Text>
      <Pressable style={styles.primary} onPress={startScan}><Text style={styles.primaryText}>Scan QR code</Text></Pressable>
      {pasting ? (
        <View style={styles.pasteBox}>
          <TextInput style={styles.input} value={link} onChangeText={setLink} placeholder="https://…/#pair=…" placeholderTextColor="#666"
            autoCapitalize="none" autoCorrect={false} onSubmitEditing={usePasted} />
          <Pressable style={styles.secondary} onPress={usePasted}><Text style={styles.secondaryText}>Connect</Text></Pressable>
        </View>
      ) : (
        <Pressable onPress={() => setPasting(true)}><Text style={styles.link}>Paste a link instead</Text></Pressable>
      )}
      <Text style={styles.small}>The QR code holds a key only your phone and computer know. Everything between them is encrypted with it.</Text>
    </SafeAreaView>
  );
}

function Scanner({ onCode, onCancel }: { onCode: (p: Pairing) => void; onCancel: () => void }) {
  const done = useRef(false);
  const [hint, setHint] = useState('Point the camera at the QR code in VS Code');
  return (
    <View style={styles.fill}>
      <Camera style={styles.fill} cameraType={CameraType.Back} scanBarcode showFrame laserColor="#3b9cff" frameColor="#ffffff"
        onReadCode={(e) => {
          if (done.current) return;
          const p = parsePairingLink(e.nativeEvent.codeStringValue);
          if (p) { done.current = true; onCode(p); } else setHint('That QR code isn\'t from VSCode Portal');
        }} />
      <SafeAreaView style={styles.scanOverlay} pointerEvents="box-none">
        <Text style={styles.scanHint}>{hint}</Text>
        <Pressable style={styles.secondary} onPress={onCancel}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
      </SafeAreaView>
    </View>
  );
}

// ---------- The phone UI ----------

function Portal({ pairing, onUnpair }: { pairing: Pairing; onUnpair: () => void }) {
  // Before the page's scripts run: hand it the pairing, and tell it it's inside the app
  const injected = useMemo(() => `
    try { localStorage.setItem('vsp.pair', ${JSON.stringify(`${pairing.key}.${pairing.room}`)}); } catch (e) {}
    window.PORTAL_APP = { platform: ${JSON.stringify(Platform.OS)}, view: ${JSON.stringify((Platform.OS === 'ios' && Settings.get('view')) || null)}, host: ${JSON.stringify((Platform.OS === 'ios' && Settings.get('host')) || null)} };
    true;`, [pairing]);

  const web = useRef<React.ComponentRef<typeof WebView>>(null);
  // Answers a request from the page (see askApp in app.js)
  const reply = useCallback((id: number, value: unknown) => {
    web.current?.injectJavaScript(`window.PortalNative && window.PortalNative.reply(${JSON.stringify(id)}, ${JSON.stringify(value)}); true;`);
  }, []);
  // Back in the app after being away: reconnect right away instead of waiting for the retry timer
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') web.current?.injectJavaScript('window.PortalNative && window.PortalNative.resume(); true;');
    });
    return () => { sub.remove(); deactivateKeepAwake(); };
  }, []);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let m: { type?: string; url?: string; id?: any; text?: string; style?: string; on?: boolean; image?: string; title?: string };
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.type === 'haptic') {
      haptic(m.style === 'medium' ? 'impactMedium' : m.style === 'heavy' ? 'impactHeavy' : 'impactLight', { enableVibrateFallback: false });
    } else if (m.type === 'clipboard.set' && typeof m.text === 'string') {
      Clipboard.setString(m.text);
    } else if (m.type === 'clipboard.get' && typeof m.id === 'number') {
      const id = m.id;
      Clipboard.getString().then((t) => reply(id, t)).catch(() => reply(id, ''));
    } else if (m.type === 'awake') {
      // Keep the screen on while connected, like a video call
      if (m.on) activateKeepAwake(); else deactivateKeepAwake();
    } else if (m.type === 'share') {
      Share.share(m.image ? { url: m.image, title: m.title } : { message: m.text || '', title: m.title }).catch(() => {});
    } else if (m.type === 'host' && typeof m.id === 'string' && Platform.OS === 'ios') {
      Settings.set({ portalHost: m.id }); // Siri and Shortcuts use the same window (PortalIntents.swift)
    } else if (m.type === 'unpair') {
      Alert.alert('Unpair this phone?', 'You\'ll need to scan the QR code in VS Code again.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Unpair', style: 'destructive', onPress: onUnpair },
      ]);
    } else if (m.type === 'pairing-invalid') {
      Alert.alert('Pairing no longer valid', 'The computer was unpaired. Scan the QR code in VS Code again.', [{ text: 'OK', onPress: onUnpair }]);
    } else if (m.type === 'open' && m.url && /^https?:\/\//.test(m.url)) {
      Linking.openURL(m.url);
    }
  }, [onUnpair, reply]);

  return (
    <SafeAreaView style={styles.fill} edges={Platform.OS === 'android' ? ['top', 'bottom'] : []}>
      <WebView
        ref={web}
        style={styles.fill}
        // The relay's address is the page's origin, so the phone UI reaches it exactly as it does in a browser
        source={{ html: WEB_HTML, baseUrl: `${pairing.relay}/` }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={injected}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        // The Screen tab opens the keyboard by itself when a text field on the computer is focused
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        bounces={false}
        overScrollMode="never"
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        setSupportMultipleWindows={false}
        textInteractionEnabled
        allowsBackForwardNavigationGestures={false}
        webviewDebuggingEnabled={__DEV__}
        // Links stay in the app; anything else opens in the browser
        onShouldStartLoadWithRequest={(req) => {
          if (req.url.startsWith('about:') || req.url.startsWith(pairing.relay)) return true;
          Linking.openURL(req.url);
          return false;
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: BG },
  welcome: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 16 },
  logo: { width: 84, height: 84, borderRadius: 20, backgroundColor: '#1b2433', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  logoText: { color: '#5ab4ff', fontSize: 30, fontWeight: '700' },
  title: { color: '#e8eef7', fontSize: 24, fontWeight: '700', textAlign: 'center' },
  body: { color: '#a9b6c7', fontSize: 16, lineHeight: 23, textAlign: 'center' },
  bold: { color: '#e8eef7', fontWeight: '600' },
  primary: { backgroundColor: '#3b9cff', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 28, alignSelf: 'stretch', alignItems: 'center', marginTop: 8 },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  secondary: { backgroundColor: '#333', borderRadius: 999, paddingVertical: 10, paddingHorizontal: 20 },
  secondaryText: { color: '#e8eef7', fontSize: 15, fontWeight: '500' },
  link: { color: '#5ab4ff', fontSize: 15 },
  pasteBox: { alignSelf: 'stretch', gap: 10, alignItems: 'center' },
  input: { alignSelf: 'stretch', color: '#e8eef7', backgroundColor: '#2d2d2d', borderRadius: 10, borderWidth: 1, borderColor: '#333', paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  small: { color: '#6b7685', fontSize: 12.5, textAlign: 'center', lineHeight: 18, marginTop: 12 },
  scanOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 14, paddingBottom: 28 },
  scanHint: { color: '#fff', fontSize: 15, backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, overflow: 'hidden' },
});

export default App;
