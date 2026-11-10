import { useCallback, useEffect, useState } from 'react';
import { DossierCategory, type Dossier } from '@workspace/api-client-react';
import { auth } from './firebase';
import { uploadMedia } from './mediaService';
import { fetchProtectedImage } from './vaultService';
import { EMPTY_SPREAD, type SpreadState, type TicketDraft } from './targetTicketService';

export const DOSSIER_CATEGORIES = Object.values(DossierCategory);

export function blankDossierDraft(): TicketDraft {
  return {
    title: '', target: '', suit: 'spade', evidence: [{ text: '', source: '' }],
    connections: '', contradictions: '', confidence: 0, fieldDots: {},
    spread: { ...EMPTY_SPREAD, elements: [], connectors: [] },
  };
}

export function parseDossierDraft(dossier: Dossier): TicketDraft {
  const parsed: unknown = JSON.parse(dossier.document);
  if (!parsed || typeof parsed !== 'object' || !('spread' in parsed) || !('evidence' in parsed)) {
    throw new Error('This dossier could not be read. Your saved data has not been changed.');
  }
  return { ...blankDossierDraft(), ...(parsed as TicketDraft), title: dossier.title };
}

export async function uploadDossierPhoto(uid: string, localUri: string): Promise<string> {
  if (auth.currentUser?.uid !== uid) throw new Error('Sign in again before adding evidence.');
  const path = `dossiers/${uid}/${Date.now()}_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}.jpg`;
  const result = await uploadMedia(localUri, path, 'image/jpeg');
  if (result.url !== null) throw new Error('The server did not store this photo privately. Update the server before adding evidence.');
  return `dossier://${path}`;
}

type PrivateImage = { uri: string; release: () => void };

/** Resolve only private dossier objects; never turn these into public URL tokens. */
export function useDossierPhotos(spread: SpreadState, enabled: boolean) {
  const [resolved, setResolved] = useState<{ uid: string; images: Record<string, string>; error: string | null }>({
    uid: '', images: {}, error: null,
  });
  const uid = enabled ? auth.currentUser?.uid ?? '' : '';
  const pointers = JSON.stringify([...new Set(spread.elements.map(e => e.uri).filter((uri): uri is string => !!uri))].sort());
  useEffect(() => {
    let cancelled = false;
    const owned: PrivateImage[] = [];
    setResolved({ uid, images: {}, error: null });
    if (!uid) return;
    const load = async () => {
      const images: Record<string, string> = {};
      const errors: string[] = [];
      await Promise.all((JSON.parse(pointers) as string[]).map(async pointer => {
        try {
          const prefix = `dossier://dossiers/${uid}/`;
          if (!pointer.startsWith(prefix) || !/^[0-9]{10,16}_[a-z0-9]{6,20}\.jpg$/.test(pointer.slice(prefix.length))) {
            throw new Error('An evidence photo has an invalid private address.');
          }
          const file = await fetchProtectedImage(pointer.slice('dossier://'.length), 'image/jpeg', 'replit');
          if (cancelled) { file.release(); return; }
          owned.push(file);
          images[pointer] = file.uri;
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'Could not load private evidence photos.');
        }
      }));
      if (!cancelled) setResolved({ uid, images, error: errors[0] ?? null });
    };
    void load();
    return () => { cancelled = true; owned.forEach(file => file.release()); };
  }, [uid, pointers]);
  const resolvePhoto = useCallback((pointer: string) =>
    enabled && uid && resolved.uid === uid ? resolved.images[pointer] : undefined,
  [enabled, uid, resolved]);
  return { resolvePhoto, error: enabled && resolved.uid === uid ? resolved.error : null };
}
