/**
 * Shared chat-media upload for Whisper conversations and Jester's Table.
 * Images (including GIFs) go to chatMedia/{uid}/{unique}.{ext} in App Storage;
 * the resulting portable pointer is stored on the message document.
 */
import { ref, deleteObject } from 'firebase/storage';
import { storage } from '@/lib/firebase';
import { deleteMediaObject, replitMediaPath, uploadMedia } from '@/lib/mediaService';

const MAX_BYTES = 10 * 1024 * 1024; // must match the App Storage media API cap

/** Upload a picked image/GIF and return its portable App Storage pointer. */
export async function uploadChatImage(
  uid: string,
  localUri: string,
  mimeType?: string,
): Promise<string> {
  const resp = await fetch(localUri);
  if (!resp.ok) throw new Error(`Could not read selected image (${resp.status}).`);
  const blob = await resp.blob();
  const rawContentType = (mimeType || blob.type || 'image/jpeg').split(';', 1)[0].trim().toLowerCase();
  const contentType = rawContentType === 'image/jpg' ? 'image/jpeg' : rawContentType;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) {
    throw new Error('Only images and GIFs can be attached.');
  }
  if (blob.size > MAX_BYTES) {
    throw new Error('That image is too large — keep it under 10 MB.');
  }
  const ext = contentType === 'image/gif' ? 'gif'
    : contentType === 'image/png' ? 'png'
    : contentType === 'image/webp' ? 'webp'
    : 'jpg';
  const uniqueId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
  const path = `chatMedia/${uid}/${uniqueId}.${ext}`;
  const result = await uploadMedia(localUri, path, contentType);
  if (!result.url?.startsWith('jhmedia://')) {
    throw new Error('Media upload did not return a portable public image URL.');
  }
  return result.url;
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
  const replitPath = replitMediaPath(imageUrl);
  if (replitPath) {
    if (!/^chatMedia\/[^/]+\/[^/]+$/.test(replitPath)) return;
    try {
      await deleteMediaObject(replitPath);
    } catch (e) {
      console.error('[chatMediaService] failed to delete App Storage chat image:', e);
    }
    return;
  }

  const path = chatMediaPathFromUrl(imageUrl);
  if (!path) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (e) {
    console.error('[chatMediaService] failed to delete chat image:', e);
  }
}
