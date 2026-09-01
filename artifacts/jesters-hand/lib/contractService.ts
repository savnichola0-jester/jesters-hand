/**
 * Contract service — the living wording of The Contract.
 *
 * Schema: contract/current  (single doc)
 *   version   : number    (increments on every amendment)
 *   heading   : string
 *   sections  : Array<{ title: string, lines: string[] }>
 *   acknowledgement : string
 *   updatedAt : Timestamp (server time)
 *
 * Until the Jester amends the contract for the first time, the doc doesn't
 * exist and the bundled wording in contractContent.ts (version 1) is used.
 * Only the admin may write; every write must bump the version by exactly 1.
 */
import { doc, getDoc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import {
  CONTRACT_VERSION, CONTRACT_HEADING, CONTRACT_SECTIONS, CONTRACT_ACKNOWLEDGEMENT,
} from './contractContent';

export interface ContractSection { title: string; lines: string[] }
export interface ContractDoc {
  version:         number;
  heading:         string;
  sections:        ContractSection[];
  acknowledgement: string;
}

export const BUNDLED_CONTRACT: ContractDoc = {
  version:         CONTRACT_VERSION,
  heading:         CONTRACT_HEADING,
  sections:        CONTRACT_SECTIONS,
  acknowledgement: CONTRACT_ACKNOWLEDGEMENT,
};

const REF = () => doc(db, 'contract', 'current');

function parse(d: Record<string, unknown> | undefined): ContractDoc {
  if (!d) return BUNDLED_CONTRACT;
  const raw = Array.isArray(d.sections) ? d.sections : [];
  return {
    version:         typeof d.version === 'number' ? d.version : CONTRACT_VERSION,
    heading:         typeof d.heading === 'string' && d.heading ? d.heading : CONTRACT_HEADING,
    sections: raw.map((s: any) => ({
      title: String(s?.title ?? ''),
      lines: Array.isArray(s?.lines) ? s.lines.map(String) : [],
    })),
    acknowledgement: typeof d.acknowledgement === 'string' && d.acknowledgement
      ? d.acknowledgement : CONTRACT_ACKNOWLEDGEMENT,
  };
}

/** Fetch the current contract wording (bundled v1 if never amended). */
export async function getContract(): Promise<ContractDoc> {
  try {
    const snap = await getDoc(REF());
    return snap.exists() ? parse(snap.data()) : BUNDLED_CONTRACT;
  } catch {
    return BUNDLED_CONTRACT;
  }
}

/**
 * Listen to the contract version so the re-sign gate reacts live when the
 * Jester amends the rules. Errors fall back to the bundled version (fail
 * open — never traps members on a gate over a read hiccup).
 */
export function listenContract(cb: (c: ContractDoc) => void): () => void {
  return onSnapshot(
    REF(),
    snap => cb(snap.exists() ? parse(snap.data()) : BUNDLED_CONTRACT),
    ()   => cb(BUNDLED_CONTRACT),
  );
}

/** Admin only: publish an amended contract. Bumps the version by 1. */
export async function publishContract(
  next: Omit<ContractDoc, 'version'>,
  currentVersion: number,
): Promise<number> {
  const version = currentVersion + 1;
  await setDoc(REF(), {
    version,
    heading:         next.heading,
    sections:        next.sections,
    acknowledgement: next.acknowledgement,
    updatedAt:       serverTimestamp(),
  });
  return version;
}
