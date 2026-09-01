// Storage rules tests for Vault privacy + users/ + targetTickets/ paths.
// Run with: firebase emulators:exec --only firestore,storage --project demo-rules-test "node scripts/storage-rules-test.mjs"
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { setDoc, doc } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';

const env = await initializeTestEnvironment({
  projectId: 'demo-rules-test',
  firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  storage: { rules: readFileSync('storage.rules', 'utf8') },
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const bytes = new Uint8Array([1, 2, 3, 4]);

// Seed Firestore state that storage.rules cross-service reads depend on,
// and pre-place storage objects for read tests.
await env.clearFirestore();
await env.clearStorage();
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'users/admin'), { isAdmin: true });
  // The second Hand: full admin EXCEPT Vault/Chamber document curation.
  await setDoc(doc(db, 'users/deputy'), { isAdmin: true, vaultKeeper: false });
  await setDoc(doc(db, 'users/alice'), { isAdmin: false });
  await setDoc(doc(db, 'users/bob'), { isAdmin: false });
  await setDoc(doc(db, 'vault/pub1'), {
    status: 'published', title: 'Pub',
    filePath: 'vault/pub1/file', coverPath: 'vault/pub1/cover',
  });
  await setDoc(doc(db, 'vault/hid1'), {
    status: 'hidden', title: 'Hid',
    filePath: 'vault/hid1/file', coverPath: 'vault/hid1/cover',
  });
  await setDoc(doc(db, 'vault/arc1'), {
    status: 'archived', title: 'Arc',
    filePath: 'vault/arc1/file', coverPath: 'vault/arc1/cover',
  });
  await setDoc(doc(db, 'vault/pubv'), {
    status: 'published', title: 'Versioned',
    filePath: 'vault/pubv/file-new-b2', coverPath: 'vault/pubv/cover',
  });
});
await env.withSecurityRulesDisabled(async ctx => {
  const st = ctx.storage();
  for (const entry of ['pub1', 'hid1', 'arc1']) {
    await uploadBytes(ref(st, `vault/${entry}/file`), bytes);
    await uploadBytes(ref(st, `vault/${entry}/cover`), bytes);
  }
  await uploadBytes(ref(st, 'vault/pubv/file-old-a1'), bytes);
  await uploadBytes(ref(st, 'vault/pubv/file-new-b2'), bytes);
  await uploadBytes(ref(st, 'vault/pub1/extra'), bytes);
  await uploadBytes(ref(st, 'users/alice/mug.jpg'), bytes);
  await uploadBytes(ref(st, 'targetTickets/alice/spread.jpg'), bytes);
});

const admin = () => env.authenticatedContext('admin').storage();
const deputy = () => env.authenticatedContext('deputy').storage();
const alice = () => env.authenticatedContext('alice').storage();
const bob   = () => env.authenticatedContext('bob').storage();
const anon = () => env.unauthenticatedContext().storage();

// ---- Vault reads --------------------------------------------------------

await test('member can read published vault file and cover', async () => {
  await assertSucceeds(getBytes(ref(alice(), 'vault/pub1/file')));
  await assertSucceeds(getBytes(ref(alice(), 'vault/pub1/cover')));
});

await test('member cannot read hidden vault files', async () => {
  await assertFails(getBytes(ref(alice(), 'vault/hid1/file')));
  await assertFails(getBytes(ref(alice(), 'vault/hid1/cover')));
});

await test('member cannot read archived vault files', async () => {
  await assertFails(getBytes(ref(alice(), 'vault/arc1/file')));
  await assertFails(getBytes(ref(alice(), 'vault/arc1/cover')));
});

await test('admin can read vault files regardless of status', async () => {
  await assertSucceeds(getBytes(ref(admin(), 'vault/pub1/file')));
  await assertSucceeds(getBytes(ref(admin(), 'vault/hid1/file')));
  await assertSucceeds(getBytes(ref(admin(), 'vault/arc1/cover')));
});

await test('signed-out users cannot read any vault file', async () => {
  await assertFails(getBytes(ref(anon(), 'vault/pub1/file')));
  await assertFails(getBytes(ref(anon(), 'vault/pub1/cover')));
});

