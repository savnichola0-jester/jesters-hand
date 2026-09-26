export function vaultReadingEntryId(vaultEntryId: string): string {
  return `vault-reading-${vaultEntryId}`;
}

/** A page report starts reading only when it is the next sequential page. */
export function isSequentialPageAdvance(previousPage: number | null, page: number): boolean {
  return previousPage !== null
    && Number.isFinite(page)
    && page === Math.floor(previousPage) + 1;
}

export interface VaultReadingSessionProgress {
  entryId: string | null;
  savedPage: number;
}

/** Ignore save completions belonging to a reader session that has been replaced. */
export function markVaultReadingPageSaved(
  currentSession: VaultReadingSessionProgress | null,
  completingSession: VaultReadingSessionProgress,
  entryId: string,
  page: number,
): boolean {
  if (currentSession !== completingSession || completingSession.entryId !== entryId) return false;
  completingSession.savedPage = Math.max(completingSession.savedPage, page);
  return true;
}

export function vaultReadingPercentage(page: number, numPages: number): number {
  if (!Number.isFinite(page) || !Number.isFinite(numPages) || page <= 0 || numPages <= 0) return 0;
  return Math.max(1, Math.min(100, Math.ceil((Math.min(page, numPages) / numPages) * 100)));
}

/** Local calendar day rendered as an ISO date, so a midnight reading advances a day. */
export function vaultReadingIsoDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function nextVaultReadingStreak(lastReadDay: string | undefined, streak: number, today: string): number {
  if (lastReadDay === today) return Math.max(1, streak);
  if (!lastReadDay) return 1;
  const previous = new Date(`${lastReadDay}T00:00:00Z`);
  const current = new Date(`${today}T00:00:00Z`);
  const dayDifference = Math.round((current.getTime() - previous.getTime()) / 86400000);
  return dayDifference === 1 ? Math.max(1, streak) + 1 : 1;
}