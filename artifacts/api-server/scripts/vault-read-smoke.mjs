// Read-only live Vault media smoke check with a temporary active member.
// Removes the test profile and Auth account in finally.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const key = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const origin = process.env.MEDIA_SMOKE_ORIGIN;
assert.ok(key && project && origin, "Firebase and MEDIA_SMOKE_ORIGIN are required");
const suffix = randomBytes(10).toString("hex");
let idToken, uid;
const idt = `https://identitytoolkit.googleapis.com/v1/accounts`;
const fs = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
async function json(res) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}
try {
  const signedUp = await json(await fetch(`${idt}:signUp?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `vault-read-smoke-${suffix}@jestershand.local`,
      password: randomBytes(30).toString("base64url"),
      returnSecureToken: true,
    }),
  }));
  ({ idToken, localId: uid } = signedUp);
  assert.ok(idToken && uid);
  const auth = { Authorization: `Bearer ${idToken}` };
  await json(await fetch(`${fs}/users/${uid}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      jokerId: { stringValue: "54-54" },
      name: { stringValue: "Vault Read Smoke" },
    } }),
  }));
  for (const [entryId, type, fields] of [
    ["C34jzVg0e9a9SVdeJqbL", "EPUB book", ["filePath", "coverPath"]],
    ["qmSrdKMczZWvBXa0HIEl", "PDF", ["filePath", "coverPath"]],
  ]) {
    const entry = await json(await fetch(`${fs}/vault/${entryId}`, { headers: auth }));
    assert.equal(entry.fields.status.stringValue, "published");
    for (const field of fields) {
      const path = entry.fields[field]?.stringValue;
      assert.ok(path?.startsWith(`vault/${entryId}/`));
      const res = await fetch(`${origin}/api/media/private?path=${encodeURIComponent(path)}`, {
        headers: auth,
      });
      if (!res.ok) throw new Error(`${type} ${field} read failed (${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.ok(bytes.length > 1000, `${type} ${field} was unexpectedly small`);
      if (field === "filePath") {
        if (type === "EPUB book") {
          assert.equal(entry.fields.fileStorage?.stringValue, "replit");
          assert.equal(entry.fields.contentType?.stringValue, "application/epub+zip");
          assert.ok(bytes.subarray(0, 2).equals(Buffer.from("PK")));
        } else {
          assert.ok(bytes.subarray(0, 5).equals(Buffer.from("%PDF-")));
        }
      } else {
        assert.ok(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
      }
    }
    console.log(`PASS: ${type} media readable by an active member`);
  }
} finally {
  if (uid && idToken) {
    const auth = { Authorization: `Bearer ${idToken}` };
    const profile = await fetch(`${fs}/users/${uid}`, { method: "DELETE", headers: auth });
    if (profile.status !== 200) console.error(`Cleanup: profile DELETE returned ${profile.status}`);
    const account = await fetch(`${idt}:delete?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    if (!account.ok) console.error(`Cleanup: account DELETE returned ${account.status}`);
  }
}