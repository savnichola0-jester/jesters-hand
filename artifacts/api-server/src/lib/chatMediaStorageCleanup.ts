import { Storage } from "@google-cloud/storage";

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

function privateObjectLocation(logicalPath: string): { bucket: string; name: string } {
  const bucket = process.env["DEFAULT_OBJECT_STORAGE_BUCKET_ID"] ?? "";
  const privateDir = process.env["PRIVATE_OBJECT_DIR"] ?? "";
  if (!bucket || !privateDir) throw new Error("App Storage is not configured");
  const segments = privateDir.split("/").filter(Boolean);
  if (segments[0] !== bucket) throw new Error("PRIVATE_OBJECT_DIR bucket mismatch");
  const prefix = segments.slice(1).join("/");
  return { bucket, name: `${prefix ? `${prefix}/` : ""}${logicalPath}` };
}

function chatObjectLocation(logicalPath: string): { bucket: string; name: string } {
  if (!/^chatMedia\/[^/]+\/[^/]+$/.test(logicalPath)) {
    throw new Error("invalid chat media path");
  }
  return privateObjectLocation(logicalPath);
}

/** Delete a sender-bound App Storage attachment; missing objects are idempotent. */
export async function deleteAppStorageChatObject(logicalPath: string): Promise<void> {
  const { bucket, name } = chatObjectLocation(logicalPath);
  await storage.bucket(bucket).file(name).delete({ ignoreNotFound: true });
}

/**
 * Remove any remaining App Storage chat objects in one member's own folder.
 * `preservePaths` are sender-validated attachment paths referenced by archived
 * table messages, which must keep working until their archive can be restored.
 */
export async function deleteAppStorageChatPrefix(
  uid: string,
  preservePaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  if (!uid || uid.includes("/") || uid.includes("\\")) {
    throw new Error("invalid chat media owner");
  }
  const { bucket, name: objectPrefix } = chatObjectLocation(`chatMedia/${uid}/_`);
  const prefix = objectPrefix.slice(0, -1);
  const preserved = new Set(
    [...preservePaths]
      .filter((path) => path.startsWith(`chatMedia/${uid}/`))
      .map((path) => chatObjectLocation(path).name),
  );
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  for (const file of files) {
    if (preserved.has(file.name)) continue;
    await file.delete({ ignoreNotFound: true });
  }
}