import {
  isSequentialPageAdvance,
  markVaultReadingPageSaved,
  nextVaultReadingStreak,
  vaultReadingEntryId,
  vaultReadingPercentage,
} from './vaultReadingProgressLogic';

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// Small, dependency-free checks for the service's deterministic ID, reader
// advancement qualification, percentage cap, and per-day streak transitions.
expectEqual(vaultReadingEntryId('book-123'), 'vault-reading-book-123', 'deterministic ID');
expectEqual(isSequentialPageAdvance(null, 1), false, 'initial page is not advancement');
expectEqual(isSequentialPageAdvance(1, 9), false, 'TOC jump is not sequential');
expectEqual(isSequentialPageAdvance(9, 10), true, 'next page is advancement');
const firstBookSession = { entryId: 'book-a', savedPage: 0 };
const secondBookSession = { entryId: 'book-b', savedPage: 0 };
expectEqual(
  markVaultReadingPageSaved(secondBookSession, firstBookSession, 'book-a', 8),
  false,
  'stale first-book completion rejected',
);
expectEqual(secondBookSession.savedPage, 0, 'stale completion cannot advance second-book cursor');
expectEqual(
  markVaultReadingPageSaved(secondBookSession, secondBookSession, 'book-b', 3),
  true,
  'current-book completion accepted',
);
expectEqual(secondBookSession.savedPage, 3, 'current-book save cursor advanced');
expectEqual(vaultReadingPercentage(4, 10), 40, 'percentage');
expectEqual(vaultReadingPercentage(12, 10), 100, 'percentage cap');
expectEqual(nextVaultReadingStreak(undefined, 0, '2025-05-01'), 1, 'first day');
expectEqual(nextVaultReadingStreak('2025-05-01', 4, '2025-05-01'), 4, 'same-day dedupe');
expectEqual(nextVaultReadingStreak('2025-05-01', 4, '2025-05-02'), 5, 'consecutive day');
expectEqual(nextVaultReadingStreak('2025-05-01', 4, '2025-05-03'), 1, 'streak reset');