await test('vault file for nonexistent entry is unreadable by members', async () => {
  // Cross-service get on a missing doc must not grant access.
  await assertFails(getBytes(ref(alice(), 'vault/ghost/file')));
});

// ---- Vault object-name restriction --------------------------------------

await test('only active file/cover object names are readable, even when published', async () => {
  await assertFails(getBytes(ref(alice(), 'vault/pub1/extra')));
  await assertFails(getBytes(ref(admin(), 'vault/pub1/extra')));
});

await test('stale readers cannot fetch the previous manuscript after the pointer switches', async () => {
  await assertSucceeds(getBytes(ref(alice(), 'vault/pubv/file-new-b2')));
  await assertFails(getBytes(ref(alice(), 'vault/pubv/file-old-a1')));
  await assertFails(getBytes(ref(admin(), 'vault/pubv/file-old-a1')));
});

await test('admin cannot write vault objects outside file/cover version names', async () => {
  await assertFails(uploadBytes(ref(admin(), 'vault/pub1/sneaky'), bytes));
});

// ---- Vault writes --------------------------------------------------------

await test('admin can write vault file and cover', async () => {
  await assertSucceeds(uploadBytes(ref(admin(), 'vault/new1/file'), bytes));
  await assertSucceeds(uploadBytes(ref(admin(), 'vault/new1/file-abc-123')));
  await assertSucceeds(uploadBytes(ref(admin(), 'vault/new1/cover'), bytes));
});

await test('second Hand (vaultKeeper:false) cannot write or delete vault files but writes recruit photos', async () => {
  await assertFails(uploadBytes(ref(deputy(), 'vault/newd/file'), bytes));
  await assertFails(uploadBytes(ref(deputy(), 'vault/pub1/cover'), bytes));
  await assertFails(deleteObject(ref(deputy(), 'vault/arc1/file')));
  // Reads still work like any admin.
  await assertSucceeds(getBytes(ref(deputy(), 'vault/hid1/file')));
  // Verdict/Recruit photo uploads remain allowed.
  await assertSucceeds(uploadBytes(ref(deputy(), 'recruitPosts/rdep/img_dep1'), bytes));
});

await test('member cannot write vault files (even for published entries)', async () => {
  await assertFails(uploadBytes(ref(alice(), 'vault/pub1/file'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'vault/new2/file'), bytes));
});

await test('member cannot delete vault files', async () => {
  await assertFails(deleteObject(ref(alice(), 'vault/pub1/file')));
});

await test('signed-out users cannot write vault files', async () => {
  await assertFails(uploadBytes(ref(anon(), 'vault/pub1/file'), bytes));
});

// ---- users/ path ---------------------------------------------------------

await test('signed-in member can read another member photo', async () => {
  await assertSucceeds(getBytes(ref(admin(), 'users/alice/mug.jpg')));
  await assertSucceeds(getBytes(ref(alice(), 'users/alice/mug.jpg')));
});

await test('signed-out users cannot read member photos', async () => {
  await assertFails(getBytes(ref(anon(), 'users/alice/mug.jpg')));
});

await test('member can upload own photo; admin can upload for others', async () => {
  const img = { contentType: 'image/jpeg' };
  await assertSucceeds(uploadBytes(ref(alice(), 'users/alice/mug.jpg'), bytes, img));
  await assertSucceeds(uploadBytes(ref(admin(), 'users/alice/admin.jpg'), bytes, img));
  // The admin portrait can only be written by the Jester — not the member.
  await assertFails(uploadBytes(ref(alice(), 'users/alice/admin.jpg'), bytes, img));
});

await test('member photos: only mug/admin names, images only', async () => {
  const img = { contentType: 'image/jpeg' };
  // Arbitrary object names are rejected even for owner/admin.
  await assertFails(uploadBytes(ref(alice(), 'users/alice/new.jpg'), bytes, img));
  await assertFails(uploadBytes(ref(admin(), 'users/alice/portrait.jpg'), bytes, img));
  // Non-image content is rejected.
  await assertFails(uploadBytes(ref(alice(), 'users/alice/mug.jpg'), bytes, { contentType: 'application/octet-stream' }));
  // Owner can still delete their mug (Go Dark).
  await assertSucceeds(deleteObject(ref(alice(), 'users/alice/mug.jpg')));
});

