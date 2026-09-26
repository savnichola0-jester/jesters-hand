// One-time, explicitly scoped live-content replacement. Defaults to dry-run.
// Keeps previous objects and writes a local metadata backup before --apply.
import { build } from "esbuild";
import { Storage } from "@google-cloud/storage";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const apply = process.argv.includes("--apply");
const project = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
if (!project) throw new Error("Firebase project is not configured");

const source = {
  book: resolve("attached_assets/Ebook.docx_1790415101293.epub"),
  blueprint: resolve("attached_assets/Jesters_Whisper_Blueprint.docx_1790415131856.pdf"),
  cover: resolve("attached_assets/18054_1790415101292.png"),
};
const bytes = Object.fromEntries(
  Object.entries(source).map(([key, path]) => [key, readFileSync(path)]),
);
if (!bytes.book.subarray(0, 2).equals(Buffer.from("PK")) ||
    !bytes.blueprint.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
    !bytes.cover.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
  throw new Error("One of the attachments is not the expected EPUB, PDF, or PNG");
}

const bundled = await build({
  entryPoints: [new URL("../src/lib/firestoreAdmin.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "quiet-content-maintenance",
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
if (!oauth) throw new Error("Firebase admin access is not configured");
const base = firestoreBase(project);
const headers = { Authorization: `Bearer ${oauth}`, "Content-Type": "application/json" };

const targets = [
  { id: "C34jzVg0e9a9SVdeJqbL", title: "Jester's Whisper", section: "stack",
    sourceKey: "book", filename: "Jesters-Whisper.epub", type: "application/epub+zip" },
  { id: "qmSrdKMczZWvBXa0HIEl", title: "Jester's Whisper Blueprint", section: "margins",
    sourceKey: "blueprint", filename: "Jesters-Whisper-Blueprint.pdf", type: "application/pdf" },
];
const entries = await Promise.all(targets.map(async (target) => {
  const response = await fetch(`${base}/vault/${target.id}`, { headers });
  if (!response.ok) throw new Error(`Cannot read ${target.title} (${response.status})`);
  const doc = await response.json();
  if (doc.fields?.title?.stringValue !== target.title ||
      doc.fields?.section?.stringValue !== target.section ||
      doc.fields?.status?.stringValue !== "published" || !doc.updateTime) {
    throw new Error(`Live Vault entry ${target.id} changed; refusing replacement`);
  }
  return doc;
}));
console.log("Verified published Vault book and Chamber blueprint; prior objects will be retained.");
if (!apply) {
  console.log("Dry run: EPUB, PDF, cover and live entry identities verified. Pass --apply to stage and switch.");
  process.exit(0);
}

const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
const privateDir = process.env.PRIVATE_OBJECT_DIR;
if (!bucketId || !privateDir || privateDir.split("/").filter(Boolean)[0] !== bucketId) {
  throw new Error("App Storage bucket configuration is inconsistent");
}
const prefix = privateDir.split("/").filter(Boolean).slice(1).join("/");
const objectName = (path) => `${prefix ? `${prefix}/` : ""}${path}`;
const sidecar = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${sidecar}/token`,
    type: "external_account",
    credential_source: {
      url: `${sidecar}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});
const bucket = storage.bucket(bucketId);
const version = `${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`;
const staged = targets.flatMap((target) => [
  {
    path: `vault/${target.id}/file-${version}`,
    body: bytes[target.sourceKey],
    type: target.type,
  },
  {
    path: `vault/${target.id}/cover-${version}`,
    body: bytes.cover,
    type: "image/png",
  },
]);

// Backup just the two original Firestore documents, not OAuth credentials or
// media read tokens. Do this before writing any files or changing pointers.
mkdirSync(".agents/outputs", { recursive: true });
const backupPath = `.agents/outputs/whisper-vault-backup-${version}.json`;
writeFileSync(backupPath, JSON.stringify(entries, null, 2), { mode: 0o600, flag: "wx" });
const uploaded = [];
let committed = false;
try {
  for (const item of staged) {
    const file = bucket.file(objectName(item.path));
    await file.save(item.body, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: item.type, cacheControl: "private, no-store" },
    });
    uploaded.push(file);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) !== item.body.length) throw new Error("Uploaded object size mismatch");
  }

  const string = (value) => ({ stringValue: value });
  const versionPaths = (id) => ({
    file: `vault/${id}/file-${version}`,
    cover: `vault/${id}/cover-${version}`,
  });
  const writes = targets.map((target, index) => {
    const paths = versionPaths(target.id);
    const fields = {
      filePath: string(paths.file),
      fileStorage: string("replit"),
      fileName: string(target.filename),
      contentType: string(target.type),
      coverPath: string(paths.cover),
      coverStorage: string("replit"),
    };
    const fieldPaths = [...Object.keys(fields), "chapters"];
    if (target.section === "margins") {
      const normalized = "black and purple";
      fields.decoderHash = string(createHash("sha256").update(normalized).digest("hex"));
      fieldPaths.push("decoderHash");
    }
    return {
      update: { name: entries[index].name, fields },
      updateMask: { fieldPaths },
      currentDocument: { updateTime: entries[index].updateTime },
      updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
    };
  });
  const response = await fetch(`${base}:commit`, {
    method: "POST", headers, body: JSON.stringify({ writes }),
  });
  if (!response.ok) throw new Error(`Atomic pointer switch failed (${response.status}): ${(await response.text()).slice(0, 220)}`);
  committed = true;
  for (const target of targets) {
    const response = await fetch(`${base}/vault/${target.id}`, { headers });
    const doc = await response.json();
    if (doc.fields?.filePath?.stringValue !== versionPaths(target.id).file ||
        doc.fields?.coverPath?.stringValue !== versionPaths(target.id).cover) {
      throw new Error(`Post-commit verification failed for ${target.title}; backup: ${backupPath}`);
    }
  }
  console.log(`Both live entries now point to the new book/blueprint and cover. Backup: ${backupPath}`);
} catch (error) {
  if (!committed) {
    for (const file of uploaded) await file.delete({ ignoreNotFound: true }).catch(() => {});
  }
  throw error;
}