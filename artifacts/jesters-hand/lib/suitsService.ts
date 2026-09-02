import { auth } from './firebase';

export const SUITS = [
  { key: 'spade', pip: '♠', name: 'Loyalty' },
  { key: 'diamond', pip: '♦', name: 'Investment' },
  { key: 'heart', pip: '♥', name: 'Community' },
  { key: 'club', pip: '♣', name: 'Discovery' },
] as const;
export type SuitKey = typeof SUITS[number]['key'];
export interface SuitState {
  pips: SuitKey[];
  streaks: Partial<Record<SuitKey, number>>;
  notes: Partial<Record<SuitKey, string>>;
  inPlay: Partial<Record<SuitKey, SuitTask>>;
  completed: Partial<Record<SuitKey, string>>;
}
export interface SuitTask {
  active: boolean;
  title: string;
  instruction?: string;
  destination?: 'table'|'jesters-deal'|'uniform'|'recruit'|'target-ticket'|'chamber'|'social'|'discovery';
  social?: string;
  milestoneNotes?: Partial<Record<'3' | '6' | '9', string>>;
}
export interface SuitHolder {
  uid: string;
  jokerId: string;
  pips: SuitKey[];
  streaks?: Partial<Record<SuitKey, number>>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  const token = await auth.currentUser?.getIdToken();
  if (!domain || !token) throw new Error('SUITS is unavailable until you are signed in.');
  const response = await fetch(`https://${domain}/api/suits${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => null) as T & { error?: string };
  if (!response.ok) throw new Error(data?.error ?? 'SUITS request failed');
  return data;
}
export const getMySuits = () => request<{ state: SuitState }>('/me');
export const findSuitHolder = (jokerId: string) => request<{ holder: SuitHolder | null }>(`/lookup/${encodeURIComponent(jokerId)}`);
export const getSuitAdmin = () => request<{ holders: SuitHolder[]; inPlay: Partial<Record<SuitKey, SuitTask>> }>('/admin');
export const setSuitAssignment = (targetUid: string, pip: SuitKey, assigned: boolean) =>
  request<void>('/assignment', { method: 'POST', body: JSON.stringify({ targetUid, pip, assigned }) });
export const setSuitInPlay = (pip: SuitKey, task: SuitTask) =>
  request<void>('/in-play', { method: 'POST', body: JSON.stringify({ pip, task }) });
export const stampSuitCompletion = (targetUid: string, pip: SuitKey) =>
  request<void>('/stamp', { method: 'POST', body: JSON.stringify({ targetUid, pip }) });