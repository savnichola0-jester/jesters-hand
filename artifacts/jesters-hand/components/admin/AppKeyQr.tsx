// ── App Key QR (ADMIN ONLY) ──────────────────────────────────────────────────
// A downloadable QR code that opens the stable native-install route. The
// Jester engraves this on the physical "app access" poker-chip card keys.
// The stable route may redirect to a newer native build without re-engraving.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Image, Linking } from 'react-native';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const QR_SIZE = 168;
const NATIVE_INSTALL_URL = 'https://jestershand54atcomand.replit.app/install';
const QR_DOWNLOAD_URL = 'https://jestershand54atcomand.replit.app/native-install-qr.png';

export default function AppKeyQr() {
  const url = useMemo(() => NATIVE_INSTALL_URL, []);
  const [svg, setSvg] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    // Crisp black-on-cream code — engravable, high error correction.
    QRCode.toString(url, {
      type: 'svg', errorCorrectionLevel: 'H', margin: 2,
      color: { dark: '#000000', light: '#EDE0C4' },
    }).then(s => { if (alive) setSvg(s); }).catch(() => {});
    if (Platform.OS === 'web') {
      QRCode.toDataURL(url, {
        errorCorrectionLevel: 'H', margin: 2, width: 1024,
        color: { dark: '#000000', light: '#FFFFFF' },
      }).then(d => { if (alive) setDataUrl(d); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [url]);

  const download = async () => {
    if (Platform.OS === 'web' && dataUrl && typeof document !== 'undefined') {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'jesters-hand-native-install-qr.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      await Linking.openURL(QR_DOWNLOAD_URL);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <View style={st.card}>
      <Text style={st.title}>APP KEY</Text>
      <Text style={st.sub}>
        Scanning this code opens the native Android install at{'\n'}{url}
      </Text>
      <View style={st.qrBox}>
        {svg ? (
          Platform.OS === 'web' && dataUrl ? (
            <Image source={{ uri: dataUrl }} style={{ width: QR_SIZE, height: QR_SIZE }} />
          ) : (
            <SvgXml xml={svg} width={QR_SIZE} height={QR_SIZE} />
          )
        ) : null}
      </View>
      <TouchableOpacity style={st.btn} onPress={() => void download()} activeOpacity={0.8}>
        <Text style={st.btnText}>{saved ? 'OPENED' : 'DOWNLOAD QR CODE'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  card: {
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)', borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.35)', padding: 14, marginBottom: 14,
    alignItems: 'center',
  },
  title: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 3,
  },
  sub: {
    color: 'rgba(237,224,196,0.65)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 10, letterSpacing: 0.5, textAlign: 'center', marginTop: 6,
    marginBottom: 10, lineHeight: 15,
  },
  qrBox: {
    backgroundColor: CREAM, padding: 8, borderRadius: 6,
  },
  btn: {
    marginTop: 12, borderWidth: 1, borderColor: GOLD, borderRadius: 6,
    paddingVertical: 8, paddingHorizontal: 22,
  },
  btnText: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2,
  },
});
