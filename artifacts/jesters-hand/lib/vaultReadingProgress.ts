import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

const MODE_PREFIX = 'vault-read:v1:';
import {
  nextVaultReadingStreak,
  vaultReadingEntryId,
  vaultReadingIsoDay,
  vaultReadingPercentage,
} from './vaultReadingProgressLogic';

export {
  isSequentialPageAdvance,
  markVaultReadingPageSaved,
} from './vaultReadingProgressLogic';

function parseStreak(mode: unknown): number {
  if (typeof mode !== 'string' || !mode.startsWith(MODE_PREFIX)) return 0;
  const streak = Number(mode.slice(MODE_PREFIX.length));
  return Number.isInteger(streak) && streak > 0 ? streak : 0;
}

/**
 * Record progress in a member-owned, deterministic Black Book turn entry.
 * Callers must qualify a session (30 seconds of foreground reading) before
 * invoking this function. Only fields permitted by the current rules are
 * written; existing notes and all unrelated entries remain untouched.
 */
export async function recordVaultReadingProgress(input: {
  vaultEntryId: string;
  title: string;
  page: number;
  numPages: number;
  now?: Date;
}): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const today = vaultReadingIsoDay(input.now ?? new Date());
  const percentage = vaultReadingPercentage(input.page, input.numPages);
  const entryRef = doc(db, 'blackBook', uid, 'entries', vaultReadingEntryId(input.vaultEntryId));

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(entryRef);
    if (!snapshot.exists()) {
      transaction.set(entryRef, {
        tab: 'turn',
        title: input.title.trim().slice(0, 200) || 'Vault reading',
        date: today,
        mode: `${MODE_PREFIX}1`,
        progress: percentage,
        notes: 'Automatically tracked Vault reading · 1-day streak',
        createdBy: uid,
        reactions: {},
        commentCount: 0,
        createdAt: serverTimestamp(),
      });
      return;
    }

    const existing = snapshot.data();
    // Never commandeer a manually created turn entry that happens to share the
    // deterministic ID. Our own entries carry a namespaced mode marker.
    if (existing.tab !== 'turn' || existing.createdBy !== uid || !parseStreak(existing.mode)) return;

    const previousDay = typeof existing.date === 'string' ? existing.date : undefined;
    const streak = parseStreak(existing.mode);
    const nextStreak = nextVaultReadingStreak(previousDay, streak, today);
    const fields: Record<string, unknown> = {
      progress: Math.max(
        typeof existing.progress === 'number' ? existing.progress : 0,
        percentage,
      ),
    };
    if (previousDay !== today) {
      fields.date = today;
      fields.mode = `${MODE_PREFIX}${nextStreak}`;
      fields.notes = `Automatically tracked Vault reading · ${nextStreak}-day streak`;
    }
    transaction.update(entryRef, fields);
  });
}