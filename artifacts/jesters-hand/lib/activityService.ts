// Privacy-safe seat activity API. This module never accepts content, recipient,
// conversation, or document identifiers; the server also rejects those fields.
import { auth } from './firebase';
import { getApiDomain } from './apiConfig';

export type SeatTemperature = 'Cold' | 'Lukewarm' | 'Warm' | 'Hot';
export type ActivityCategory = 'login' | 'conversation' | 'participation' | 'deal_suits';
export type AppIconId =
  | 'ticket' | 'hand' | 'street_art' | 'jesters_deal' | 'suits' | 'ante'
  | 'table' | 'target_ticket' | 'recruit' | 'vault' | 'chamber' | 'system'
  | 'uniform' | 'jesters_hand' | 'pocket';
export interface IconActivitySummary {
  score: number;
  temperature: SeatTemperature;
  count: number;
  lastActivityAt: string | null;
}
export interface SeatActivitySummary {
  score: number | null;
  temperature: SeatTemperature;
  lastActivityAt: string | null;
  categoryCounts: Record<ActivityCategory, number>;
  categoryTimestamps: Partial<Record<ActivityCategory, string>>;
  iconSummaries: Record<AppIconId, IconActivitySummary> | null;
}

async function request(path: string, init?: RequestInit): Promise<Response | null> {
  const domain = getApiDomain();
  const token = await auth.currentUser?.getIdToken();
  if (!domain || !token) return null;
  return fetch(`https://${domain}/api${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

/** Available only for the caller, except exact active 00-00 may request a uid. */
export async function fetchSeatActivitySummary(uid?: string): Promise<SeatActivitySummary | null> {
  const response = await request(`/activity/summary/${encodeURIComponent(uid ?? auth.currentUser?.uid ?? '')}`);
  if (!response || !response.ok) return null;
  return await response.json() as SeatActivitySummary;
}