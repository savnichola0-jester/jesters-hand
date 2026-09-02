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
  /** Wording immediately before the latest amendment, retained for re-signers. */
  previous?: Omit<ContractDoc, 'previous'>;
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
  const parsed: ContractDoc = {
    version:         typeof d.version === 'number' ? d.version : CONTRACT_VERSION,
    heading:         typeof d.heading === 'string' && d.heading ? d.heading : CONTRACT_HEADING,
    sections: raw.map((s: any) => ({
      title: String(s?.title ?? ''),
      lines: Array.isArray(s?.lines) ? s.lines.map(String) : [],
    })),
    acknowledgement: typeof d.acknowledgement === 'string' && d.acknowledgement
      ? d.acknowledgement : CONTRACT_ACKNOWLEDGEMENT,
  };
  const old = d.previous;
  if (old && typeof old === 'object') {
    const p = old as Record<string, unknown>;
    if (typeof p.version === 'number' && typeof p.heading === 'string' && Array.isArray(p.sections)) {
      parsed.previous = {
        version: p.version,
        heading: p.heading,
        sections: p.sections.map((s: any) => ({
          title: String(s?.title ?? ''),
          lines: Array.isArray(s?.lines) ? s.lines.map(String) : [],
        })),
        acknowledgement: typeof p.acknowledgement === 'string' ? p.acknowledgement : '',
      };
    }
  }
  return parsed;
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
  const existing = await getDoc(REF());
  const current = existing.exists() ? parse(existing.data()) : BUNDLED_CONTRACT;
  if (current.version !== currentVersion) throw new Error('contract changed');
  const version = currentVersion + 1;
  await setDoc(REF(), {
    version,
    heading:         next.heading,
    sections:        next.sections,
    acknowledgement: next.acknowledgement,
    previous: {
      version: current.version,
      heading: current.heading,
      sections: current.sections,
      acknowledgement: current.acknowledgement,
    },
    updatedAt:       serverTimestamp(),
  });
  return version;
}
