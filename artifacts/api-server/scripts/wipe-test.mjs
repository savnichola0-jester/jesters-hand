// End-to-end Transfer wipe test against the Firestore + Storage emulators.
//
// Run from artifacts/jesters-hand (where firebase.json lives):
//   firebase emulators:exec --only firestore,storage --project demo-rules-test \
//     "node ../api-server/scripts/wipe-test.mjs"
//
// Seeds data for uid "victim" in every area of the wipe manifest (plus data
// for "other" that must survive), runs the real wipeUser() from
// src/lib/memberAdmin.ts against the emulator endpoints, then asserts that
// nothing tied to the victim remains except a clean users doc with jokerId.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { rmSync } from "node:fs";

process.env.NODE_ENV = "production"; // plain pino logger (no pretty transport)

const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8181";
const STORAGE_HOST =
  process.env.FIREBASE_STORAGE_EMULATOR_HOST ||
  process.env.STORAGE_EMULATOR_HOST ||
  "127.0.0.1:9199";
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
process.env.FIREBASE_STORAGE_EMULATOR_HOST = STORAGE_HOST;

const PROJECT = "demo-rules-test";
const BUCKET = `${PROJECT}.appspot.com`;
const UID = "victim";
const OTHER = "other";
const FS_BASE = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
const HEADERS = { Authorization: "Bearer owner", "Content-Type": "application/json" };

// ── Bundle the real memberAdmin.ts so the test drives production code ───────
const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, ".wipe-test-bundle.mjs");
await build({
  entryPoints: [join(here, "../src/lib/memberAdmin.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["pino"],
  outfile: bundle,
  logLevel: "silent",
});
const { wipeUser } = await import(pathToFileURL(bundle).href);
rmSync(bundle);

// ── Tiny Firestore REST helpers (owner token bypasses rules) ────────────────
const s = (v) => ({ stringValue: v });
const arr = (...vals) => ({ arrayValue: { values: vals.map((v) => s(v)) } });
const map = (fields) => ({ mapValue: { fields } });
const int = (v) => ({ integerValue: String(v) });

const DOC_ROOT = `projects/${PROJECT}/databases/(default)/documents`;
async function put(path, fields) {
  const res = await fetch(`${FS_BASE}:commit`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ writes: [{ update: { name: `${DOC_ROOT}/${path}`, fields } }] }),
  });
  if (!res.ok) throw new Error(`seed ${path} failed (${res.status}): ${await res.text()}`);
}

