/**
 * Agreement service — the signed contract of The Hand.
 *
 * Schema: agreements/{uid}
 *   uid            : string   (owner — matches doc id)
 *   jokerId        : string   (typed by the member)
 *   name           : string   (typed by the member)
 *   signedDate     : string   (date as the member typed it)
 *   signaturePaths : string[] (SVG path data of the finger-drawn signature)
 *   sigWidth       : number   (signature pad size, for faithful re-rendering)
 *   sigHeight      : number
 *   version        : number   (contract wording version signed)
 *   signedAt       : Timestamp (server time)
 *
 * Rules allow exactly two writes: the first signing, and a re-sign that
 * bumps to a NEWER contract version (after the Jester amends the rules).
 * A signed contract can never be edited in place or deleted from the app.
 *
 * The Jester reviews signings (including the drawn signature) on The
 * Contract screen — signings are living records, not deleted content, so
 * they deliberately do NOT go into the archives.
 */
import {
  collection, doc, getDoc, getDocFromServer, getDocs, onSnapshot, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

export interface Agreement {
  uid:            string;
  jokerId:        string;
  name:           string;
  signedDate:     string;
  signaturePaths: string[];
  sigWidth:       number;
  sigHeight:      number;
  version:        number;
  signedAt:       Timestamp | null;
}

/** Fetch a member's signed agreement, or null if they haven't signed. */
export async function getAgreement(uid: string): Promise<Agreement | null> {
  const snap = await getDoc(doc(db, 'agreements', uid));
  if (!snap.exists()) return null;
  const d = snap.data();
  return {
    uid:            d.uid            ?? uid,
    jokerId:        d.jokerId        ?? '',
    name:           d.name           ?? '',
    signedDate:     d.signedDate     ?? '',
    signaturePaths: d.signaturePaths ?? [],
    sigWidth:       d.sigWidth       ?? 0,
    sigHeight:      d.sigHeight      ?? 0,
    version:        d.version        ?? 1,
    signedAt:       d.signedAt       ?? null,
  };
}

/** List every member's signed agreement (admin only per rules). */
export async function listAgreements(): Promise<Agreement[]> {
  const snap = await getDocs(collection(db, 'agreements'));
  const out: Agreement[] = [];
  snap.forEach(docSnap => {
    const d = docSnap.data();
    out.push({
      uid:            d.uid            ?? docSnap.id,
      jokerId:        d.jokerId        ?? '',
      name:           d.name           ?? '',
      signedDate:     d.signedDate     ?? '',
      signaturePaths: d.signaturePaths ?? [],
      sigWidth:       d.sigWidth       ?? 0,
      sigHeight:      d.sigHeight      ?? 0,
      version:        d.version        ?? 1,
      signedAt:       d.signedAt       ?? null,
    });
  });
  // Newest signings first; blank jokerIds sink to the end.
  out.sort((a, b) => (b.signedAt?.toMillis?.() ?? 0) - (a.signedAt?.toMillis?.() ?? 0));
  return out;
}

/** Live version of listAgreements — keeps the Jester's ledger current. */
export function listenAgreements(
  onList: (agreements: Agreement[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  return onSnapshot(collection(db, 'agreements'), snap => {
    const out: Agreement[] = [];
    snap.forEach(docSnap => {
      const d = docSnap.data();
      out.push({
        uid:            d.uid            ?? docSnap.id,
        jokerId:        d.jokerId        ?? '',
        name:           d.name           ?? '',
        signedDate:     d.signedDate     ?? '',
        signaturePaths: d.signaturePaths ?? [],
        sigWidth:       d.sigWidth       ?? 0,
        sigHeight:      d.sigHeight      ?? 0,
        version:        d.version        ?? 1,
        signedAt:       d.signedAt       ?? null,
      });
    });
    out.sort((a, b) => (b.signedAt?.toMillis?.() ?? 0) - (a.signedAt?.toMillis?.() ?? 0));
    onList(out);
  }, e => onError?.(e));
}

/**
 * File the signed contract (first signing or a re-sign at a newer contract
 * version). Rules reject anything else.
 */
export async function signAgreement(
  uid: string,
  data: {
    jokerId: string;
    name: string;
    signedDate: string;
    signaturePaths: string[];
    sigWidth: number;
    sigHeight: number;
  },
  version: number,
): Promise<number> {
  // Read the authoritative version at filing time. A member can spend several
  // minutes reviewing and signing; the screen listener may be stale by then.
  const contractSnap = await getDocFromServer(doc(db, 'contract', 'current'));
  const liveVersion = contractSnap.exists()
    ? Number(contractSnap.data().version ?? version)
    : version;
  if (!Number.isInteger(liveVersion) || liveVersion < 1) {
    throw new Error('The current contract version is invalid.');
  }

  const agreementRef = doc(db, 'agreements', uid);
  const archiveRef = doc(collection(db, 'archives'));
  const batch = writeBatch(db);
  batch.set(agreementRef, {
    uid,
    ...data,
    version: liveVersion,
    signedAt: serverTimestamp(),
  });
  batch.set(archiveRef, {
    type: 'contract_signed',
    section: 'The Contract',
    title: `${data.jokerId} signed the contract (v${liveVersion})`,
    ownerUid: uid,
    ownerJokerId: data.jokerId,
    restorePath: `agreements/${uid}`,
    payload: { name: data.name, version: liveVersion },
    comments: [],
    storagePaths: [],
    createdAtOriginal: null,
    deletedAt: serverTimestamp(),
    deletedByUid: uid,
  });
  await batch.commit();
  return liveVersion;
}
