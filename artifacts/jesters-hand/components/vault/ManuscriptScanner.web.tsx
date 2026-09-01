import React, { forwardRef, useImperativeHandle } from 'react';
import {
  detectManuscriptChapters,
  type ManuscriptScanResult,
} from '@/lib/manuscriptChapters';

export interface ManuscriptScannerHandle {
  scan: (uri: string, sizeBytes?: number) => Promise<ManuscriptScanResult | null>;
}

const ManuscriptScanner = forwardRef<ManuscriptScannerHandle>(function ManuscriptScanner(_, ref) {
  useImperativeHandle(ref, () => ({ scan: detectManuscriptChapters }), []);
  return null;
});

export default ManuscriptScanner;