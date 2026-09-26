import { randomBytes, timingSafeEqual } from "node:crypto";
import { Storage, type File } from "@google-cloud/storage";
import { Router, type IRouter, type Request } from "express";
import { Transform } from "node:stream";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import {
  adminConfigured,
  firestoreBase,
  getAccessToken,
} from "../lib/firestoreAdmin";
import {
  isCurrentReplitVaultObject,
  isVaultCoverPath,
  validateMediaPath,
  type MediaPath,
} from "../lib/mediaPaths";

const router: IRouter = Router();
const SIDE_CAR = "http://127.0.0.1:1106";
const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${SIDE_CAR}/token`,
    type: "external_account",
    credential_source: {
      url: `${SIDE_CAR}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const CHAT_PHOTO_TYPES = new Set([...PHOTO_TYPES, "image/gif"]);
const VAULT_TYPES = new Set([
  ...PHOTO_TYPES,
  "application/pdf",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Android document providers sometimes omit a specific MIME type.
  "application/octet-stream",
  "text/plain",
]);
const PHOTO_LIMIT = 10 * 1024 * 1024;
const VAULT_LIMIT = 100 * 1024 * 1024;

type FirestoreValue = {
  booleanValue?: boolean;
  stringValue?: string;
};
type FirestoreDoc = { fields?: Record<string, FirestoreValue> };
type Actor = {
  uid: string;
  base: string;
  oauth: string;
  isHandAdmin: boolean;
  isKeeper: boolean;
};

function logicalPathParam(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    return value.join("/");
  }
  return null;
}

function pathQuery(req: Request): string | null {
  return typeof req.query.path === "string" ? req.query.path : null;
}

function bearer(req: Request): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  if (header.startsWith("Firebase ")) return header.slice(9).trim();
  return "";
}

async function readDocument(
  base: string,
  oauth: string,
  documentPath: string,
): Promise<FirestoreDoc | null> {
  const response = await fetch(`${base}/${documentPath}`, {
    headers: { Authorization: `Bearer ${oauth}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore read failed (${response.status})`);
  return await response.json() as FirestoreDoc;
}

async function actorFor(req: Request): Promise<Actor | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const idToken = bearer(req);
  const uid = project && idToken ? await verifyFirebaseIdToken(idToken, project) : null;
  const oauth = uid && adminConfigured() ? await getAccessToken() : null;
  if (!project || !uid || !oauth) return null;
  const base = firestoreBase(project);
  const user = await readDocument(base, oauth, `users/${encodeURIComponent(uid)}`);
  const fields = user?.fields;
  if (!fields || fields["suspended"]?.booleanValue === true) return null;
  const handAdmin =
    fields["isAdmin"]?.booleanValue === true &&
    ["00-00", "01-54"].includes(fields["jokerId"]?.stringValue ?? "");
  return {
    uid,
    base,
    oauth,
    isHandAdmin: handAdmin,
    isKeeper: handAdmin && fields["jokerId"]?.stringValue === "00-00",
  };
}

function mayWrite(path: MediaPath, actor: Actor): boolean {
  if (path.kind === "mug") return path.uid === actor.uid || actor.isHandAdmin;
  if (path.kind === "admin-photo") return actor.isHandAdmin;
  if (path.kind === "target-photo") return path.uid === actor.uid;
  if (path.kind === "chat-photo") return path.uid === actor.uid;
  return actor.isKeeper;
}

function mayDelete(path: MediaPath, actor: Actor): boolean {
  if (path.kind === "chat-photo") return path.uid === actor.uid || actor.isHandAdmin;
  if (path.kind === "mug" || path.kind === "target-photo") {
    return path.uid === actor.uid || actor.isHandAdmin;
  }
  if (path.kind === "admin-photo") return actor.isHandAdmin;
  return actor.isKeeper;
}

function privateObjectLocation(logicalPath: string): { bucket: string; name: string } {
  const bucket = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] ?? "";
  const privateDir = process.env["PRIVATE_OBJECT_DIR"] ?? "";
  if (!bucket || !privateDir) throw new Error("App Storage is not configured");
  const segments = privateDir.split("/").filter(Boolean);
  if (segments[0] !== bucket) throw new Error("PRIVATE_OBJECT_DIR bucket mismatch");
  const prefix = segments.slice(1).join("/");
  return { bucket, name: `${prefix ? `${prefix}/` : ""}${logicalPath}` };
}

function fileFor(path: string): File {
  const { bucket, name } = privateObjectLocation(path);
  return storage.bucket(bucket).file(name);
}

function uploadLimit(path: MediaPath): number {
  return path.kind === "vault-file" && !isVaultCoverPath(path)
    ? VAULT_LIMIT
    : PHOTO_LIMIT;
}

function allowedContentType(path: MediaPath, type: string): boolean {
  if (path.kind === "chat-photo") return CHAT_PHOTO_TYPES.has(type);
  if (path.kind === "vault-file") {
    return isVaultCoverPath(path) ? PHOTO_TYPES.has(type) : VAULT_TYPES.has(type);
  }
  return PHOTO_TYPES.has(type);
}

async function currentGeneration(file: File): Promise<string | null> {
  try {
    const [metadata] = await file.getMetadata();
    return metadata.generation == null ? null : String(metadata.generation);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 404) return null;
    throw error;
  }
}

