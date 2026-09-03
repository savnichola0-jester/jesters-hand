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
 *   wording        : immutable snapshot of the exact wording signed
 *   signedAt       : Timestamp (server time)
 *
 * Rules allow exactly two writes: the first signing, and a re-sign that
 * bumps to a NEWER contract version (after the Jester amends the rules).
 * A signed contract can never be edited in place or deleted from the app.
 *
 * The Jester reviews signings (including the drawn signature) on The
 * Contract screen. Each filing is also copied to the read-only Contracts
 * Archives tab; it is a permanent record, not deleted content.
 */
import {
  collection, doc, getDocFromServer, getDocs, onSnapshot, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  BUNDLED_CONTRACT, ContractDoc, ContractWording, contractWording, parseContract,
} from './contractService';

export interface Agreement {
  uid:            string;
  jokerId:        string;
  name:           string;
  signedDate:     string;
  signaturePaths: string[];
  sigWidth:       number;
  sigHeight:      number;
  version:        number;
  /** Missing only on agreements filed before immutable snapshots existed. */
  wording?:       ContractWording;
  signedAt:       Timestamp | null;
}

/** The wording changed after the member began reviewing/signing it. */
export class ContractChangedError extends Error {
  constructor() {
    super('contract changed');
    this.name = 'ContractChangedError';
  }
}

function parseAgreement(uid: string, d: Record<string, any>): Agreement {
  const rawWording = d.wording;
  const wording = rawWording && typeof rawWording === 'object'
    && typeof rawWording.version === 'number'
    && typeof rawWording.heading === 'string'
    && Array.isArray(rawWording.sections)
    && typeof rawWording.acknowledgement === 'string'
    ? contractWording(parseContract(rawWording))
    : undefined;
  return {
    uid: d.uid ?? uid, jokerId: d.jokerId ?? '', name: d.name ?? '',
    signedDate: d.signedDate ?? '', signaturePaths: d.signaturePaths ?? [],
    sigWidth: d.sigWidth ?? 0, sigHeight: d.sigHeight ?? 0,
    version: d.version ?? 1, wording, signedAt: d.signedAt ?? null,
  };
}

/** Resolve the wording a signer read, including safe legacy fallbacks. */
export function wordingForAgreement(agreement: Agreement, current: ContractDoc): ContractWording | null {
  if (agreement.wording?.version === agreement.version) return agreement.wording;
  if (agreement.version === BUNDLED_CONTRACT.version) return contractWording(BUNDLED_CONTRACT);
  if (current.previous?.version === agreement.version) return current.previous;
  return null;
}

/** Fetch a member's signed agreement, or null if they haven't signed. */
export async function getAgreement(uid: string): Promise<Agreement | null> {
  const snap = await getDocFromServer(doc(db, 'agreements', uid));
  if (!snap.exists()) return null;
  const d = snap.data();
  return parseAgreement(uid, d);
}

/** List every member's signed agreement (admin only per rules). */
export async function listAgreements(): Promise<Agreement[]> {
  const snap = await getDocs(collection(db, 'agreements'));
  const out: Agreement[] = [];
  snap.forEach(docSnap => {
    const d = docSnap.data();
    out.push(parseAgreement(docSnap.id, d));
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
      out.push(parseAgreement(docSnap.id, d));
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
    : BUNDLED_CONTRACT.version;
  if (!Number.isInteger(liveVersion) || liveVersion < 1) {
    throw new Error('The current contract version is invalid.');
  }

  const wording = contractWording(
    contractSnap.exists() ? parseContract(contractSnap.data()) : BUNDLED_CONTRACT,
  );
  if (wording.version !== liveVersion) {
    throw new Error('The current contract wording is invalid.');
  }
  // Never attach a signature to wording the member did not actually review.
  // The caller must refresh the screen and collect a new signature.
  if (liveVersion !== version) {
    throw new ContractChangedError();
  }

  const agreementRef = doc(db, 'agreements', uid);
  const archiveRef = doc(collection(db, 'archives'));
  const batch = writeBatch(db);
  batch.set(agreementRef, {
    uid,
    ...data,
    version: liveVersion,
    wording,
    signedAt: serverTimestamp(),
  });
  batch.set(archiveRef, {
    type: 'contract_signed',
    section: 'The Contract',
    title: `${data.jokerId} signed the contract (v${liveVersion})`,
    ownerUid: uid,
    ownerJokerId: data.jokerId,
    restorePath: `agreements/${uid}`,
    // Contracts are a dedicated, read-only Archives ledger. Keep the complete
    // signed block so authorized viewers can inspect exactly what was filed.
    payload: {
      uid,
      jokerId: data.jokerId,
      name: data.name,
      signedDate: data.signedDate,
      signaturePaths: data.signaturePaths,
      sigWidth: data.sigWidth,
      sigHeight: data.sigHeight,
      version: liveVersion,
      wording,
    },
    comments: [],
    storagePaths: [],
    createdAtOriginal: null,
    deletedAt: serverTimestamp(),
    deletedByUid: uid,
  });
  // Agreement and permanent archive record are one indivisible filing.
  await batch.commit();
  return liveVersion;
}
