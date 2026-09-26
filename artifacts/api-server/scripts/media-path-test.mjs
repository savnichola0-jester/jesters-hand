import assert from "node:assert/strict";
import {
  isCurrentReplitVaultObject,
  isVaultCoverPath,
  validateMediaPath,
} from "../src/lib/mediaPaths.ts";
import {
  appStorageAttachmentPathFor,
  attachmentPathFor,
} from "../src/lib/chatMediaPath.ts";

assert.deepEqual(
  validateMediaPath("chatMedia/sender-1/mabc1234-k9x7p2q1.gif"),
  { kind: "chat-photo", uid: "sender-1" },
);
for (const path of [
  "chatMedia/sender-1/../private.gif",
  "chatMedia/sender-1/nested/photo.gif",
  "chatMedia/sender-1/mabc1234-k9x7p2q1.svg",
]) {
  assert.equal(validateMediaPath(path), null);
}

assert.equal(
  appStorageAttachmentPathFor("sender-1", "jhmedia://chatMedia/sender-1/photo.gif?token=opaque"),
  "chatMedia/sender-1/photo.gif",
);
assert.equal(
  appStorageAttachmentPathFor("sender-1", "jhmedia://chatMedia/victim/photo.gif?token=opaque"),
  null,
);
for (const invalid of [
  "jhmedia://chatMedia/sender-1/nested/photo.gif?token=opaque",
  "jhmedia://chatMedia/sender-1/photo.gif",
  "jhmedia://chatMedia/sender-1/photo.gif?token=",
  "https://example.test/chatMedia/sender-1/photo.gif?token=opaque",
]) {
  assert.equal(appStorageAttachmentPathFor("sender-1", invalid), null, invalid);
}
assert.equal(
  attachmentPathFor(
    "sender-1",
    "https://firebasestorage.googleapis.com/v0/b/bucket/o/chatMedia%2Fsender-1%2Fphoto.gif?alt=media",
  ),
  "chatMedia/sender-1/photo.gif",
);

assert.deepEqual(validateMediaPath("users/uid-1/mug.jpg"), {
  kind: "mug",
  uid: "uid-1",
});
assert.deepEqual(validateMediaPath("users/uid-1/admin.jpg"), {
  kind: "admin-photo",
  uid: "uid-1",
});
assert.deepEqual(validateMediaPath("users/uid-1/mug-mabc1234-k9x7p2q1.jpg"), {
  kind: "mug",
  uid: "uid-1",
});
assert.deepEqual(validateMediaPath("users/uid-1/admin-mabc1234-k9x7p2q1.jpg"), {
  kind: "admin-photo",
  uid: "uid-1",
});
assert.deepEqual(validateMediaPath("targetTickets/uid-1/1712345678901_a1b2c3.jpg"), {
  kind: "target-photo",
  uid: "uid-1",
});
assert.deepEqual(validateMediaPath("vault/entry_1/file-ab12-cd34"), {
  kind: "vault-file",
  entryId: "entry_1",
  fileName: "file-ab12-cd34",
});
assert.deepEqual(validateMediaPath("vault/entry_1/cover-mabc1234-k9x7p2q1"), {
  kind: "vault-file",
  entryId: "entry_1",
  fileName: "cover-mabc1234-k9x7p2q1",
});
const versionedCover = validateMediaPath("vault/entry_1/cover-mabc1234-k9x7p2q1");
assert.ok(versionedCover);
assert.equal(isVaultCoverPath(versionedCover), true);
assert.equal(isCurrentReplitVaultObject({
  coverPath: "vault/entry_1/cover-mabc1234-k9x7p2q1",
  coverStorage: "replit",
  filePath: "vault/entry_1/file",
  fileStorage: "replit",
}, versionedCover, "vault/entry_1/cover-mabc1234-k9x7p2q1"), true);
assert.equal(isCurrentReplitVaultObject({
  coverPath: "vault/entry_1/cover-mabc1234-k9x7p2q1",
  coverStorage: "firebase",
}, versionedCover, "vault/entry_1/cover-mabc1234-k9x7p2q1"), false);
for (const invalid of [
  "../users/uid-1/mug.jpg",
  "/users/uid-1/mug.jpg",
  "users/uid-1/other.jpg",
  "targetTickets/uid-1/not-random.jpg",
  "vault/entry/file/extra",
  "vault/entry/file-BAD-case",
  "vault/entry/cover-anything",
  "vault/entry/cover-mabc1234-k9x7p2q1/extra",
  "vault/entry%2Fother/file",
]) {
  assert.equal(validateMediaPath(invalid), null, invalid);
}