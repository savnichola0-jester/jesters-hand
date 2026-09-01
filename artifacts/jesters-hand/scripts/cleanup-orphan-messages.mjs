// One-off ADMIN cleanup: delete message docs whose parent conversation doc no
// longer exists (chats deleted before message cleanup existed).
//
// Why an admin script instead of a client-side collectionGroup sweep:
// Firestore security rules for queries must be provable WITHOUT reading each
// candidate document. A collection-group read allowance gated on
// `!exists(parent)` depends on a per-document path, so the rules engine can
// never prove it for a query — the collectionGroup('messages') query would be
// rejected no matter how the allowance is written. (Per-document deletes of
// parentless messages ARE already allowed by rules; only enumeration is the
// problem.) So we enumerate with owner credentials, which bypass rules.
//
// Enumeration strategy: list /conversations with `showMissing=true`, which
// surfaces "missing" parent docs — deleted documents that still have live
// subcollections. For each missing parent, list and delete its messages.
//
// Auth: exchanges the FIREBASE_TOKEN CLI refresh token for an OAuth access
// token using the public firebase-tools OAuth client (these credentials are
// embedded in the open-source CLI and are not secrets).
//
// Usage:
//   FIREBASE_TOKEN=... node scripts/cleanup-orphan-messages.mjs [--dry-run]
//
// Project id comes from EXPO_PUBLIC_FIREBASE_PROJECT_ID (or FIREBASE_PROJECT_ID).

const PROJECT_ID =
  process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID;
const REFRESH_TOKEN = process.env.FIREBASE_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

if (!PROJECT_ID) { console.error('Missing EXPO_PUBLIC_FIREBASE_PROJECT_ID'); process.exit(1); }
if (!REFRESH_TOKEN) { console.error('Missing FIREBASE_TOKEN'); process.exit(1); }

// Public OAuth client of the firebase-tools CLI (not a secret).
const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const API = 'https://firestore.googleapis.com/v1/';
const BASE = `${API}projects/${PROJECT_ID}/databases/(default)/documents`;
let HEADERS;

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  HEADERS = {
    Authorization: `Bearer ${await getAccessToken()}`,
    'Content-Type': 'application/json',
  };

  // 1. List all conversation doc entries, including MISSING parents (deleted
  //    docs whose subcollections still hold data).
  const missingParents = [];
  let total = 0;
  let pageToken = '';
  do {
    const r = await getJson(
      `${BASE}/conversations?showMissing=true&pageSize=300&mask.fieldPaths=__name__` +
      (pageToken ? `&pageToken=${pageToken}` : ''),
    );
    for (const d of r.documents ?? []) {
      total++;
      // A "missing" doc has a name but no createTime/updateTime/fields.
      if (!d.createTime) missingParents.push(d.name);
    }
    pageToken = r.nextPageToken ?? '';
  } while (pageToken);
  console.log(`Conversation entries scanned: ${total}; missing parents: ${missingParents.length}`);

  // 2. Enumerate leftover messages under each missing parent.
  const orphans = [];
  for (const parent of missingParents) {
    let pt = '';
    do {
      const r = await getJson(
        `${API}${parent.replace(/^projects\//, 'projects/')}/messages?pageSize=1000&mask.fieldPaths=__name__` +
        (pt ? `&pageToken=${pt}` : ''),
      );
      for (const d of r.documents ?? []) orphans.push(d.name);
      pt = r.nextPageToken ?? '';
    } while (pt);
  }
  console.log(`Orphaned messages (parent conversation gone): ${orphans.length}`);
  for (const n of orphans) console.log('  ' + n.split('/documents/')[1]);

  if (DRY_RUN) { console.log('Dry run — nothing deleted.'); return; }

  // 3. Delete orphans in commits of ≤500 writes.
  for (let i = 0; i < orphans.length; i += 500) {
    const writes = orphans.slice(i, i + 500).map(name => ({ delete: name }));
    const res = await fetch(`${BASE.replace(/\/documents$/, '/documents')}:commit`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ writes }),
    });
    if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    console.log(`Deleted ${Math.min(i + 500, orphans.length)}/${orphans.length}`);
  }
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
