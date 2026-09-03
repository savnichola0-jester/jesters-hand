import {
  Timestamp,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { getApiDomain } from './apiConfig';
import { broadcastToActiveMembers, writeNotification } from './notificationService';

export type DealDuration = '24h' | '48h' | 'until_next';
export type DealStatus = 'draft' | 'published' | 'archived';
export type DealTaskType =
  | 'mark'
  | 'black_book'
  | 'target_whisper'
  | 'vault_mark'
  | 'ticket' | 'the_hand' | 'street_art' | 'jesters_deal' | 'suits' | 'ante'
  | 'jesters_table' | 'target_ticket' | 'vault' | 'chamber' | 'recruit' | 'uniform'
  | 'system' | 'website' | 'facebook' | 'instagram' | 'x' | 'tiktok' | 'twitch' | 'suno';

export interface DealTask {
  id: string;
  type: DealTaskType;
  label: string;
  targetCount: number;
  assigneeUid: string;
}

export interface Deal {
  id: string;
  title: string;
  tasks: DealTask[];
  duration: DealDuration;
  status: DealStatus;
  previousDealId: string | null;
  createdBy: string;
  createdAt: Timestamp | null;
  publishedAt: Timestamp | null;
  expiresAt: Timestamp | null;
}

export interface DealInput {
  title: string;
  tasks: Array<Partial<DealTask> & Pick<DealTask, 'type' | 'label'>>;
  duration: DealDuration;
}

export interface DealActivity {
  id: string;
  uid: string;
  type: DealTaskType;
  sourceId: string;
  occurredAt: Timestamp | null;
}

export interface DealCompletion {
  uid: string;
  taskCounts: Record<string, number>;
  completedTaskIds: string[];
  completedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export interface DealMemberStats {
  uid: string;
  currentStreak: number;
  bestStreak: number;
  lastCompletedDealId: string | null;
  lastCompletedAt: Timestamp | null;
  lastActivityAt: Timestamp | null;
}

export interface DealAward {
  id: string;
  uid: string;
  milestone: 3 | 6 | 9 | 12 | 15;
  message: string;
  dealId?: string;
  awardedBy: string;
  awardedAt: Timestamp | null;
}

const TASK_TYPES: DealTaskType[] = [
  'mark', 'black_book', 'target_whisper', 'vault_mark',
  'ticket', 'the_hand', 'street_art', 'jesters_deal', 'suits', 'ante', 'jesters_table',
  'target_ticket', 'vault', 'chamber', 'recruit', 'uniform', 'system', 'website',
  'facebook', 'instagram', 'x', 'tiktok', 'twitch', 'suno',
];
export const DEAL_MILESTONES = [3, 6, 9, 12, 15] as const;

function cleanTasks(tasks: DealInput['tasks']): DealTask[] {
  return tasks.slice(0, 20).map((task, index) => {
    if (!TASK_TYPES.includes(task.type)) throw new Error('Invalid Deal task type');
    const label = task.label.trim().slice(0, 200);
    if (!label) throw new Error('Every Deal task needs a label');
    const fallbackId = `${task.type}-${index + 1}`;
    const id = (task.id?.trim() || fallbackId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
    const assigneeUid = task.assigneeUid?.trim().slice(0, 128);
    if (!assigneeUid) throw new Error('Every Deal task needs an assigned Joker ID');
    return {
      id,
      type: task.type,
      label,
      targetCount: Math.max(1, Math.min(100, Math.floor(task.targetCount ?? 1))),
      assigneeUid,
    };
  });
}

function mapDeal(id: string, data: Record<string, any>): Deal {
  return {
    id,
    title: data.title ?? '',
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    duration: data.duration,
    status: data.status,
    previousDealId: data.previousDealId ?? null,
    createdBy: data.createdBy,
    createdAt: data.createdAt ?? null,
    publishedAt: data.publishedAt ?? null,
    expiresAt: data.expiresAt ?? null,
  };
}

/** Admin-only (enforced by rules). */
export async function createDeal(createdBy: string, input: DealInput): Promise<string> {
  const ref = doc(collection(db, 'deals'));
  await setDoc(ref, {
    title: input.title.trim().slice(0, 200),
    tasks: cleanTasks(input.tasks),
    duration: input.duration,
    status: 'draft',
    previousDealId: null,
    createdBy,
    createdAt: serverTimestamp(),
    publishedAt: null,
    expiresAt: null,
  });
  return ref.id;
}

/**
 * Publishes one Deal and archives every previously published Deal in one batch.
 * There is intentionally no expiry for until_next: it remains active until the
 * next successful publish archives it.
 */
export async function publishDeal(dealId: string): Promise<void> {
  const published = await getDocs(query(collection(db, 'deals'), where('status', '==', 'published')));
  const target = await getDoc(doc(db, 'deals', dealId));
  if (!target.exists()) throw new Error('Deal not found');
  if (target.data().status !== 'draft') throw new Error('Only a draft Deal can be published');
  const duration = target.data().duration as DealDuration;
  const now = Timestamp.now();
  const previousDealId = published.docs
    .map(d => mapDeal(d.id, d.data()))
    .filter(d => d.id !== dealId)
    .sort((a, b) => (b.publishedAt?.toMillis() ?? 0) - (a.publishedAt?.toMillis() ?? 0))[0]?.id ?? null;
  const expiresAt = duration === 'until_next'
    ? null
    : Timestamp.fromMillis(now.toMillis() + (duration === '24h' ? 24 : 48) * 60 * 60 * 1000);
  const batch = writeBatch(db);
  published.docs.forEach(snap => {
    if (snap.id !== dealId) batch.update(snap.ref, { status: 'archived' });
  });
  batch.update(target.ref, {
    status: 'published',
    previousDealId,
    publishedAt: serverTimestamp(),
    expiresAt,
  });
  await batch.commit();
  const actorUid = auth.currentUser?.uid;
  if (actorUid) {
    void broadcastToActiveMembers(actorUid, {
      type: 'announcement',
      title: 'The Jester dealt.',
      fromUid: actorUid,
      text: 'posted a Deal.',
    }).catch(() => {});
  }
}

/** Archive is the only Deal removal operation; Deal documents are never deleted. */
export async function archiveDeal(dealId: string): Promise<void> {
  const ref = doc(db, 'deals', dealId);
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Deal not found');
    tx.update(ref, { status: 'archived' });
  });
}

/** Admin listener for every Deal. */
export function listenDeals(
  cb: (deals: Deal[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    query(collection(db, 'deals'), orderBy('createdAt', 'desc')),
    snap => cb(snap.docs.map(d => mapDeal(d.id, d.data()))),
    error => onError?.(error),
  );
}

/** Member-safe listener: the query itself only asks for rule-readable Deals. */
export function listenPublishedDeals(
  cb: (deals: Deal[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    query(collection(db, 'deals'), where('status', '==', 'published')),
    snap => cb(snap.docs.map(d => mapDeal(d.id, d.data()))),
    error => onError?.(error),
  );
}

/** Best-effort by contract: activity failure never changes the real action. */
export async function recordDealActivity(
  type: DealTaskType,
  uid: string,
  sourceId: string,
): Promise<void> {
  if (!uid || !sourceId || !TASK_TYPES.includes(type)) return;
  try {
    const domain = getApiDomain();
    const idToken = await auth.currentUser?.getIdToken();
    if (!domain || !idToken || auth.currentUser?.uid !== uid) return;
    await fetch(`https://${domain}/api/deal/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ type, sourceId: sourceId.slice(0, 500) }),
    });
  } catch {
    // Deliberately non-fatal; the primary action has already committed.
  }
}

/**
 * Rebuilds progress from immutable activity rather than incrementing counters.
 * Re-running is idempotent and repairs stale local progress.
 */
export async function reconcileDealProgress(uid: string): Promise<DealCompletion | null> {
  const domain = getApiDomain();
  const idToken = await auth.currentUser?.getIdToken();
  // The server derives the UID from this token. Keep uid only as a caller-side
  // guard so a stale action from a signed-out account cannot be reconciled.
  if (!domain || !idToken || auth.currentUser?.uid !== uid) {
    throw new Error('Deal reconciliation is unavailable');
  }
  const response = await fetch(`https://${domain}/api/deal/reconcile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({}),
  });
  const payload = await response.json().catch(() => null) as {
    error?: string;
    completion?: {
      uid: string;
      taskCounts: Record<string, number>;
      completedTaskIds: string[];
      completedAt: string | null;
      updatedAt: string | null;
    } | null;
  } | null;
  if (!response.ok) throw new Error(payload?.error ?? 'Deal reconciliation failed');
  const completion = payload?.completion;
  if (!completion || completion.uid !== uid || !Array.isArray(completion.completedTaskIds)
    || !completion.taskCounts || typeof completion.taskCounts !== 'object') return null;
  const toTimestamp = (value: string | null): Timestamp | null =>
    value && !Number.isNaN(Date.parse(value)) ? Timestamp.fromDate(new Date(value)) : null;
  return {
    uid: completion.uid,
    taskCounts: completion.taskCounts,
    completedTaskIds: completion.completedTaskIds,
    completedAt: toTimestamp(completion.completedAt),
    updatedAt: toTimestamp(completion.updatedAt),
  };
}

export type SeatTemperature = 'Hot' | 'Warm' | 'Cold';

/** Pure, clock-sensitive classification; callers can recalculate on any render/timer. */
export function seatTemperature(
  lastActivityAt: Timestamp | Date | null | undefined,
  progress: number,
  now = Date.now(),
): SeatTemperature {
  const at = lastActivityAt instanceof Date
    ? lastActivityAt.getTime()
    : lastActivityAt?.toMillis?.() ?? 0;
  if (!at) return 'Cold';
  const ageHours = Math.max(0, now - at) / 3_600_000;
  const ratio = Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
  if (ageHours <= 24 && ratio >= 0.75) return 'Hot';
  if (ageHours <= 72 && ratio >= 0.4) return 'Warm';
  if (ageHours <= 168 || ratio >= 0.75) return 'Warm';
  return 'Cold';
}

export function listenOwnCompletion(
  dealId: string,
  uid: string,
  cb: (completion: DealCompletion | null) => void,
): () => void {
  return onSnapshot(doc(db, 'dealCompletions', dealId, 'members', uid), snap => {
    cb(snap.exists() ? snap.data() as DealCompletion : null);
  });
}

export function listenOwnStats(
  uid: string,
  cb: (stats: DealMemberStats | null) => void,
): () => void {
  return onSnapshot(doc(db, 'dealMemberStats', uid), snap => {
    cb(snap.exists() ? snap.data() as DealMemberStats : null);
  });
}

/** Admin-only listeners (rules enforce the collection-wide reads). */
export function listenAllDealStats(cb: (stats: DealMemberStats[]) => void): () => void {
  return onSnapshot(collection(db, 'dealMemberStats'), snap => {
    cb(snap.docs.map(d => d.data() as DealMemberStats));
  });
}

export function listenAllDealCompletions(
  cb: (items: Array<DealCompletion & { dealId: string }>) => void,
): () => void {
  const childStops = new Map<string, () => void>();
  const byDeal = new Map<string, Array<DealCompletion & { dealId: string }>>();
  const emit = () => cb(Array.from(byDeal.values()).flat());
  const stopDeals = onSnapshot(collection(db, 'deals'), dealsSnap => {
    const ids = new Set(dealsSnap.docs.map(d => d.id));
    childStops.forEach((stop, id) => {
      if (!ids.has(id)) {
        stop();
        childStops.delete(id);
        byDeal.delete(id);
      }
    });
    dealsSnap.docs.forEach(dealSnap => {
      if (childStops.has(dealSnap.id)) return;
      const stop = onSnapshot(
        collection(db, 'dealCompletions', dealSnap.id, 'members'),
        snap => {
          byDeal.set(dealSnap.id, snap.docs.map(d => ({
            ...(d.data() as DealCompletion),
            dealId: dealSnap.id,
          })));
          emit();
        },
      );
      childStops.set(dealSnap.id, stop);
    });
    emit();
  });
  return () => {
    stopDeals();
    childStops.forEach(stop => stop());
    childStops.clear();
  };
}

export async function awardDealMilestone(
  uid: string,
  milestone: DealAward['milestone'],
  message: string,
  awardedBy: string,
  dealId?: string,
): Promise<string> {
  if (!(DEAL_MILESTONES as readonly number[]).includes(milestone)) {
    throw new Error('Invalid Deal milestone');
  }
  const trimmed = message.trim().slice(0, 280);
  if (!trimmed) throw new Error('A Jester message is required');
  const awardId = `streak-${milestone}`;
  await setDoc(doc(db, 'dealAwards', uid, 'items', awardId), {
    uid,
    milestone,
    message: trimmed,
    ...(dealId ? { dealId } : {}),
    awardedBy,
    awardedAt: serverTimestamp(),
  });
  if ((milestone === 3 || milestone === 6 || milestone === 9) && uid !== awardedBy) {
    void writeNotification(uid, {
      type: 'announcement',
      title: "Don't sit cold.",
      fromUid: awardedBy,
      text: trimmed,
    }).catch(() => {});
  }
  return awardId;
}

export function listenOwnDealAwards(
  uid: string,
  cb: (awards: DealAward[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  return onSnapshot(
    query(collection(db, 'dealAwards', uid, 'items'), orderBy('awardedAt', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() } as DealAward))),
    error => onError?.(error),
  );
}