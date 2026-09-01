export type VaultReaderEndState = 'reading' | 'chapterEnd' | 'bookEnd';

/**
 * Resolve the reader's bottom-bar state. A document's final page always keeps
 * the existing whole-book review prompt, even when it is also a chapter end.
 */
export function resolveVaultReaderEndState(
  livePage: number | null,
  numPages: number | null,
  chapterEndPage: number | null,
): VaultReaderEndState {
  if (livePage && numPages && numPages > 1 && livePage >= numPages) {
    return 'bookEnd';
  }
  if (livePage && chapterEndPage && Number.isFinite(chapterEndPage) && livePage >= chapterEndPage) {
    return 'chapterEnd';
  }
  return 'reading';
}