/**
 * One-time setup script — creates all 55 Jester's Hand Firebase accounts.
 *
 * Users:
 *   00-00  → admin
 *   01-54 through 54-54 → members
 *
 * Temp password: Jester2025!
 *
 * Run: node scripts/create-firebase-users.mjs
 */

const API_KEY    = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const PROJECT_ID = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const TEMP_PASS  = 'Jester2025!';

const AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createUser(jokerId, isAdmin = false) {
  const email = `${jokerId}@jestershand.local`;

  // ── 1. Create Firebase Auth account ──────────────────────────────────
  const authRes = await fetch(AUTH_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password: TEMP_PASS, returnSecureToken: true }),
  });
  const authData = await authRes.json();

  if (authData.error) {
    const code = authData.error.message;
    if (code === 'EMAIL_EXISTS') {
      console.log(`⏭  ${jokerId} — already exists, skipping`);
      return;
    }
    console.error(`✗  ${jokerId} — auth error: ${code}`);
    return;
  }

  const uid     = authData.localId;
  const idToken = authData.idToken;

  // ── 2. Create Firestore user document ────────────────────────────────
  const fsUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
  const fsRes = await fetch(fsUrl, {
    method:  'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fields: {
        jokerId:  { stringValue: jokerId },
        isAdmin:  { booleanValue: isAdmin },
        created:  { integerValue: Date.now() },
      },
    }),
  });

  if (!fsRes.ok) {
    const err = await fsRes.text();
    console.error(`✗  ${jokerId} — firestore error: ${err}`);
    return;
  }

  console.log(`✓  ${jokerId}  (uid: ${uid})`);
}

async function main() {
  if (!API_KEY || !PROJECT_ID) {
    console.error('Missing env vars. Set EXPO_PUBLIC_FIREBASE_API_KEY and EXPO_PUBLIC_FIREBASE_PROJECT_ID.');
    process.exit(1);
  }

  console.log(`Creating 55 accounts against project: ${PROJECT_ID}`);
  console.log(`Temp password: ${TEMP_PASS}\n`);

  // Admin first
  await createUser('00-00', true);
  await sleep(200);

  // 54 members
  for (let i = 1; i <= 54; i++) {
    const id = `${String(i).padStart(2, '0')}-54`;
    await createUser(id, false);
    await sleep(150); // gentle rate-limit spacing
  }

  console.log('\nDone!');
}

main().catch(console.error);
