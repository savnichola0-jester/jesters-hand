// One-time Books pointer switch after Android confirms the EPUB-capable update.
// Dry-run by default. Never deletes the previous Firebase file or staged object.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Storage } from "@google-cloud/storage";

const entryId = "C34jzVg0e9a9SVdeJqbL";
const backupPath = process.argv[2];
const stagedPath = process.argv[3];
const apply = process.argv.includes("--apply");
if (!backupPath || !stagedPath || !new RegExp(`^vault/${entryId}/file-[a-z0-9-]+$`).test(stagedPath)) {
  throw new Error("Usage: node activate-staged-vault-book.mjs <original-backup.json> <staged-file-path> [--apply]");
}

const original = JSON.parse(readFileSync(backupPath, "utf8"))
  .find((entry) => entry.name?.endsWith(`/vault/${entryId}`));
assert.equal(original?.fields?.title?.stringValue, "Jester's Whisper");
const epub = readFileSync(resolve("attached_assets/Ebook.docx_1790415101293.epub"));
assert.ok(epub.subarray(0, 2).equals(Buffer.from("PK")), "Attached book is not an EPUB archive");

const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
const privateDir = process.env.PRIVATE_OBJECT_DIR;
if (!project || !bucketId || privateDir?.split("/").filter(Boolean)[0] !== bucketId) {
  throw new Error("Firebase or App Storage configuration is unavailable");
}
const prefix = privateDir.split("/").filter(Boolean).slice(1).join("/");
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});
const file = storage.bucket(bucketId).file(`${prefix ? `${prefix}/` : ""}${stagedPath}`);
const [metadata] = await file.getMetadata();
assert.equal(Number(metadata.size), epub.length, "Staged EPUB size does not match the supplied book");
assert.equal(metadata.contentType, "application/epub+zip", "Staged object is not marked as EPUB");
const [storedBytes] = await file.download();
assert.equal(
  createHash("sha256").update(storedBytes).digest("hex"),
  createHash("sha256").update(epub).digest("hex"),
  "Staged EPUB differs from the supplied book",
);

const bundled = await build({
  entryPoints: [new URL("../src/lib/firestoreAdmin.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "quiet-book-maintenance",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/logger$/ }, () => ({ path: "logger", namespace: "quiet" }));
      builder.onLoad({ filter: /.*/, namespace: "quiet" }, () => ({
        contents: "export const logger = { warn() {} };", loader: "js",
      }));
    },
  }],
});
const { getAccessToken, firestoreBase } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`
);
const oauth = await getAccessToken();
if (!oauth) throw new Error("Firebase admin access is unavailable");
const base = firestoreBase(project);
const url = `${base}/vault/${entryId}`;
const headers = { Authorization: `Bearer ${oauth}`, "Content-Type": "application/json" };
const response = await fetch(url, { headers });
if (!response.ok) throw new Error(`Live book read failed (${response.status})`);
const current = await response.json();
const fields = current.fields ?? {};
assert.equal(fields.title?.stringValue, "Jester's Whisper");
assert.equal(fields.section?.stringValue, "stack");
assert.equal(fields.status?.stringValue, "published");
assert.equal(fields.coverStorage?.stringValue, "replit");
assert.equal(fields.filePath?.stringValue, original.fields.filePath.stringValue,
  "Book file pointer changed since the compatibility backup");
assert.equal(fields.fileStorage?.stringValue, original.fields.fileStorage?.stringValue,
  "Book storage provider changed since the compatibility backup");
assert.ok(current.updateTime);
console.log("Verified live legacy book and staged EPUB bytes; old original will be retained.");
if (!apply) {
  console.log("Dry run only. Pass --apply to activate the staged EPUB.");
  process.exit(0);
}

mkdirSync(".agents/outputs", { recursive: true });
const savePath = `.agents/outputs/book-before-epub-${Date.now()}.json`;
writeFileSync(savePath, JSON.stringify(current, null, 2), { mode: 0o600, flag: "wx" });
const string = (value) => ({ stringValue: value });
const commit = await fetch(`${base}:commit`, {
  method: "POST", headers,
  body: JSON.stringify({ writes: [{
    update: {
      name: current.name,
      fields: {
        filePath: string(stagedPath),
        fileStorage: string("replit"),
        fileName: string("Jesters-Whisper.epub"),
        contentType: string("application/epub+zip"),
      },
    },
    updateMask: { fieldPaths: ["filePath", "fileStorage", "fileName", "contentType", "chapters"] },
    currentDocument: { updateTime: current.updateTime },
    updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
  }] }),
});
if (!commit.ok) throw new Error(`Atomic book pointer switch failed (${commit.status}); backup: ${savePath}`);
const verifyResponse = await fetch(url, { headers });
if (!verifyResponse.ok) throw new Error(`Post-switch read failed (${verifyResponse.status}); backup: ${savePath}`);
const verified = await verifyResponse.json();
if (verified.fields?.filePath?.stringValue !== stagedPath ||
    verified.fields?.fileStorage?.stringValue !== "replit" ||
    verified.fields?.contentType?.stringValue !== "application/epub+zip") {
  throw new Error(`Post-switch book metadata mismatch; backup: ${savePath}`);
}
console.log(`Books now points to the staged EPUB. Previous metadata backed up at ${savePath}`);