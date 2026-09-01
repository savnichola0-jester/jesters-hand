/**
 * One-time script — creates Firestore user docs for all 55 accounts.
 * Auth accounts already exist; this signs in to each one to get the UID + token,
 * then writes users/{uid} with jokerId + isAdmin.
 *
 * Run: node scripts/create-firestore-docs.mjs
 */

const API_KEY    = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const PROJECT_ID = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const TEMP_PASS  = 'Jester2025!';

const SIGNIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stampDoc(jokerId, isAdmin = false) {
  const email = `${jokerId}@jestershand.local`;

  // ── 1. Sign in to get UID + token ────────────────────────────────────
  const signinRes = await fetch(SIGNIN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password: TEMP_PASS, returnSecureToken: true }),
  });
  const signinData = await signinRes.json();

  if (signinData.error) {
    console.error(`✗  ${jokerId} — sign-in error: ${signinData.error.message}`);
    return;
  }

  const uid     = signinData.localId;
  const idToken = signinData.idToken;

  // ── 2. Write Firestore document ──────────────────────────────────────
  const fsUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}`;
  const fsRes = await fetch(fsUrl, {
    method:  'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fields: {
        jokerId: { stringValue: jokerId },
        isAdmin: { booleanValue: isAdmin },
        created: { integerValue: Date.now() },
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
    console.error('Missing env vars.');
    process.exit(1);
  }

  console.log(`Stamping Firestore docs → project: ${PROJECT_ID}\n`);

  await stampDoc('00-00', true);
  await sleep(200);

  for (let i = 1; i <= 54; i++) {
    const id = `${String(i).padStart(2, '0')}-54`;
    await stampDoc(id, false);
    await sleep(150);
  }

  console.log('\nAll done!');
}

main().catch(console.error);
