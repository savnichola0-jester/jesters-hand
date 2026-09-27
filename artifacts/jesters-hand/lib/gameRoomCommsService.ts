import {
  addDoc, collection, limit, onSnapshot, orderBy, query, serverTimestamp,
  type Timestamp,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

export type GameRoomMessage = {
  id: string;
  senderUid: string;
  senderJokerId: string;
  text: string;
  sentAt: Timestamp | null;
};

/** Subscribe only to a room's private text; Firestore rules enforce membership. */
export function listenGameRoomMessages(
  roomId: string,
  onMessages: (messages: GameRoomMessage[]) => void,
  onError: (error: Error) => void,
): () => void {
  const messagesQuery = query(
    collection(db, 'gameRoomMessages', roomId, 'messages'),
    orderBy('sentAt', 'asc'),
    limit(100),
  );
  return onSnapshot(messagesQuery, snapshot => {
    onMessages(snapshot.docs.map(item => ({
      id: item.id,
      senderUid: item.data().senderUid ?? '',
      senderJokerId: item.data().senderJokerId ?? '??-??',
      text: item.data().text ?? '',
      sentAt: item.data().sentAt ?? null,
    })));
  }, error => onError(error));
}

/** Write private room text directly to the member-guarded room path. */
export async function sendGameRoomMessage(
  roomId: string,
  senderJokerId: string,
  text: string,
): Promise<void> {
  const uid = auth.currentUser?.uid;
  const trimmed = text.trim();
  if (!uid) throw new Error('Sign in to send a game-room message.');
  if (!trimmed) return;
  if (trimmed.length > 1000) throw new Error('Game-room messages are limited to 1,000 characters.');
  await addDoc(collection(db, 'gameRoomMessages', roomId, 'messages'), {
    senderUid: uid,
    senderJokerId,
    text: trimmed,
    sentAt: serverTimestamp(),
  });
}