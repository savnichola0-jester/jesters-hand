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
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
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

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  return {
    mapValue: {
      fields: Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => [key, encodeValue(entry)]),
      ),
    },
  };
}

function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields ?? {})
        .map(([key, entry]) => [key, decodeValue(entry)]),
    );
  }
  return undefined;
}

function encodeFields(value: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)]),
  );
}

function decodeFields(value: Record<string, FirestoreValue> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, entry]) => [key, decodeValue(entry)]),
  );
}

async function fetchWithDeadline(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw new Error('The server did not answer. Check your connection and try again.');
    }
    throw new Error('The server could not be reached. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }
}

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
  const user = auth.currentUser;
  const projectId = db.app.options.projectId;
  if (!user || !projectId) throw new Error('Your session is not ready. Reopen the app and try again.');

  const token = await user.getIdToken();
  const documentName = `projects/${projectId}/databases/(default)/documents/contract/current`;
  const documentUrl = `https://firestore.googleapis.com/v1/${documentName}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const existingResponse = await fetchWithDeadline(documentUrl, { headers });
  const exists = existingResponse.ok;
  if (!exists && existingResponse.status !== 404) {
    throw new Error('The current contract could not be checked. Try again.');
  }
  const existing = exists
    ? await existingResponse.json() as {
        fields?: Record<string, FirestoreValue>;
        updateTime?: string;
      }
    : null;
  const current = existing ? parse(decodeFields(existing.fields)) : BUNDLED_CONTRACT;
  if (current.version !== currentVersion) throw new Error('contract changed');
  const version = currentVersion + 1;
  const commitResponse = await fetchWithDeadline(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        writes: [{
          update: {
            name: documentName,
            fields: encodeFields({
              version,
              heading: next.heading,
              sections: next.sections,
              acknowledgement: next.acknowledgement,
              previous: {
                version: current.version,
                heading: current.heading,
                sections: current.sections,
                acknowledgement: current.acknowledgement,
              },
            }),
          },
          updateTransforms: [{
            fieldPath: 'updatedAt',
            setToServerValue: 'REQUEST_TIME',
          }],
          currentDocument: existing?.updateTime
            ? { updateTime: existing.updateTime }
            : { exists: false },
        }],
      }),
    },
  );
  if (!commitResponse.ok) {
    if (commitResponse.status === 403) {
      throw new Error('This account is not permitted to amend the contract.');
    }
    if (commitResponse.status === 409 || commitResponse.status === 412) {
      throw new Error('contract changed');
    }
    throw new Error('The amendment could not be saved. Try again.');
  }
  return version;
}
