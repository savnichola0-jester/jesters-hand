import { auth } from '@/lib/firebase';
import { getApiDomain } from '@/lib/apiConfig';

export type GameMode = 'trivia' | 'cards' | 'recruit';
export type ContentBank = 'trivia' | 'prompts' | 'responses';
export type GameMember = { uid: string; jokerId: string };
export type GameSnapshot = {
  id: string; code: string; mode: GameMode; hostUid: string; members: GameMember[];
  status: 'lobby' | 'playing' | 'finished'; phase: string; createdAt: string; updatedAt: string;
  scores: Record<string, number>; category?: string | null; round?: number;
  judgeUid?: string | null; question?: { id: string; category: string; question: string; options: string[] };
  questionNumber?: number; questionCount?: number; answered?: number; answerCount?: number;
  myAnswered?: boolean; correctIndex?: number; sourceHint?: string; prompt?: string | null;
  submissionCount?: number; expectedSubmissions?: number; submissions?: Array<{ id: string; text: string }>;
  mySubmitted?: boolean; winner?: { jokerId: string; text: string };
  votedCount?: number; voteCount?: number; myVoted?: boolean; revealedRoles?: Record<string, string>;
  recruitVotes?: Record<string, Record<string, string>>;
};
export type PrivateGameState = {
  role: string | null;
  hand: Array<{ id: string; text: string }>;
  mySubmission: string | null;
  myVotes: Record<string, string> | null;
};
export type ReviewEntry = { id: string; text?: string; question?: string; category?: string; options?: string[]; correctIndex?: number; sourceHint?: string; valid: boolean; contentHash: string; status: 'draft' | 'approved' | 'removed' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const domain = getApiDomain();
  const token = await auth.currentUser?.getIdToken();
  if (!domain || !token) throw new Error('Sign in to play Jester’s Hand games.');
  const response = await fetch(`https://${domain}/api/games${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(data?.error ?? `Games are unavailable (${response.status}).`);
  if (!data) throw new Error('Games returned an empty response.');
  return data;
}
const post = (path: string, body?: unknown) => request<{ room: GameSnapshot }>(path, {
  method: 'POST', body: JSON.stringify(body ?? {}),
});
export const createGameRoom = (mode: GameMode, category?: string) => post('/rooms', { mode, ...(category ? { category } : {}) });
export const joinGameRoom = (code: string) => post('/join', { code });
export const getMyGameRooms = () => request<{ rooms: GameSnapshot[] }>('/rooms');
export const getTriviaCategories = () => request<{ categories: string[] }>('/categories');
export const getGameRoom = (roomId: string) => request<{ room: GameSnapshot }>(`/rooms/${encodeURIComponent(roomId)}`);
export const getPrivateGameState = (roomId: string) => request<PrivateGameState>(`/rooms/${encodeURIComponent(roomId)}/private`);
export const startGame = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/start`);
export const leaveGame = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/leave`);
export const transferGameHost = (roomId: string, targetUid: string) =>
  post(`/rooms/${encodeURIComponent(roomId)}/host`, { targetUid });
export const claimGameHost = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/claim-host`);
export const endGame = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/end`);
export const answerTrivia = (roomId: string, optionIndex: number) => post(`/rooms/${encodeURIComponent(roomId)}/answer`, { optionIndex });
export const advanceGame = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/next`);
export const submitResponse = (roomId: string, cardId: string) => post(`/rooms/${encodeURIComponent(roomId)}/submit`, { cardId });
export const judgeResponse = (roomId: string, submissionId: string) => post(`/rooms/${encodeURIComponent(roomId)}/judge`, { submissionId });
export const openRecruitVoting = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/voting`);
export const voteRecruitRoles = (roomId: string, guesses: Record<string, string>) => post(`/rooms/${encodeURIComponent(roomId)}/vote`, { guesses });
export const dealRecruitAgain = (roomId: string) => post(`/rooms/${encodeURIComponent(roomId)}/redeal`);
export const getGameReview = (bank: ContentBank) =>
  request<{ bank: ContentBank; entries: ReviewEntry[] }>(`/review?bank=${bank}`);
export const setGameReview = (bank: ContentBank, id: string, contentHash: string, status: 'approved' | 'removed' | 'draft') =>
  request<{ ok: true; status: string }>(`/review/${bank}/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify({ contentHash, status }),
  });