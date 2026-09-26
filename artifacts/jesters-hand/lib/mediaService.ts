import { auth } from './firebase';
import { getApiDomain } from './apiConfig';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';

function mediaApiOrigin(): string {
  // Expo web's preview host is separate from the shared API proxy. Use the
  // configured API domain on both native and web, not window.location.origin.
  // Downloaded updates do not inherit build-profile environment variables.
  const domain = getApiDomain();
  if (!domain) throw new Error('API address is unavailable in this app release.');
  return `https://${domain}`;
}

export function mediaApiUrl(path: string): string {
  return `${mediaApiOrigin()}/api/media/${path}`;
}

/** Resolve portable App Storage photo pointers while leaving legacy URLs intact. */
export function resolveMediaUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith('jhmedia://')) return value;

  const [logicalPath, query = ''] = value.slice('jhmedia://'.length).split('?', 2);
  const token = new URLSearchParams(query).get('token');
  if (!logicalPath || !token) return undefined;
  return `${mediaApiUrl(`public/${encodeURIComponent(decodeURIComponent(logicalPath))}`)}?token=${encodeURIComponent(token)}`;
}

async function requireIdToken(): Promise<string> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  return user.getIdToken();
}

/** Upload a local Expo file to Replit App Storage and return its portable pointer. */
export async function uploadMedia(
  localUri: string,
  logicalPath: string,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<{ path: string; url: string | null }> {
  const token = await requireIdToken();
  onProgress?.(0);
  // Native fetch(file://...) may fail on Android image-picker cache URIs.
  // Expo's File is an uploadable request body and avoids that intermediate read.
  const body = Platform.OS === 'web'
    ? await (async () => {
      const localResponse = await fetch(localUri);
      if (!localResponse.ok) throw new Error(`Could not read selected media (${localResponse.status}).`);
      return localResponse.blob();
    })()
    : new File(localUri);
  const response = await (Platform.OS === 'web' ? fetch : expoFetch)(mediaApiUrl(`upload?path=${encodeURIComponent(logicalPath)}`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Media upload failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const result = await response.json() as { path?: string; url?: string | null };
  const responsePath = result.path;
  const responseUrl = result.url;
  if (
    typeof responsePath !== 'string' ||
    responsePath !== logicalPath ||
    (responseUrl !== null && typeof responseUrl !== 'string')
  ) {
    throw new Error('Media upload returned an invalid response.');
  }
  onProgress?.(1);
  return { path: responsePath, url: responseUrl };
}

/** Delete one known new App Storage object; never use for legacy Firebase URLs. */
export async function deleteMediaObject(path: string): Promise<void> {
  const token = await requireIdToken();
  const response = await fetch(mediaApiUrl(`object?path=${encodeURIComponent(path)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Media delete failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
}

/** True only for a portable pointer that resolves to the requested object. */
export function isReplitMediaUrl(value: string | null | undefined, expectedPath: string): boolean {
  if (!value?.startsWith('jhmedia://')) return false;
  const rawPath = value.slice('jhmedia://'.length).split('?', 1)[0];
  try {
    return decodeURIComponent(rawPath) === expectedPath;
  } catch {
    return false;
  }
}

/** Extract a new App Storage pointer without exposing its read token. */
export function replitMediaPath(value?: string | null): string | null {
  if (!value?.startsWith('jhmedia://')) return null;
  try {
    return decodeURIComponent(value.slice('jhmedia://'.length).split('?', 1)[0]);
  } catch {
    return null;
  }
}