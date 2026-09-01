// Purge leftover E2E / tester accounts from the live Firebase project.
//
// Automated browser verifications create throwaway member accounts (e.g.
// "97-41 E2E Manuscript Tester"). When a test run dies before its own
// cleanup, those accounts linger in the roster and show up in The Hand.
// This maintenance sweep finds and fully removes them:
//
//   • target = any account whose Joker ID is outside the real range
//     (00-00 admin slot, or 01-54 … 54-54) OR whose profile name matches
//     E2E/tester patterns — checked in both Firestore users docs and raw
//     Firebase Auth accounts (an auth account with no users doc is still
//     a target).
//   • removal = the real wipeUser() manifest from src/lib/memberAdmin.ts
//     (users doc + subtrees, sessions, notifications, contract signings,
//     vault comments/reviews, archives, storage prefixes …), then the
//     users doc itself and the Firebase Auth account.
//   • plus: any vault entry whose title matches the E2E pattern is deleted
//     with its comments/reviews subcollections and vault/{id}/ storage.
//
// Auth: FIREBASE_TOKEN OAuth exchange (same owner-level access the
// api-server uses — see .agents/memory/prod-smoke-testing.md).
//
// Usage (from artifacts/api-server):
//   node scripts/purge-testers.mjs --dry-run   # list what would be removed
//   node scripts/purge-testers.mjs             # actually purge
//
// The admin slot 00-00 and any users doc with isAdmin=true are never
// touched, even if a name pattern matches.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

process.env.NODE_ENV = "production"; // plain pino logger (no pretty transport)

const DRY_RUN = process.argv.includes("--dry-run");

const PROJECT = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const BUCKET = process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET;
if (!PROJECT || !BUCKET) {
  console.error(
    "EXPO_PUBLIC_FIREBASE_PROJECT_ID and EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET must be set",
  );
  process.exit(1);
}
if (!process.env.FIREBASE_TOKEN && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("FIREBASE_TOKEN is not set");
  process.exit(1);
}

// ── The legitimate roster ────────────────────────────────────────────────────
// 00-00 is the admin (the Jester); members hold 01-54 … 54-54.
const VALID_JOKER_IDS = new Set(["00-00"]);
for (let i = 1; i <= 54; i++) {
  VALID_JOKER_IDS.add(`${String(i).padStart(2, "0")}-54`);
}
const isValidJokerId = (id) => VALID_JOKER_IDS.has(String(id ?? "").trim());

// Names / titles that mark throwaway test data.
const TEST_PATTERN = /\b(e2e|tester|smoke[- ]?test|playwright|throwaway)\b/i;

