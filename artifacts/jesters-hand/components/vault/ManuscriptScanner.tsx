import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ManuscriptScanResult } from '@/lib/manuscriptChapters';
import {
  appendDetectedChapter,
  buildNativeManuscriptScanHtml,
  type NativeManuscriptScanMessage,
} from '@/lib/manuscriptNativeScan';
import { assertNativeManuscriptScanSize } from '@/lib/manuscriptScanLimits';
import type { VaultChapter } from '@/lib/vaultService';

const FileSystem = require('expo-file-system/legacy') as {
  getInfoAsync: (uri: string) => Promise<{ exists: boolean; size?: number }>;
  readAsStringAsync: (uri: string, options: { encoding: 'base64' }) => Promise<string>;
};

const CHUNK_SIZE = 192 * 1024;
const SCANNER_HTML = buildNativeManuscriptScanHtml();

export interface ManuscriptScannerHandle {
  scan: (uri: string, sizeBytes?: number) => Promise<ManuscriptScanResult | null>;
}

interface ScanJob {
  id: number;
}

interface PendingScan {
  id: number;
  chapters: VaultChapter[];
  resolve: (result: ManuscriptScanResult | null) => void;
  reject: (error: Error) => void;
}

/**
 * Native-only hidden scanner. PDF.js runs in a tiny WebView while the shared
 * React Native helper performs chapter-heading detection on each extracted
 * page, so iOS and Android uploads get the same automatic map as web uploads.
 */
const ManuscriptScanner = forwardRef<ManuscriptScannerHandle>(function ManuscriptScanner(_, ref) {
  const webViewRef = useRef<WebView>(null);
  const pendingRef = useRef<PendingScan | null>(null);
  const pdfBase64Ref = useRef<{ id: number; base64: string } | null>(null);
  const nextIdRef = useRef(0);
  const [job, setJob] = useState<ScanJob | null>(null);

  const finish = useCallback((
    id: number,
    result: ManuscriptScanResult | null,
    error?: Error,
  ) => {
    const pending = pendingRef.current;
    if (!pending || pending.id !== id) return;
    pendingRef.current = null;
    if (pdfBase64Ref.current?.id === id) pdfBase64Ref.current = null;
    setJob(current => current?.id === id ? null : current);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }, []);

  useImperativeHandle(ref, () => ({
    scan: async (uri: string, sizeBytes?: number) => {
      const previous = pendingRef.current;
      if (previous) {
        previous.resolve(null);
        pendingRef.current = null;
        pdfBase64Ref.current = null;
      }
      const info = sizeBytes === undefined ? await FileSystem.getInfoAsync(uri) : null;
      assertNativeManuscriptScanSize(sizeBytes ?? info?.size);
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      // Picker metadata is not guaranteed on every Android content provider,
      // so enforce the ceiling again from the encoded payload itself.
      assertNativeManuscriptScanSize(Math.floor((base64.length * 3) / 4));
      const id = ++nextIdRef.current;
      return new Promise<ManuscriptScanResult | null>((resolve, reject) => {
        pendingRef.current = { id, chapters: [], resolve, reject };
        pdfBase64Ref.current = { id, base64 };
        setJob({ id });
      });
    },
  }), []);

  useEffect(() => () => {
    pendingRef.current?.resolve(null);
    pendingRef.current = null;
    pdfBase64Ref.current = null;
  }, []);

  const feedPdf = useCallback(async (scanJob: ScanJob) => {
    const payload = pdfBase64Ref.current;
    if (!payload || payload.id !== scanJob.id) {
      finish(scanJob.id, null, new Error('PDF scan payload expired'));
      return;
    }
    const { base64 } = payload;
    for (let offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
      if (pendingRef.current?.id !== scanJob.id) return;
      const chunk = base64.slice(offset, offset + CHUNK_SIZE);
      webViewRef.current?.injectJavaScript(
        `window.__appendPdfChunk&&window.__appendPdfChunk(${JSON.stringify(chunk)});true;`,
      );
      // Yield between bridge writes so large manuscripts do not monopolize the
      // native UI thread or exceed a single WebView message transaction.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (pendingRef.current?.id === scanJob.id) {
      // The WebView now owns the bounded payload; release the React Native copy
      // before pdf.js allocates its binary buffer.
      pdfBase64Ref.current = null;
      webViewRef.current?.injectJavaScript(
        'window.__beginPdfScan&&window.__beginPdfScan();true;',
      );
    }
  }, [finish]);

  const onMessage = useCallback((scanJob: ScanJob, event: WebViewMessageEvent) => {
    let message: NativeManuscriptScanMessage;
    try {
      message = JSON.parse(event.nativeEvent.data) as NativeManuscriptScanMessage;
    } catch {
      finish(scanJob.id, null, new Error('Invalid response from PDF scanner'));
      return;
    }
    const pending = pendingRef.current;
    if (!pending || pending.id !== scanJob.id) return;
    if (message.type === 'ready') {
      void feedPdf(scanJob);
      return;
    }
    if (message.type === 'page') {
      pending.chapters = appendDetectedChapter(
        pending.chapters,
        message.pageNum,
        message.items,
      );
      webViewRef.current?.injectJavaScript(
        'window.__scanContinue&&window.__scanContinue();true;',
      );
      return;
    }
    if (message.type === 'done') {
      const chapters = message.source === 'outline'
        ? (message.chapters ?? [])
        : pending.chapters;
      finish(scanJob.id, {
        numPages: message.numPages,
        chapters,
        source: message.source === 'outline' ? 'outline' : 'headings',
        confidence: message.source === 'outline' ? 0.98 : chapters.length >= 2 ? 0.86 : 0.45,
      });
      return;
    }
    finish(scanJob.id, null, new Error(message.message));
  }, [feedPdf, finish]);

  if (!job) return null;
  return (
    <View pointerEvents="none" style={styles.hidden}>
      <WebView
        key={job.id}
        ref={webViewRef}
        source={{ html: SCANNER_HTML }}
        javaScriptEnabled
        originWhitelist={['about:blank', 'https://cdnjs.cloudflare.com/*']}
        mixedContentMode="never"
        onShouldStartLoadWithRequest={request => (
          request.url === 'about:blank'
          || request.url.startsWith('data:')
          || request.url.startsWith('https://cdnjs.cloudflare.com/')
        )}
        onMessage={event => onMessage(job, event)}
        onError={() => finish(job.id, null, new Error('Native PDF scanner failed to load'))}
        style={styles.webView}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    left: -2,
    top: -2,
    width: 1,
    height: 1,
    opacity: 0.01,
    overflow: 'hidden',
  },
  webView: { width: 1, height: 1, backgroundColor: 'transparent' },
});

export default ManuscriptScanner;