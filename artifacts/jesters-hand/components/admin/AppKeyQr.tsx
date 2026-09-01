// ── App Key QR (ADMIN ONLY) ──────────────────────────────────────────────────
// A downloadable QR code that opens the web app itself. The Jester engraves
// this on the physical "app access" poker-chip card keys. The code always
// encodes the address the app is currently being served from, so once the
// app is published the QR automatically points at the live link.

import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Image } from 'react-native';
import QRCode from 'qrcode';
import { SvgXml } from 'react-native-svg';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const QR_SIZE = 168;

/** The address the app is being served from (web); empty on native. */
function appUrl(): string {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return '';
  // Origin + base path (strips any in-app route so the QR lands on the door).
  return window.location.origin + '/';
}

export default function AppKeyQr() {
  const url = useMemo(appUrl, []);
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

  if (!url) return null;

  const download = () => {
    if (!dataUrl || typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'jesters-hand-app-key.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <View style={st.card}>
      <Text style={st.title}>APP KEY</Text>
      <Text style={st.sub}>
        Scanning this code opens the app at{'\n'}{url}
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
      {Platform.OS === 'web' ? (
        <TouchableOpacity style={st.btn} onPress={download} activeOpacity={0.8}>
          <Text style={st.btnText}>{saved ? 'SAVED' : 'DOWNLOAD QR CODE'}</Text>
        </TouchableOpacity>
      ) : null}
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