// ── Bundle the real production admin helpers ────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
async function bundleLib(rel, outName) {
  const outfile = join(here, outName);
  await build({
    entryPoints: [join(here, rel)],
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["pino"],
    outfile,
    logLevel: "silent",
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(outfile);
  return mod;
}
const { getAccessToken, firestoreBase } = await bundleLib(
  "../src/lib/firestoreAdmin.ts",
  ".purge-fsadmin-bundle.mjs",
);
const { wipeUser } = await bundleLib(
  "../src/lib/memberAdmin.ts",
  ".purge-memberadmin-bundle.mjs",
);

const token = await getAccessToken();
if (!token) {
  console.error("OAuth exchange failed — check FIREBASE_TOKEN");
  process.exit(1);
}
const HEADERS = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const FS_BASE = firestoreBase(PROJECT);
const DOC_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const IDT = "https://identitytoolkit.googleapis.com/v1";

const str = (v) => (typeof v?.stringValue === "string" ? v.stringValue : "");
const relPath = (name) => {
  const i = name.indexOf("/documents/");
  return i === -1 ? name : name.slice(i + "/documents/".length);
};

async function listDocs(path) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${FS_BASE}/${path}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}&showMissing=true`;
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`list ${path} failed (${res.status})`);
    const data = await res.json();
    for (const d of data.documents ?? []) if (d.name) out.push(d);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

async function deleteByName(names) {
  for (let i = 0; i < names.length; i += 400) {
    const chunk = names.slice(i, i + 400);
    const res = await fetch(`${FS_BASE}:commit`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ writes: chunk.map((name) => ({ delete: name })) }),
    });
    if (!res.ok) throw new Error(`delete commit failed (${res.status})`);
  }
}

async function deleteStoragePrefix(prefix) {
  const listBase = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(BUCKET)}/o`;
  let pageToken = "";
  do {
    const url = `${listBase}?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`storage list failed (${res.status}) for ${prefix}`);
    const data = await res.json();
    for (const item of data.items ?? []) {
      const del = await fetch(`${listBase}/${encodeURIComponent(item.name)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!del.ok && del.status !== 404) {
        throw new Error(`storage delete failed (${del.status}) for ${item.name}`);
      }
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
}

// ── 1. Find tester accounts ──────────────────────────────────────────────────
// A) Firestore users docs.
const targets = new Map(); // uid → reason
const userDocs = (await listDocs("users")).filter((d) => d.fields);
for (const d of userDocs) {
  const uid = relPath(d.name).split("/").pop();
  const f = d.fields;
  const jokerId = str(f.jokerId).trim();
  const name = str(f.name) || str(f.codename);
  if (f.isAdmin?.booleanValue === true || jokerId === "00-00") continue; // never the Jester
  if (jokerId && !isValidJokerId(jokerId)) {
    targets.set(uid, `jokerId "${jokerId}" outside real range`);
  } else if (TEST_PATTERN.test(name) || TEST_PATTERN.test(jokerId)) {
    targets.set(uid, `name "${name}" matches tester pattern`);
  }
}

// B) Raw Firebase Auth accounts (covers accounts with no users doc).
//    Email scheme: {jokerId}@jestershand.local (see firebase-setup memory).
const adminUids = new Set(
  userDocs
    .filter((d) => d.fields?.isAdmin?.booleanValue === true || str(d.fields?.jokerId).trim() === "00-00")
    .map((d) => relPath(d.name).split("/").pop()),
);
{
  let offset = 0;
  const LIMIT = 500;
  for (;;) {
    const res = await fetch(`${IDT}/projects/${PROJECT}/accounts:query`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ returnUserInfo: true, limit: String(LIMIT), offset: String(offset) }),
    });
    if (!res.ok) throw new Error(`accounts:query failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const users = data.userInfo ?? [];
    for (const u of users) {
      if (!u.localId || adminUids.has(u.localId) || targets.has(u.localId)) continue;
      const email = String(u.email ?? "");
      const local = email.endsWith("@jestershand.local")
        ? email.slice(0, -"@jestershand.local".length)
        : "";
      const display = String(u.displayName ?? "");
      // Conservative: only target accounts that positively look like testers.
      // (The project has legacy auth accounts on other email schemes with no
      // users doc — those are NOT testers and are deliberately left alone.)
      if (local && /^\d{2}-\d{2}$/.test(local) && !isValidJokerId(local)) {
        targets.set(u.localId, `auth email "${email}" is a Joker ID outside the real range`);
      } else if (TEST_PATTERN.test(display) || TEST_PATTERN.test(email)) {
        targets.set(u.localId, `auth account "${email}" / "${display}" matches tester pattern`);
      }
    }
    if (users.length < LIMIT) break;
    offset += LIMIT;
  }
}

// ── 2. Find E2E-titled vault entries ─────────────────────────────────────────
const vaultTargets = [];
for (const d of await listDocs("vault")) {
  if (!d.fields) continue;
  const title = str(d.fields.title);
  if (TEST_PATTERN.test(title)) {
    vaultTargets.push({ name: d.name, id: relPath(d.name).split("/").pop(), title });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`Project: ${PROJECT}${DRY_RUN ? "  (DRY RUN — nothing will be deleted)" : ""}`);
console.log(`Tester accounts found: ${targets.size}`);
for (const [uid, reason] of targets) console.log(`  - ${uid}: ${reason}`);
console.log(`E2E-titled vault entries found: ${vaultTargets.length}`);
for (const v of vaultTargets) console.log(`  - ${v.id}: "${v.title}"`);

if (DRY_RUN) process.exit(0);
if (targets.size === 0 && vaultTargets.length === 0) {
  console.log("Nothing to purge.");
  process.exit(0);
}

// ── 3. Purge accounts ────────────────────────────────────────────────────────
let failures = 0;
for (const [uid, reason] of targets) {
  try {
    console.log(`Purging ${uid} (${reason}) …`);
    // Full data wipe via the production Transfer manifest (throws on failure).
    await wipeUser(PROJECT, BUCKET, uid);
    // Transfer keeps a clean slot doc; testers must vanish entirely.
    await deleteByName([`${DOC_ROOT}/users/${uid}`]);
    // Delete the Firebase Auth account itself.
    const res = await fetch(`${IDT}/projects/${PROJECT}/accounts:delete`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ localId: uid }),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`accounts:delete failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    console.log(`  done`);
  } catch (err) {
    failures++;
    console.error(`  FAILED for ${uid}: ${err.message}`);
  }
}

// ── 4. Purge E2E vault entries (doc + comments/reviews + storage) ───────────
for (const v of vaultTargets) {
  try {
    console.log(`Deleting vault entry ${v.id} ("${v.title}") …`);
    const rel = relPath(v.name);
    const subs = [];
    for (const sub of ["comments", "reviews"]) {
      for (const c of await listDocs(`${rel}/${sub}`)) subs.push(c.name);
    }
    await deleteByName([...subs, v.name]);
    await deleteStoragePrefix(`vault/${v.id}/`);
    // Activity log rows pointing at the deleted entry.
    const activity = await listDocs("vaultActivity");
    await deleteByName(
      activity
        .filter((a) => a.fields && str(a.fields.entryId) === v.id)
        .map((a) => a.name),
    );
    console.log(`  done`);
  } catch (err) {
    failures++;
    console.error(`  FAILED for vault/${v.id}: ${err.message}`);
  }
}

console.log(failures ? `\nCompleted with ${failures} failure(s).` : "\nPurge complete.");
process.exit(failures ? 1 : 0);
