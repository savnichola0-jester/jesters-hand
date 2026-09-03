import { auth } from './firebase';
import { getApiDomain } from './apiConfig';

export const SUITS = [
  { key: 'spade', pip: '♠', name: 'Loyalty' },
  { key: 'diamond', pip: '♦', name: 'Investment' },
  { key: 'heart', pip: '♥', name: 'Community' },
  { key: 'club', pip: '♣', name: 'Discovery' },
] as const;
export type SuitKey = typeof SUITS[number]['key'];
export const SUIT_TASK_ACTIONS = [
  { key: 'ticket', label: 'Your Ticket', route: '/(tabs)/ticket', actionable: true },
  { key: 'hand', label: 'The Hand', route: '/(tabs)/hand', actionable: false },
  { key: 'street-art', label: 'Street Art', route: '/(tabs)/street-art', actionable: true },
  { key: 'jesters-deal', label: "Jester's Deal", route: '/(tabs)/jesters-deal', actionable: true },
  { key: 'suits', label: 'SUITS', route: '/(tabs)/suits', actionable: false },
  { key: 'ante', label: 'Ante', route: '/(tabs)/ante', actionable: true },
  { key: 'table', label: "Jester's Table", route: '/(tabs)/table', actionable: true },
  { key: 'target-ticket', label: 'Target Ticket', route: '/(tabs)/target-ticket', actionable: true },
  { key: 'vault', label: 'Vault', route: '/(tabs)/vault', actionable: true },
  { key: 'chamber', label: 'Chamber', route: '/(tabs)/chamber', actionable: true },
  { key: 'recruit', label: 'Recruit', route: '/(tabs)/recruit', actionable: true },
  { key: 'uniform', label: 'Uniform', route: '/(tabs)/uniform', actionable: true },
  { key: 'jesters-hand', label: "Jester's Hand", route: '/(tabs)/jesters-hand', actionable: false },
  // A System task is specifically the required current-contract re-sign, not
  // changing account settings on the System screen.
  { key: 'system', label: 'System · Contract Re-sign', route: '/contract', actionable: true },
  { key: 'social', label: 'Social · Share', route: undefined, actionable: true },
  { key: 'discovery', label: 'Discovery', route: undefined, actionable: false },
] as const;
export type SuitTaskDestination = typeof SUIT_TASK_ACTIONS[number]['key'];
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
  destination?: SuitTaskDestination;
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
  const domain = getApiDomain();
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