await test('chat media: own folder only, images only', async () => {
  const img = { contentType: 'image/gif' };
  await assertSucceeds(uploadBytes(ref(alice(), 'chatMedia/alice/123.gif'), bytes, img));
  await assertSucceeds(getBytes(ref(admin(), 'chatMedia/alice/123.gif')));
  await assertFails(uploadBytes(ref(alice(), 'chatMedia/admin/123.gif'), bytes, img));
  await assertFails(uploadBytes(ref(alice(), 'chatMedia/alice/x.bin'), bytes, { contentType: 'application/octet-stream' }));
  await assertFails(getBytes(ref(anon(), 'chatMedia/alice/123.gif')));
});

await test('chat media: owner and admin can delete, others cannot', async () => {
  const img = { contentType: 'image/gif' };
  // Another member can never delete someone else's attachment.
  await assertFails(deleteObject(ref(bob(), 'chatMedia/alice/123.gif')));
  // Sender deletes their own attachment (whisper message delete).
  await assertSucceeds(deleteObject(ref(alice(), 'chatMedia/alice/123.gif')));
  // Admin deletes another member's attachment (admin-deleted message / purge).
  await assertSucceeds(uploadBytes(ref(alice(), 'chatMedia/alice/456.gif'), bytes, img));
  await assertSucceeds(deleteObject(ref(admin(), 'chatMedia/alice/456.gif')));
});

await test('member cannot upload into another member folder', async () => {
  await assertFails(uploadBytes(ref(alice(), 'users/admin/mug.jpg'), bytes, { contentType: 'image/jpeg' }));
});

// ---- targetTickets/ path ---------------------------------------------------

await test('signed-in member can read spread photos', async () => {
  await assertSucceeds(getBytes(ref(admin(), 'targetTickets/alice/spread.jpg')));
});

await test('member can upload own spread photo only', async () => {
  await assertSucceeds(uploadBytes(ref(alice(), 'targetTickets/alice/s2.jpg'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'targetTickets/admin/s3.jpg'), bytes));
});

await test('signed-out users cannot touch spread photos', async () => {
  await assertFails(getBytes(ref(anon(), 'targetTickets/alice/spread.jpg')));
  await assertFails(uploadBytes(ref(anon(), 'targetTickets/anon/x.jpg'), bytes));
});

// ---- Recruit post photos -------------------------------------------------

await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'recruitPosts/rpub'), { status: 'published', title: 'P' });
  await setDoc(doc(ctx.firestore(), 'recruitPosts/rdraft'), { status: 'draft', title: 'D' });
  const st = ctx.storage();
  await uploadBytes(ref(st, 'recruitPosts/rpub/img_abc123'), bytes);
  await uploadBytes(ref(st, 'recruitPosts/rdraft/img_abc123'), bytes);
  await uploadBytes(ref(st, 'recruitPosts/rpub/sneaky.txt'), bytes);
});

await test('members read photos of published recruit posts only', async () => {
  await assertSucceeds(getBytes(ref(alice(), 'recruitPosts/rpub/img_abc123')));
  await assertFails(getBytes(ref(alice(), 'recruitPosts/rdraft/img_abc123')));
  await assertFails(getBytes(ref(anon(), 'recruitPosts/rpub/img_abc123')));
  await assertFails(getBytes(ref(alice(), 'recruitPosts/rpub/sneaky.txt')));
});

await test('only admin writes recruit photos, img_ names only', async () => {
  await assertSucceeds(uploadBytes(ref(admin(), 'recruitPosts/rdraft/img_zz9'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'recruitPosts/rpub/img_zz9'), bytes));
  await assertFails(uploadBytes(ref(admin(), 'recruitPosts/rpub/evil.png'), bytes));
  await assertSucceeds(getBytes(ref(admin(), 'recruitPosts/rdraft/img_abc123')));
});

// ---- Armory product photos -------------------------------------------------

