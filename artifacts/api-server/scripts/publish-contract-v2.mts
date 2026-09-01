// One-off: publish the V2 contract wording to contract/current so every
// member is asked to re-sign. Uses owner OAuth (bypasses rules) but mirrors
// the rules contract exactly: version = prior + 1, same field set.
import { getAccessToken } from '../src/lib/firestoreAdmin';
import {
  CONTRACT_VERSION, CONTRACT_HEADING, CONTRACT_SECTIONS, CONTRACT_ACKNOWLEDGEMENT,
} from '../../jesters-hand/lib/contractContent';

const PROJECT = 'jester-s-hand-3ee1d';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function str(v: string) { return { stringValue: v }; }

async function main() {
  const token = await getAccessToken();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const cur = await fetch(`${BASE}/contract/current`, { headers: h });
  let prior = 1; // bundled v1 in force if the doc has never been created
  if (cur.ok) {
    const d = await cur.json();
    prior = parseInt(d.fields?.version?.integerValue ?? '1', 10);
  } else if (cur.status !== 404) {
    throw new Error(`read failed: ${cur.status} ${await cur.text()}`);
  }
  const next = prior + 1;
  if (CONTRACT_VERSION !== next) {
    console.log(`NOTE: bundled CONTRACT_VERSION=${CONTRACT_VERSION}, publishing as version ${next} (prior ${prior}).`);
  }

  const body = {
    fields: {
      version: { integerValue: String(next) },
      heading: str(CONTRACT_HEADING),
      sections: {
        arrayValue: {
          values: CONTRACT_SECTIONS.map(s => ({
            mapValue: {
              fields: {
                title: str(s.title),
                lines: { arrayValue: { values: s.lines.map(str) } },
              },
            },
          })),
        },
      },
      acknowledgement: str(CONTRACT_ACKNOWLEDGEMENT),
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  };
  const res = await fetch(`${BASE}/contract/current`, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`write failed: ${res.status} ${await res.text()}`);
  console.log(`Published contract version ${next} to contract/current.`);
}

main().catch(e => { console.error(e); process.exit(1); });
