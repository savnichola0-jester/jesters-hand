import { auth } from './firebase';
import { getApiDomain } from './apiConfig';

export interface CheckInMilestone {
  milestoneId: string;
  dateKey: string;
  streak: number;
  earnedAt: string;
  rewardType?: 'royal' | 'merch';
  description?: string;
}

export interface CheckInState {
  dateKey: string;
  issuedToday: boolean;
  checkedInToday: boolean;
  streak: number;
  bestStreak: number;
  total: number;
  history: Array<{ dateKey: string; checkedInAt?: string }>;
  milestones: CheckInMilestone[];
}

export interface CheckInMember {
  uid: string;
  jokerId: string;
  streak: number;
  checkedInToday: boolean;
  issuedToday: boolean;
  pendingMilestones?: Array<{ milestoneId: string; streak: number }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const domain = getApiDomain();
  const token = await auth.currentUser?.getIdToken();
  if (!domain || !token) throw new Error('Sign in to use Check-Ins.');
  const response = await fetch(`https://${domain}/api/check-ins${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(data?.error ?? `Check-Ins is unavailable (${response.status}).`);
  if (!data) throw new Error('Check-Ins returned an empty response.');
  return data;
}

export const getMyCheckIns = () => request<{ state: CheckInState }>('/me');
export const getCheckInMembers = () => request<{ members: CheckInMember[] }>('/admin');
export const getCheckInRoster = () => request<{ members: CheckInMember[] }>('/members');
export const redeemCheckInCode = (code: string) =>
  request<{ state: CheckInState }>('/redeem', { method: 'POST', body: JSON.stringify({ code }) });
export const chooseCheckInReward = (targetUid: string, milestoneId: string, kind: 'royal' | 'merch', description: string) =>
  request<{ ok: true }>('/award', {
    method: 'POST',
    body: JSON.stringify({ targetUid, milestoneId, kind, description }),
  });