async function getDocRest(path) {
  const res = await fetch(`${FS_BASE}/${path}`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${path} failed (${res.status})`);
  return res.json();
}

async function listRest(path) {
  const res = await fetch(`${FS_BASE}/${path}?pageSize=300&showMissing=true`, { headers: HEADERS });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`list ${path} failed (${res.status})`);
  const data = await res.json();
  return data.documents ?? [];
}

// ── Storage emulator helpers ────────────────────────────────────────────────
const ST_BASE = `http://${STORAGE_HOST}`;
async function uploadObject(name) {
  const res = await fetch(
    `${ST_BASE}/upload/storage/v1/b/${encodeURIComponent(BUCKET)}/o?uploadType=media&name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { Authorization: "Bearer owner", "Content-Type": "application/octet-stream" }, body: new Uint8Array([1, 2, 3]) },
  );
  if (!res.ok) throw new Error(`upload ${name} failed (${res.status}): ${await res.text()}`);
}
async function listObjects(prefix) {
  const res = await fetch(
    `${ST_BASE}/storage/v1/b/${encodeURIComponent(BUCKET)}/o?prefix=${encodeURIComponent(prefix)}`,
    { headers: { Authorization: "Bearer owner" } },
  );
  if (!res.ok) throw new Error(`storage list ${prefix} failed (${res.status})`);
  const data = await res.json();
  return (data.items ?? []).map((i) => i.name);
}

// ── Seed the full manifest ──────────────────────────────────────────────────
const now = { timestampValue: new Date().toISOString() };

// users
await put(`users/${UID}`, {
  jokerId: s("J-013"), codename: s("Wraith"), bio: s("secret past"),
  expoPushToken: s("ExponentPushToken[dead]"), isAdmin: { booleanValue: false },
});
await put(`users/${OTHER}`, { jokerId: s("J-007"), codename: s("Ace") });

// 1. per-user subtrees
await put(`notifications/${UID}/items/n1`, { type: s("message"), fromUid: s(OTHER), text: s("hi"), createdAt: now });
await put(`blackBook/${UID}/entries/b1`, { title: s("grudge"), createdAt: now });
await put(`issuedItems/${UID}/records/r1`, { name: s("lockpick"), createdAt: now });
await put(`sessions/${UID}/logs/s1`, { startedAt: now, lastActiveAt: now, endedAt: now });
await put(`sessions/${OTHER}/logs/s1`, { startedAt: now, lastActiveAt: now, endedAt: now });
await put(`dealActivity/${UID}/events/e1`, { uid: s(UID), type: s("mark"), sourceId: s("x"), occurredAt: now });
await put(`dealActivity/${OTHER}/events/e1`, { uid: s(OTHER), type: s("mark"), sourceId: s("y"), occurredAt: now });
await put(`dealAwards/${UID}/items/a1`, { uid: s(UID), milestone: int(3), message: s("Bravo"), awardedBy: s("jester"), awardedAt: now });
await put(`dealMemberStats/${UID}`, { uid: s(UID), currentStreak: int(3), bestStreak: int(3), lastActivityAt: now });
await put(`deals/d1`, { title: s("Deal"), status: s("published"), createdBy: s("jester"), createdAt: now, publishedAt: now });
await put(`dealCompletions/d1/members/${UID}`, { uid: s(UID), taskCounts: map({ t1: int(1) }), completedTaskIds: arr("t1"), completedAt: now, updatedAt: now });
await put(`dealCompletions/d1/members/${OTHER}`, { uid: s(OTHER), taskCounts: map({}), completedTaskIds: arr(), updatedAt: now });
await put(`suitAssignments/${UID}`, { pips: arr("spade"), streaks: map({ spade: int(3) }), completed: map({}) });
await put(`suitAssignments/${OTHER}`, { pips: arr("heart"), streaks: map({ heart: int(1) }), completed: map({}) });
await put(`activityEvents/victim-event`, { uid: s(UID), action: s("SUITS completion"), section: s("SUITS"), occurredAt: now });
await put(`activityEvents/other-event`, { uid: s(OTHER), action: s("Deal completion"), section: s("Jester's Deal"), occurredAt: now });
await put(`investigationEvents/victim-event`, { uid: s(UID), action: s("SUITS completion"), context: s("private context"), occurredAt: now });
await put(`investigationEvents/other-event`, { uid: s(OTHER), action: s("Deal completion"), context: s("other context"), occurredAt: now });
await put(`agreements/${UID}`, { uid: s(UID), jokerId: s("J-013"), name: s("Wraith"), signedDate: s("08/04/2026"), signedAt: now });
await put(`agreements/${OTHER}`, { uid: s(OTHER), jokerId: s("J-007"), name: s("Ace"), signedDate: s("08/04/2026"), signedAt: now });
await put(`archives/arch1`, {
  type: s("ante_post"), section: s("The Pool"), title: s("mine"),
  ownerUid: s(UID), ownerJokerId: s("J-013"), restorePath: s("antePosts/place/posts/x"),
  deletedByUid: s(OTHER), deletedAt: now,
});
await put(`archives/arch2`, {
  type: s("table_message"), section: s("Table"), title: s("theirs"),
  ownerUid: s(OTHER), ownerJokerId: s("J-007"), restorePath: s("tableMessages/verdict/messages/y"),
  deletedByUid: s(OTHER), deletedAt: now,
});
await put(`notifications/${OTHER}/items/n1`, { type: s("message"), fromUid: s(UID), text: s("hey"), createdAt: now });

// 2. target tickets
await put(`targetTickets/ownTicket`, { senderUid: s(UID), title: s("mine"), reactions: map({}), commentCount: int(1), mutedBy: arr(), createdAt: now });
await put(`targetTickets/ownTicket/comments/c1`, { senderUid: s(OTHER), text: s("nice"), reactions: map({}), createdAt: now });
await put(`targetTickets/otherTicket`, {
  senderUid: s(OTHER), title: s("theirs"), commentCount: int(2),
  reactions: map({ "🔥": arr(UID, OTHER) }), mutedBy: arr(UID), createdAt: now,
});
await put(`targetTickets/otherTicket/comments/vc`, { senderUid: s(UID), text: s("my comment"), reactions: map({}), createdAt: now });
await put(`targetTickets/otherTicket/comments/oc`, { senderUid: s(OTHER), text: s("their comment"), reactions: map({ "👍": arr(UID) }), createdAt: now });

// 3. ante boards
for (const board of ["place", "raised"]) {
  await put(`antePosts/${board}/posts/ownPost`, { senderUid: s(UID), title: s("own"), reactions: map({}), votes: map({}), commentCount: int(0), createdAt: now });
  await put(`antePosts/${board}/posts/otherPost`, {
    senderUid: s(OTHER), title: s("other"), commentCount: int(1),
    reactions: map({ "🃏": arr(UID) }), votes: map({ [UID]: int(1), [OTHER]: int(2) }), createdAt: now,
  });
  await put(`antePosts/${board}/posts/otherPost/comments/vc`, { senderUid: s(UID), text: s("mine"), reactions: map({}), createdAt: now });
}

// 4. table channels
await put(`tableMessages/general/messages/m1`, { senderUid: s(UID), text: s("victim msg"), reactions: map({}), sentAt: now });
await put(`tableMessages/general/messages/m2`, { senderUid: s(OTHER), text: s("other msg"), reactions: map({ "😂": arr(UID, OTHER) }), sentAt: now });
await put(`tableMessages/heists/messages/m1`, { senderUid: s(UID), text: s("plan"), reactions: map({}), sentAt: now });

// 4a. voice presence
await put(`voicePresence/side-deck-voice/members/${UID}`, { jokerId: s("J-013"), joinedAt: now, lastActiveAt: now });
await put(`voicePresence/side-deck-voice/members/${OTHER}`, { jokerId: s("J-007"), joinedAt: now, lastActiveAt: now });
await put(`voicePresence/under-the-table-voice/members/${UID}`, { jokerId: s("J-013"), joinedAt: now, lastActiveAt: now });

// 5. conversations
await put(`conversations/shared`, {
  memberUids: arr(UID, OTHER), isGroup: { booleanValue: false }, lastMessage: s("hi"),
  unreadCounts: map({ [UID]: int(3), [OTHER]: int(0) }), deletedBy: arr(),
});
await put(`conversations/shared/messages/m1`, { senderUid: s(UID), text: s("victim whisper"), reactions: map({}), sentAt: now });
await put(`conversations/shared/messages/m2`, { senderUid: s(OTHER), text: s("other whisper"), reactions: map({ "❤️": arr(UID) }), sentAt: now });
await put(`conversations/solo`, {
  memberUids: arr(UID), isGroup: { booleanValue: false }, lastMessage: s("note"),
  unreadCounts: map({ [UID]: int(0) }), deletedBy: arr(),
});
await put(`conversations/solo/messages/m1`, { senderUid: s(UID), text: s("note to self"), reactions: map({}), sentAt: now });
// solo conversation also holds an OLD message from OTHER (they left long ago)
// with a photo attachment — the teardown must remove that file too.
const dlUrl = (p) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media&token=x`;
await put(`conversations/solo/messages/m2`, {
  senderUid: s(OTHER), text: s(""), imageUrl: s(dlUrl(`chatMedia/${OTHER}/gone.gif`)), reactions: map({}), sentAt: now,
});
// shared conversation survives — OTHER's live attachment there must survive.
await put(`conversations/shared/messages/m3`, {
  senderUid: s(OTHER), text: s(""), imageUrl: s(dlUrl(`chatMedia/${OTHER}/live.gif`)), reactions: map({}), sentAt: now,
});

// 5b. vault reading circle (entries authored by admin "jester")
await put(`vault/e1`, {
  title: s("Chapter One"), section: s("stack"), status: s("published"),
  createdBy: s("jester"), commentCount: int(2), reviewCount: int(2), ratingSum: int(9),
  reactions: map({ "🔥": arr(UID, OTHER) }), createdAt: now,
});
await put(`vault/e1/comments/vc`, { senderUid: s(UID), jokerId: s("J-013"), text: s("mine"), page: int(3), reactions: map({}), createdAt: now });
await put(`vault/e1/comments/oc`, { senderUid: s(OTHER), jokerId: s("J-007"), text: s("theirs"), reactions: map({ "👍": arr(UID) }), createdAt: now });
await put(`vault/e1/reviews/${UID}`, { uid: s(UID), jokerId: s("J-013"), rating: int(5), text: s("great"), createdAt: now, updatedAt: now });
await put(`vault/e1/reviews/${OTHER}`, { uid: s(OTHER), jokerId: s("J-007"), rating: int(4), text: s("good"), createdAt: now, updatedAt: now });
// per-user emoji marks on a chapter target: victim's + another member's.
await put(`vault/e1/marks/ch1__${UID}`, { uid: s(UID), jokerId: s("J-013"), targetId: s("ch1"), targetType: s("chapter"), page: int(1), chapterStartPage: int(1), emojis: arr("🔥"), createdAt: now, updatedAt: now });
await put(`vault/e1/marks/ch1__${OTHER}`, { uid: s(OTHER), jokerId: s("J-007"), targetId: s("ch1"), targetType: s("chapter"), page: int(1), chapterStartPage: int(1), emojis: arr("👍"), createdAt: now, updatedAt: now });
await put(`bookReviews/${UID}`, { uid: s(UID), jokerId: s("J-013"), rating: int(5), text: s("saga"), createdAt: now, updatedAt: now });
await put(`bookReviews/${OTHER}`, { uid: s(OTHER), jokerId: s("J-007"), rating: int(3), text: s("meh"), createdAt: now, updatedAt: now });

// 6. vault activity
await put(`vaultActivity/v1`, { uid: s(UID), action: s("download"), entryId: s("e1"), at: now });
await put(`vaultActivity/v2`, { uid: s(OTHER), action: s("download"), entryId: s("e1"), at: now });

// 6b. server-only push receipt queue (pending Expo receipt polls)
await put(`pushReceiptQueue/t-victim`, { token: s("ExponentPushToken[dead]"), createdAt: now });
await put(`pushReceiptQueue/t-other`, { token: s("ExponentPushToken[alive]"), createdAt: now });

// 7. storage
await uploadObject(`users/${UID}/mug.jpg`);
await uploadObject(`users/${UID}/photos/extra.jpg`);
await uploadObject(`targetTickets/${UID}/spread.jpg`);
await uploadObject(`users/${OTHER}/mug.jpg`);
await uploadObject(`targetTickets/${OTHER}/spread.jpg`);
await uploadObject(`chatMedia/${UID}/mine.gif`);
await uploadObject(`chatMedia/${OTHER}/gone.gif`);
await uploadObject(`chatMedia/${OTHER}/live.gif`);

// ── Run the real wipe ───────────────────────────────────────────────────────
await wipeUser(PROJECT, BUCKET, UID);

// ── Assertions ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const fieldsOf = (d) => d?.fields ?? {};
const strOf = (v) => v?.stringValue ?? "";

await test("users doc is a clean slot with only jokerId", async () => {
  const d = await getDocRest(`users/${UID}`);
  assert(d, "users doc missing entirely");
  const keys = Object.keys(fieldsOf(d));
  assert(keys.length === 1 && keys[0] === "jokerId", `unexpected fields: ${keys.join(",")}`);
  assert(strOf(fieldsOf(d).jokerId) === "J-013", "jokerId lost");
});

await test("notifications / blackBook / issuedItems / sessions subtrees are gone", async () => {
  for (const p of [`notifications/${UID}/items`, `blackBook/${UID}/entries`, `issuedItems/${UID}/records`, `sessions/${UID}/logs`]) {
    assert((await listRest(p)).length === 0, `${p} not empty`);
  }
  assert(!(await getDocRest(`agreements/${UID}`)), "victim signed contract remains");
  assert(await getDocRest(`agreements/${OTHER}`), "other member's contract lost");
  for (const p of [`notifications/${UID}`, `blackBook/${UID}`, `issuedItems/${UID}`, `sessions/${UID}`]) {
    const d = await getDocRest(p);
    assert(!d || !d.fields, `${p} parent doc remains`);
  }
  assert((await listRest(`sessions/${OTHER}/logs`)).length === 1, "other member's sessions lost");
});

await test("Deal activity, progress, stats, and awards are wiped owner-only", async () => {
  assert((await listRest(`dealActivity/${UID}/events`)).length === 0, "deal activity remains");
  assert((await listRest(`dealAwards/${UID}/items`)).length === 0, "deal awards remain");
  assert(!(await getDocRest(`dealMemberStats/${UID}`)), "deal stats remain");
  assert(!(await getDocRest(`dealCompletions/d1/members/${UID}`)), "deal completion remains");
  assert(await getDocRest(`dealActivity/${OTHER}/events/e1`), "other deal activity lost");
  assert(await getDocRest(`dealCompletions/d1/members/${OTHER}`), "other deal completion lost");
});

await test("SUITS assignments and audit streams are wiped owner-only", async () => {
  assert(!(await getDocRest(`suitAssignments/${UID}`)), "victim SUITS assignment remains");
  assert(await getDocRest(`suitAssignments/${OTHER}`), "other SUITS assignment lost");
  assert(!(await getDocRest("activityEvents/victim-event")), "victim Activity event remains");
  assert(await getDocRest("activityEvents/other-event"), "other Activity event lost");
  assert(!(await getDocRest("investigationEvents/victim-event")), "victim Investigation event remains");
  assert(await getDocRest("investigationEvents/other-event"), "other Investigation event lost");
});

await test("own ticket + its comments deleted; other users' tickets survive", async () => {
  assert(!(await getDocRest("targetTickets/ownTicket")), "ownTicket remains");
  assert((await listRest("targetTickets/ownTicket/comments")).length === 0, "ownTicket comments remain");
  assert(await getDocRest("targetTickets/otherTicket"), "otherTicket wrongly deleted");
});

await test("victim comment deleted, reactions/mutedBy scrubbed on other's ticket", async () => {
  assert(!(await getDocRest("targetTickets/otherTicket/comments/vc")), "victim comment remains");
  const oc = await getDocRest("targetTickets/otherTicket/comments/oc");
  assert(oc, "other's comment wrongly deleted");
  assert(!JSON.stringify(oc).includes(UID), "uid remains in other's comment reactions");
  const t = await getDocRest("targetTickets/otherTicket");
  const json = JSON.stringify(t);
  assert(!json.includes(`"${UID}"`), "uid remains on otherTicket (reactions/mutedBy)");
  const fire = fieldsOf(t).reactions?.mapValue?.fields?.["🔥"];
  assert(fire?.arrayValue?.values?.some((v) => v.stringValue === OTHER), "other's reaction lost");
});

await test("ante boards: own posts deleted, votes/reactions/comments scrubbed", async () => {
  for (const board of ["place", "raised"]) {
    assert(!(await getDocRest(`antePosts/${board}/posts/ownPost`)), `${board} ownPost remains`);
    const other = await getDocRest(`antePosts/${board}/posts/otherPost`);
    assert(other, `${board} otherPost wrongly deleted`);
    assert(!JSON.stringify(other).includes(`"${UID}"`), `${board} otherPost still references uid`);
    assert(fieldsOf(other).votes?.mapValue?.fields?.[OTHER], `${board} other's vote lost`);
    assert(!(await getDocRest(`antePosts/${board}/posts/otherPost/comments/vc`)), `${board} victim comment remains`);
  }
});

await test("table channels: own messages deleted, reactions scrubbed everywhere", async () => {
  assert(!(await getDocRest("tableMessages/general/messages/m1")), "victim table msg remains");
  assert(!(await getDocRest("tableMessages/heists/messages/m1")), "victim msg in second channel remains");
  assert(!(await getDocRest(`voicePresence/side-deck-voice/members/${UID}`)), "victim voice presence remains");
  assert(!(await getDocRest(`voicePresence/under-the-table-voice/members/${UID}`)), "victim voice presence remains (2nd channel)");
  assert(await getDocRest(`voicePresence/side-deck-voice/members/${OTHER}`), "other member's voice presence lost");
  const m2 = await getDocRest("tableMessages/general/messages/m2");
  assert(m2, "other's table msg wrongly deleted");
  assert(!JSON.stringify(m2).includes(`"${UID}"`), "uid remains in table msg reactions");
});

await test("shared conversation: membership, unread count, msgs, reactions purged", async () => {
  const conv = await getDocRest("conversations/shared");
  assert(conv, "shared conversation wrongly deleted");
  assert(!JSON.stringify(conv).includes(`"${UID}"`), "uid remains on shared conversation");
  assert(!(await getDocRest("conversations/shared/messages/m1")), "victim whisper remains");
  const m2 = await getDocRest("conversations/shared/messages/m2");
  assert(m2, "other's whisper wrongly deleted");
  assert(!JSON.stringify(m2).includes(`"${UID}"`), "uid remains in whisper reactions");
});

await test("solo conversation deleted entirely with its messages", async () => {
  const d = await getDocRest("conversations/solo");
  assert(!d || !d.fields, "solo conversation remains");
  assert((await listRest("conversations/solo/messages")).length === 0, "solo messages remain");
});

await test("vault reading circle: victim comments/reviews gone, entry + others survive", async () => {
  const entry = await getDocRest("vault/e1");
  assert(entry, "vault entry wrongly deleted");
  assert(!JSON.stringify(entry).includes(`"${UID}"`), "uid remains in entry reactions");
  assert(!(await getDocRest("vault/e1/comments/vc")), "victim vault comment remains");
  const oc = await getDocRest("vault/e1/comments/oc");
  assert(oc, "other's vault comment wrongly deleted");
  assert(!JSON.stringify(oc).includes(`"${UID}"`), "uid remains in comment reactions");
  assert(!(await getDocRest(`vault/e1/reviews/${UID}`)), "victim vault review remains");
  assert(await getDocRest(`vault/e1/reviews/${OTHER}`), "other's vault review lost");
  assert(!(await getDocRest(`bookReviews/${UID}`)), "victim book review remains");
  assert(await getDocRest(`bookReviews/${OTHER}`), "other's book review lost");
  // Per-user emoji marks: victim's gone, another member's mark survives.
  assert(!(await getDocRest(`vault/e1/marks/ch1__${UID}`)), "victim vault mark remains");
  assert(await getDocRest(`vault/e1/marks/ch1__${OTHER}`), "other's vault mark lost");
  // Star tallies recomputed from surviving reviews (other's rating 4 only).
  const f = fieldsOf(entry);
  assert(f.reviewCount?.integerValue === "1", `reviewCount not recomputed: ${JSON.stringify(f.reviewCount)}`);
  assert(f.ratingSum?.integerValue === "4", `ratingSum not recomputed: ${JSON.stringify(f.ratingSum)}`);
});

await test("vault activity: victim entries deleted, others survive", async () => {
  assert(!(await getDocRest("vaultActivity/v1")), "victim vault activity remains");
  assert(await getDocRest("vaultActivity/v2"), "other's vault activity wrongly deleted");
});

await test("push receipt queue: victim's token gone, other's survives", async () => {
  assert(!(await getDocRest("pushReceiptQueue/t-victim")), "victim receipt doc remains");
  assert(await getDocRest("pushReceiptQueue/t-other"), "other's receipt doc wrongly deleted");
});

await test("storage: victim prefixes empty, other's files survive", async () => {
  assert((await listObjects(`users/${UID}/`)).length === 0, "users/ objects remain");
  assert((await listObjects(`targetTickets/${UID}/`)).length === 0, "targetTickets/ objects remain");
  assert((await listObjects(`users/${OTHER}/`)).length === 1, "other's user object lost");
  assert((await listObjects(`targetTickets/${OTHER}/`)).length === 1, "other's ticket object lost");
});

await test("storage: chat media cleaned up sender-bound", async () => {
  assert((await listObjects(`chatMedia/${UID}/`)).length === 0, "victim chatMedia objects remain");
  const others = await listObjects(`chatMedia/${OTHER}/`);
  assert(!others.includes(`chatMedia/${OTHER}/gone.gif`), "torn-down conversation attachment remains");
  assert(others.includes(`chatMedia/${OTHER}/live.gif`), "live-message attachment wrongly deleted");
});

await test("global sweep: no document anywhere still references the uid", async () => {
  // Walk every seeded top-level collection tree and grep the raw JSON.
  const roots = [
    "users", "notifications", "blackBook", "issuedItems", "targetTickets",
    "conversations", "tableMessages", "vaultActivity", "sessions",
    "voicePresence", "vault", "bookReviews", "dealActivity", "dealAwards",
    "dealMemberStats", "dealCompletions", "deals", "suitAssignments",
    "activityEvents", "investigationEvents",
  ];
  const queue = roots.map((r) => r);
  const subMap = {
    targetTickets: ["comments"], conversations: ["messages"],
    tableMessages: ["messages"], notifications: ["items"],
    blackBook: ["entries"], issuedItems: ["records"], sessions: ["logs"],
    voicePresence: ["members"],
    vault: ["comments", "reviews"],
    dealActivity: ["events"], dealAwards: ["items"], dealCompletions: ["members"],
  };
  const offenders = [];
  async function scan(collPath, top) {
    for (const d of await listRest(collPath)) {
      const rel = d.name.slice(d.name.indexOf("/documents/") + "/documents/".length);
      if (d.fields && JSON.stringify(d.fields).includes(`"${UID}"`) && rel !== `users/${UID}`) {
        offenders.push(rel);
      }
      if (rel !== `users/${UID}` && rel.split("/")[1] === UID && d.fields) offenders.push(rel);
      for (const sub of subMap[top] ?? []) await scan(`${rel}/${sub}`, top);
    }
  }
  for (const root of queue) await scan(root, root);
  // Ante boards live one level down.
  for (const board of ["place", "raised"]) {
    for (const d of await listRest(`antePosts/${board}/posts`)) {
      const rel = d.name.slice(d.name.indexOf("/documents/") + "/documents/".length);
      if (d.fields && JSON.stringify(d.fields).includes(`"${UID}"`)) offenders.push(rel);
      for (const c of await listRest(`${rel}/comments`)) {
        if (c.fields && JSON.stringify(c.fields).includes(`"${UID}"`)) offenders.push(rel + "/comments");
      }
    }
  }
  assert(offenders.length === 0, `uid still referenced in: ${offenders.join(", ")}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
