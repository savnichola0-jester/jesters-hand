export const MAX_NATIVE_MANUSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;

export class ManuscriptScanTooLargeError extends Error {
  readonly code = 'manuscript-scan-too-large';

  constructor(readonly sizeBytes: number) {
    const maxMb = Math.floor(MAX_NATIVE_MANUSCRIPT_SCAN_BYTES / (1024 * 1024));
    const actualMb = Math.max(1, Math.ceil(sizeBytes / (1024 * 1024)));
    super(`This PDF is ${actualMb} MB. On iPhone and Android, manuscript PDFs must be ${maxMb} MB or smaller for automatic chapter scanning. Compress it or upload it from the web app.`);
    this.name = 'ManuscriptScanTooLargeError';
  }
}

export function assertNativeManuscriptScanSize(sizeBytes: number | null | undefined): void {
  if (typeof sizeBytes === 'number' && sizeBytes > MAX_NATIVE_MANUSCRIPT_SCAN_BYTES) {
    throw new ManuscriptScanTooLargeError(sizeBytes);
  }
}

export function isManuscriptScanTooLargeError(error: unknown): error is ManuscriptScanTooLargeError {
  return error instanceof ManuscriptScanTooLargeError
    || (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === 'manuscript-scan-too-large'
    );
}