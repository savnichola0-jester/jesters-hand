/**
 * Shared chat-media upload for Whisper conversations and Jester's Table.
 * Images (including GIFs) go to chatMedia/{uid}/{timestamp}.{ext} in Storage;
 * the resulting download URL is stored on the message document.
 */
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { storage } from '@/lib/firebase';

const MAX_BYTES = 10 * 1024 * 1024; // must match storage.rules cap

/** Upload a picked image/GIF and return its download URL. */
export async function uploadChatImage(
  uid: string,
  localUri: string,
  mimeType?: string,
): Promise<string> {
  const resp = await fetch(localUri);
  const blob = await resp.blob();
  const contentType = mimeType || blob.type || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    throw new Error('Only images and GIFs can be attached.');
  }
  if (blob.size > MAX_BYTES) {
    throw new Error('That image is too large — keep it under 10 MB.');
  }
  const ext = contentType === 'image/gif' ? 'gif'
    : contentType === 'image/png' ? 'png'
    : contentType === 'image/webp' ? 'webp'
    : 'jpg';
  const path = `chatMedia/${uid}/${Date.now()}.${ext}`;
  const task = uploadBytesResumable(ref(storage, path), blob, { contentType });
  await new Promise<void>((resolve, reject) => {
    task.on('state_changed', undefined, reject, () => resolve());
  });
  return getDownloadURL(task.snapshot.ref);
}

/** Decode the chatMedia object path buried in a Firebase download URL, or null. */
export function chatMediaPathFromUrl(imageUrl: string): string | null {
  const m = /\/o\/(chatMedia(?:%2F|\/)[^"?\\]+)/.exec(imageUrl);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

/**
 * Best-effort removal of a chat attachment's storage object once its message
 * is gone. Never throws — the message delete already succeeded, and an
 * already-missing file is fine.
 */
export async function deleteChatImage(imageUrl: string): Promise<void> {
  const path = chatMediaPathFromUrl(imageUrl);
  if (!path) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    console.error('[chatMediaService] failed to delete chat image:', e);
  }
}
