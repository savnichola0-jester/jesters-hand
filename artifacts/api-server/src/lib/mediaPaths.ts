export type MediaPath =
  | { kind: "mug"; uid: string }
  | { kind: "admin-photo"; uid: string }
  | { kind: "target-photo"; uid: string }
  | { kind: "chat-photo"; uid: string }
  | { kind: "vault-file"; entryId: string; fileName: string };

const UID = /^[A-Za-z0-9:_-]{1,128}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Parse only the app's explicitly-supported logical object names. */
export function validateMediaPath(path: string): MediaPath | null {
  if (path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("%")) {
    return null;
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts.length === 3 && parts[0] === "users" && UID.test(parts[1]!)) {
    if (parts[2] === "mug.jpg" || /^mug-[a-z0-9]+-[a-z0-9]+\.jpg$/.test(parts[2]!))
      return { kind: "mug", uid: parts[1]! };
    if (parts[2] === "admin.jpg" || /^admin-[a-z0-9]+-[a-z0-9]+\.jpg$/.test(parts[2]!))
      return { kind: "admin-photo", uid: parts[1]! };
  }
  if (
    parts.length === 3 &&
    parts[0] === "targetTickets" &&
    UID.test(parts[1]!) &&
    /^[0-9]{10,16}_[a-z0-9]{6,20}\.jpg$/.test(parts[2]!)
  ) {
    return { kind: "target-photo", uid: parts[1]! };
  }
  if (
    parts.length === 3 &&
    parts[0] === "chatMedia" &&
    UID.test(parts[1]!) &&
    /^[a-z0-9]+-[a-z0-9]{8}\.(jpg|png|webp|gif)$/.test(parts[2]!)
  ) {
    return { kind: "chat-photo", uid: parts[1]! };
  }
  if (
    parts.length === 3 &&
    parts[0] === "vault" &&
    ENTRY_ID.test(parts[1]!) &&
    (parts[2] === "file" ||
      parts[2] === "cover" ||
      /^cover-[a-z0-9]+-[a-z0-9]+$/.test(parts[2]!) ||
      /^file-[a-z0-9]+-[a-z0-9]+$/.test(parts[2]!))
  ) {
    return { kind: "vault-file", entryId: parts[1]!, fileName: parts[2]! };
  }
  return null;
}

export function isVaultCoverPath(path: MediaPath): boolean {
  return path.kind === "vault-file" &&
    (path.fileName === "cover" || /^cover-[a-z0-9]+-[a-z0-9]+$/.test(path.fileName));
}

export function isCurrentReplitVaultObject(
  entry: Record<string, unknown>,
  path: MediaPath,
  logicalPath: string,
): boolean {
  if (path.kind !== "vault-file") return false;
  const cover = isVaultCoverPath(path);
  const pointerField = cover ? "coverPath" : "filePath";
  const storageField = cover ? "coverStorage" : "fileStorage";
  return entry[pointerField] === logicalPath && entry[storageField] === "replit";
}