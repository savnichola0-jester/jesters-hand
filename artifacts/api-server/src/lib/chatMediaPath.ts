/**
 * Sender-bound chat attachment path derivation.
 *
 * A message's imageUrl is CLIENT-CONTROLLED data: Firestore rules only check
 * it is an https string, so a malicious member could store a download URL
 * pointing at another member's chatMedia object. Owner-credential cleanup
 * must therefore never trust the URL alone — the decoded path is only
 * accepted when it sits exactly under the message SENDER's own folder
 * (`chatMedia/{senderUid}/{file}`), which is the only place that sender was
 * ever allowed to upload.
 */
export function attachmentPathFor(
  senderUid: string,
  imageUrl: string,
): string | null {
  if (!senderUid) return null;
  const m = /\/o\/(chatMedia(?:%2F|\/)[^"?\\]+)/.exec(imageUrl);
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  // Exactly chatMedia/{senderUid}/{singleSegmentFile}
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  if (parts[0] !== "chatMedia" || parts[1] !== senderUid || !parts[2]) return null;
  return path;
}

/**
 * Derive a new App Storage chat attachment path from its opaque client pointer.
 * Pointers are client-controlled message data just like legacy download URLs,
 * so accept only the chatMedia folder belonging to this exact sender.
 */
export function appStorageAttachmentPathFor(
  senderUid: string,
  imageUrl: string,
): string | null {
  if (!senderUid) return null;
  const m = /^jhmedia:\/\/chatMedia\/([^/?#]+)\/([^/?#]+)\?token=([^&#]+)$/.exec(imageUrl);
  if (!m) return null;

  let owner: string;
  let filename: string;
  try {
    owner = decodeURIComponent(m[1]!);
    filename = decodeURIComponent(m[2]!);
    // A token is required by the pointer format, but is deliberately not used
    // as authority for deletion: the message sender/path binding is the gate.
    decodeURIComponent(m[3]!);
  } catch {
    return null;
  }

  if (
    owner !== senderUid ||
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return null;
  }
  return `chatMedia/${owner}/${filename}`;
}