async function checkVaultReadAccess(
  actor: Actor,
  path: MediaPath,
  logicalPath: string,
): Promise<boolean> {
  if (path.kind !== "vault-file") return false;
  const entry = await readDocument(
    actor.base,
    actor.oauth,
    `vault/${encodeURIComponent(path.entryId)}`,
  );
  if (!entry?.fields) return false;
  if (!isCurrentReplitVaultObject({
    filePath: entry.fields["filePath"]?.stringValue,
    fileStorage: entry.fields["fileStorage"]?.stringValue,
    coverPath: entry.fields["coverPath"]?.stringValue,
    coverStorage: entry.fields["coverStorage"]?.stringValue,
  }, path, logicalPath)) return false;
  return actor.isHandAdmin || entry.fields["status"]?.stringValue === "published";
}

function opaqueTokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.post("/media/upload", async (req, res) => {
  const path = pathQuery(req);
  const parsedPath = path ? validateMediaPath(path) : null;
  if (!path || !parsedPath) return void res.status(400).json({ error: "invalid media path" });
  const actor = await actorFor(req);
  if (!actor) return void res.status(403).json({ error: "active member required" });
  if (!mayWrite(parsedPath, actor)) return void res.status(403).json({ error: "forbidden" });

  const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const limit = uploadLimit(parsedPath);
  if (!allowedContentType(parsedPath, contentType)) {
    return void res.status(415).json({ error: "unsupported content type" });
  }
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume();
    return void res.status(413).json({ error: "media exceeds size limit" });
  }
  const token = parsedPath.kind === "vault-file" ? null : randomBytes(32).toString("base64url");
  try {
    const file = fileFor(path);
    const oldGeneration = await currentGeneration(file);
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) {
          callback(new Error("media exceeds size limit"));
          return;
        }
        callback(null, chunk);
      },
    });
    const writeStream = file.createWriteStream({
      resumable: false,
      preconditionOpts: { ifGenerationMatch: oldGeneration ?? 0 },
      metadata: {
        contentType,
        cacheControl: "private, no-store",
        ...(token ? { metadata: { mediaToken: token } } : {}),
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
          req.unpipe(cap);
          req.resume();
          cap.unpipe(writeStream);
          writeStream.destroy();
          reject(error);
        };
        cap.once("error", fail);
        writeStream.once("error", fail);
        req.once("error", fail);
        writeStream.once("finish", resolve);
        req.pipe(cap).pipe(writeStream);
      });
    } catch (error) {
      if ((error as Error).message === "media exceeds size limit") {
        return void res.status(413).json({ error: "media exceeds size limit" });
      }
      if ((error as { code?: number }).code === 412) {
        return void res.status(409).json({ error: "media changed during upload" });
      }
      throw error;
    }
    const url = token ? `jhmedia://${path}?token=${encodeURIComponent(token)}` : null;
    return void res.json({ path, url });
  } catch {
    return void res.status(500).json({ error: "media upload failed" });
  }
});

router.get("/media/public/*logicalPath", async (req, res) => {
  const path = logicalPathParam(req.params["logicalPath"]);
  const parsedPath = path ? validateMediaPath(path) : null;
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (
    !path ||
    !parsedPath ||
     !["mug", "admin-photo", "target-photo", "chat-photo"].includes(parsedPath.kind)
  ) {
    return void res.status(404).end();
  }
  if (!token || token.length > 128) return void res.status(404).end();
  try {
    const file = fileFor(path);
    const [metadata] = await file.getMetadata();
    const storedToken = metadata.metadata?.["mediaToken"];
    if (typeof storedToken !== "string" || !opaqueTokenMatches(storedToken, token)) {
      return void res.status(404).end();
    }
    res.setHeader("Content-Type", metadata.contentType ?? "application/octet-stream");
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    res.setHeader("Cache-Control", "private, no-store");
    file.createReadStream().on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    if ((error as { code?: number }).code === 404) return void res.status(404).end();
    return void res.status(500).end();
  }
});

router.get("/media/private", async (req, res) => {
  const path = pathQuery(req);
  const parsedPath = path ? validateMediaPath(path) : null;
  if (!path || !parsedPath || parsedPath.kind !== "vault-file") {
    return void res.status(400).json({ error: "invalid media path" });
  }
  const actor = await actorFor(req);
  if (!actor) return void res.status(403).json({ error: "active member required" });
  try {
    if (!(await checkVaultReadAccess(actor, parsedPath, path))) {
      return void res.status(403).json({ error: "forbidden" });
    }
    const file = fileFor(path);
    const [metadata] = await file.getMetadata();
    res.setHeader("Content-Type", metadata.contentType ?? "application/octet-stream");
    if (metadata.size) res.setHeader("Content-Length", String(metadata.size));
    res.setHeader("Cache-Control", "private, no-store");
    file.createReadStream().on("error", () => res.destroy()).pipe(res);
  } catch (error) {
    if ((error as { code?: number }).code === 404) return void res.status(404).end();
    return void res.status(500).json({ error: "media download failed" });
  }
});

router.delete("/media/object", async (req, res) => {
  const path = pathQuery(req);
  const parsedPath = path ? validateMediaPath(path) : null;
  if (!path || !parsedPath) return void res.status(400).json({ error: "invalid media path" });
  const actor = await actorFor(req);
  if (!actor) return void res.status(403).json({ error: "active member required" });
  if (!mayDelete(parsedPath, actor)) return void res.status(403).json({ error: "forbidden" });
  try {
    const file = fileFor(path);
    const generation = await currentGeneration(file);
    // Idempotent for retryable archive purge and Go Dark.
    if (!generation) return void res.status(204).end();
    await file.delete({ ifGenerationMatch: generation });
    return void res.status(204).end();
  } catch (error) {
    if ((error as { code?: number }).code === 404) return void res.status(204).end();
    if ((error as { code?: number }).code === 412) {
      return void res.status(409).json({ error: "media changed during delete" });
    }
    return void res.status(500).json({ error: "media delete failed" });
  }
});

export default router;