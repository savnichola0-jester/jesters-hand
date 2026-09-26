// One-off authenticated App Storage smoke check. Always clean up the
// temporary Firebase account, Firestore profile, and uploaded object.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const key = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
assert.ok(key && project, "Firebase project env is required");
const origin = (process.env.MEDIA_SMOKE_ORIGIN ?? "http://localhost:80").replace(/\/$/, "");
const kind = process.env.MEDIA_SMOKE_KIND ?? "mug";
assert.ok(["mug", "chat", "target"].includes(kind), "unsupported smoke kind");
const chat = kind === "chat";
const suffix = randomBytes(9).toString("hex");
const email = `media-smoke-${suffix}@jestershand.local`;
const password = randomBytes(30).toString("base64url");
let idToken, uid, path;
const profileUrl = () =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/users/${uid}`;
async function jsonResponse(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`Smoke HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}
try {
  const signUp = await jsonResponse(await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  ));
  idToken = signUp.idToken;
  uid = signUp.localId;
  assert.ok(idToken && uid);
  await jsonResponse(await fetch(profileUrl(), {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      jokerId: { stringValue: "54-54" },
      name: { stringValue: "Storage Smoke" },
    } }),
  }));
  path = chat
    ? `chatMedia/${uid}/${Date.now().toString(36)}-${suffix.slice(0, 8)}.gif`
    : kind === "target"
      ? `targetTickets/${uid}/${Date.now()}_${suffix}.jpg`
      : `users/${uid}/mug-${Date.now().toString(36)}-${suffix}.jpg`;
  const image = chat
    ? Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64")
    : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xXcAAAAASUVORK5CYII=", "base64");
  const upload = await jsonResponse(await fetch(
    `${origin}/api/media/upload?path=${encodeURIComponent(path)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": chat ? "image/gif" : "image/png" },
      body: image,
    },
  ));
  assert.equal(upload.path, path);
  assert.ok(upload.url?.startsWith(`jhmedia://${path}?token=`));
  const publicUrl = `${origin}/api/media/public/${encodeURIComponent(path)}?${upload.url.split("?")[1]}`;
  const wrongToken = await fetch(`${origin}/api/media/public/${encodeURIComponent(path)}?token=wrong`);
  assert.equal(wrongToken.status, 404);
  const downloaded = await fetch(publicUrl);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), image);
  console.info("PASS: authenticated upload, opaque URL, denied bad token, byte-identical download");
} finally {
  if (path && idToken) {
    const deleted = await fetch(`${origin}/api/media/object?path=${encodeURIComponent(path)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${idToken}` },
    });
    if (deleted.status !== 204) console.error(`Cleanup: object DELETE returned ${deleted.status}`);
  }
  if (uid && idToken) {
    const deleted = await fetch(profileUrl(), {
      method: "DELETE", headers: { Authorization: `Bearer ${idToken}` },
    });
    if (deleted.status !== 200) console.error(`Cleanup: Firestore DELETE returned ${deleted.status}`);
    const authDeleted = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!authDeleted.ok) console.error(`Cleanup: Firebase Auth DELETE returned ${authDeleted.status}`);
  }
}