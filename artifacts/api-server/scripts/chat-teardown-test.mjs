// End-to-end conversation teardown test against Firestore + Storage emulators.
//
// Run from artifacts/jesters-hand (where firebase.json lives):
//   firebase emulators:exec --only firestore,storage --project demo-rules-test \
//     "node ../api-server/scripts/chat-teardown-test.mjs"
//
// Exercises the real teardownConversation() from src/lib/chatCleanup.ts:
//   1. last-member teardown deletes conversation + messages + BOTH members'
//      chatMedia attachments, and leaves unrelated files/messages alone;
//   2. a caller who is not the sole remaining member is refused;
//   3. an orphaned (zero-member) conversation may be torn down by anyone.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

process.env.NODE_ENV = "production";

const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const STORAGE_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
  process.env.STORAGE_EMULATOR_HOST ||
  "127.0.0.1:9199";
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST;

const PROJECT = "demo-rules-test";
const BUCKET = `${PROJECT}.appspot.com`;
const FS_BASE = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const DOC_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const HEADERS = { Authorization: "Bearer owner", "Content-Type": "application/json" };
const ST_BASE = `http://${STORAGE_HOST}/storage/v1/b/${encodeURIComponent(BUCKET)}/o`;

// ── Bundle the real chatCleanup.ts so the test drives production code ───────
const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, ".chat-teardown-bundle.mjs");
await build({
  entryPoints: [join(here, "../src/lib/chatCleanup.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["pino"],
  outfile: bundle,
  logLevel: "silent",
});
const { teardownConversation } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

// ── Helpers ──────────────────────────────────────────────────────────────────
const s = (v) => ({ stringValue: v });
const arr = (...vals) => ({ arrayValue: { values: vals.map((v) => s(v)) } });

async function put(path, fields) {
  const res = await fetch(`${FS_BASE}:commit`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ writes: [{ update: { name: `${DOC_ROOT}/${path}`, fields } }] }),
  });
  if (!res.ok) throw new Error(`seed put ${path} failed: ${res.status}`);
}

async function docExists(path) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: HEADERS });
  return res.status === 200;
}

async function putFile(name) {
  const res = await fetch(
    `http://${STORAGE_HOST}/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "image/gif" }, body: new Uint8Array([1, 2, 3]) },
  );
  if (!res.ok) throw new Error(`seed upload ${name} failed: ${res.status}`);
}

async function fileExists(name) {
  const res = await fetch(`${ST_BASE}/${encodeURIComponent(name)}`, {
    headers: { Authorization: "Bearer owner" },
  });
  return res.status === 200;
}

const dlUrl = (path) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=x`;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

// ── Seed ─────────────────────────────────────────────────────────────────────
// conv1: alice is the sole remaining member; messages from alice AND bob with
// attachments; one text-only message. conv2: unrelated live conversation whose
// attachment must survive. conv3: orphaned (zero members).
// Member profiles: alice/bob/carol are real members; "suspect" is suspended;
// "ghost" (no users doc) never gets one.
await put("users/alice", { jokerId: s("01-01") });
await put("users/bob", { jokerId: s("02-02") });
await put("users/carol", { jokerId: s("03-03") });
await put("users/suspect", { jokerId: s("04-04"), suspended: { booleanValue: true } });

await put("conversations/conv1", { memberUids: arr("alice") });
await put("conversations/conv1/messages/m1", {
  senderUid: s("alice"), text: s("hi"), imageUrl: s(dlUrl("chatMedia/alice/1.gif")),
});
await put("conversations/conv1/messages/m2", {
  senderUid: s("bob"), text: s(""), imageUrl: s(dlUrl("chatMedia/bob/2.gif")),
});
await put("conversations/conv1/messages/m3", { senderUid: s("alice"), text: s("plain") });
// Adversarial: bob stored a URL pointing at CAROL's object — must NOT be
// deleted (sender-bound path check).
await put("conversations/conv1/messages/m4", {
  senderUid: s("bob"), text: s(""), imageUrl: s(dlUrl("chatMedia/carol/3.gif")),
});

await put("conversations/conv2", { memberUids: arr("alice", "carol") });
await put("conversations/conv2/messages/k1", {
  senderUid: s("carol"), text: s(""), imageUrl: s(dlUrl("chatMedia/carol/3.gif")),
});

await put("conversations/conv3", { memberUids: { arrayValue: {} } });
await put("conversations/conv3/messages/o1", {
  senderUid: s("bob"), text: s(""), imageUrl: s(dlUrl("chatMedia/bob/4.gif")),
});

await putFile("chatMedia/alice/1.gif");
await putFile("chatMedia/bob/2.gif");
await putFile("chatMedia/carol/3.gif");
await putFile("chatMedia/bob/4.gif");

// ── 0. Callers without a real member profile are refused ────────────────────
const ghost = await teardownConversation(PROJECT, BUCKET, "conv3", "ghost");
check("auth account with NO users doc is refused", ghost.ok === false && ghost.status === 403);
const susp = await teardownConversation(PROJECT, BUCKET, "conv3", "suspect");
check("suspended member is refused", susp.ok === false && susp.status === 403);
check("refused callers deleted nothing", (await docExists("conversations/conv3/messages/o1")) && (await fileExists("chatMedia/bob/4.gif")));

// ── 1. Non-member / non-last-member callers are refused ─────────────────────
const refused = await teardownConversation(PROJECT, BUCKET, "conv1", "bob");
check("caller who is not the sole member is refused", refused.ok === false && refused.status === 403);
const refused2 = await teardownConversation(PROJECT, BUCKET, "conv2", "alice");
check("conversation with other members left is refused", refused2.ok === false && refused2.status === 403);
check("refused teardown deleted nothing", (await docExists("conversations/conv1/messages/m2")) && (await fileExists("chatMedia/bob/2.gif")));

// ── 2. Last-member teardown ──────────────────────────────────────────────────
const r1 = await teardownConversation(PROJECT, BUCKET, "conv1", "alice");
check("last-member teardown succeeds", r1.ok === true && r1.deletedMessages === 4 && r1.deletedFiles === 2);
check("conversation doc deleted", !(await docExists("conversations/conv1")));
check("message docs deleted", !(await docExists("conversations/conv1/messages/m1")) && !(await docExists("conversations/conv1/messages/m2")));
check("caller's attachment deleted", !(await fileExists("chatMedia/alice/1.gif")));
check("OTHER member's attachment deleted too", !(await fileExists("chatMedia/bob/2.gif")));
check("unrelated conversation + attachment survive", (await docExists("conversations/conv2/messages/k1")) && (await fileExists("chatMedia/carol/3.gif")));
check("adversarial cross-folder imageUrl did NOT delete victim's file", await fileExists("chatMedia/carol/3.gif"));

// ── 3. Orphan teardown ───────────────────────────────────────────────────────
const r2 = await teardownConversation(PROJECT, BUCKET, "conv3", "carol");
check("orphaned conversation teardown succeeds for any member", r2.ok === true && r2.deletedFiles === 1);
check("orphan attachment deleted", !(await fileExists("chatMedia/bob/4.gif")));
check("missing conversation → 404", (await teardownConversation(PROJECT, BUCKET, "nope", "alice")).status === 404);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