await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'armoryProducts/aprod'), { name: 'Jacket', category: 'Apparel' });
  const st = ctx.storage();
  await uploadBytes(ref(st, 'armoryProducts/aprod/photo'), bytes);
  await uploadBytes(ref(st, 'armoryProducts/aprod/sneaky.txt'), bytes);
  await uploadBytes(ref(st, 'armoryProducts/ghost/photo'), bytes);
});

await test('members read photos of existing products only; photo name only', async () => {
  await assertSucceeds(getBytes(ref(alice(), 'armoryProducts/aprod/photo')));
  await assertFails(getBytes(ref(alice(), 'armoryProducts/ghost/photo')));
  await assertFails(getBytes(ref(alice(), 'armoryProducts/aprod/sneaky.txt')));
  await assertFails(getBytes(ref(anon(), 'armoryProducts/aprod/photo')));
  await assertSucceeds(getBytes(ref(admin(), 'armoryProducts/ghost/photo')));
});

await test('only admin writes armory photos, photo name only', async () => {
  await assertSucceeds(uploadBytes(ref(admin(), 'armoryProducts/newprod/photo'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'armoryProducts/aprod/photo'), bytes));
  await assertFails(uploadBytes(ref(admin(), 'armoryProducts/aprod/evil.png'), bytes));
  await assertFails(uploadBytes(ref(anon(), 'armoryProducts/aprod/photo'), bytes));
});

// ---- Report evidence ------------------------------------------------------

await test('member can upload report evidence under own uid only', async () => {
  await assertSucceeds(uploadBytes(ref(alice(), 'reports/alice/r9/img_0'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'reports/bob/r9/img_0'), bytes));
  await assertFails(uploadBytes(ref(anon(), 'reports/alice/r9/img_1'), bytes));
  await assertFails(uploadBytes(ref(alice(), 'reports/alice/r9/evil.txt'), bytes));
});

await test('report evidence readable only by admin; immutable for members', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await uploadBytes(ref(ctx.storage(), 'reports/alice/r1/img_0'), bytes);
  });
  await assertSucceeds(getBytes(ref(admin(), 'reports/alice/r1/img_0')));
  await assertFails(getBytes(ref(alice(), 'reports/alice/r1/img_0')));
  await assertFails(uploadBytes(ref(alice(), 'reports/alice/r1/img_0'), bytes));
  await assertFails(deleteObject(ref(alice(), 'reports/alice/r1/img_0')));
  await assertSucceeds(deleteObject(ref(admin(), 'reports/alice/r1/img_0')));
});

// ---- Suspension ------------------------------------------------------------

await env.withSecurityRulesDisabled(async ctx => {
  await setDoc(doc(ctx.firestore(), 'users/sue'), { jokerId: '07-07', suspended: true });
});
const sue = () => env.authenticatedContext('sue').storage();

await test('suspended member cannot read vault, member photos, or product photos', async () => {
  await assertFails(getBytes(ref(sue(), 'vault/pub1/file')));
  await assertFails(getBytes(ref(sue(), 'vault/pub1/cover')));
  await assertFails(getBytes(ref(sue(), 'users/alice/mug.jpg')));
  await assertFails(getBytes(ref(sue(), 'targetTickets/alice/spread.jpg')));
  await assertFails(getBytes(ref(sue(), 'recruitPosts/rpub/img_abc123')));
  await assertFails(getBytes(ref(sue(), 'armoryProducts/aprod/photo')));
});

await test('suspended member cannot write anywhere', async () => {
  await assertFails(uploadBytes(ref(sue(), 'users/sue/mug.jpg'), bytes));
  await assertFails(uploadBytes(ref(sue(), 'targetTickets/sue/s1.jpg'), bytes));
});

await test('non-suspended member with a user doc still reads normally', async () => {
  await assertSucceeds(getBytes(ref(alice(), 'vault/pub1/file')));
});

// ---- catch-all -----------------------------------------------------------

await test('unknown top-level paths are fully locked down', async () => {
  await assertFails(uploadBytes(ref(admin(), 'random/thing.txt'), bytes));
  await assertFails(getBytes(ref(alice(), 'random/thing.txt')));
});

await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
