/**
 * Server-side whisper conversation teardown.
 *
 * When the LAST member leaves a conversation (or an orphaned zero-member
 * conversation is swept), every message is deleted — including messages sent
 * by OTHER members whose chatMedia/{uid}/… attachments the caller has no
 * Storage permission to remove. This module performs the whole teardown with
 * owner credentials so the attachment cleanup is bound to the exact messages
 * the server itself deletes: the caller only names a conversation, never a
 * storage path.
 *
 * Authorization (server-checked, rules-equivalent):
 *   - caller is a verified, non-suspended member, AND
 *   - the conversation's memberUids is empty (orphan) or exactly [callerUid]
 *     (last member leaving). Same conditions under which Firestore rules
 *     would let that caller delete the conversation client-side.
 */
import {
  listDocs,
  deleteByName,
  getDoc,
  docName,
  deleteStorageObject,
} from "./memberAdmin";
import { getAccessToken } from "./firestoreAdmin";
import { attachmentPathFor } from "./chatMediaPath";

interface Value {
  stringValue?: string;
  booleanValue?: boolean;
  arrayValue?: { values?: Value[] };
}

function memberUidsOf(fields: Record<string, Value> | undefined): string[] {
  const vals = fields?.["memberUids"]?.arrayValue?.values ?? [];
  return vals.map((v) => v.stringValue ?? "").filter(Boolean);
}

export type TeardownResult =
  | { ok: true; deletedMessages: number; deletedFiles: number }
  | { ok: false; status: number; error: string };

/**
 * Delete a conversation, its messages, and every chatMedia attachment those
 * messages referenced. Only proceeds when the caller would be allowed to do
 * the document deletes themselves (orphan or sole remaining member).
 */
export async function teardownConversation(
  projectId: string,
  bucket: string,
  conversationId: string,
  callerUid: string,
): Promise<TeardownResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) {
    return { ok: false, status: 400, error: "bad conversation id" };
  }
  const token = await getAccessToken();
  if (!token) return { ok: false, status: 500, error: "admin token unavailable" };

  // The caller must be a real, non-suspended member: unlike the Firestore
  // rules (where a missing user doc merely means "not suspended"), this
  // endpoint runs destructive owner-credential operations, so a missing
  // users/{uid} profile is rejected outright.
  const caller = await getDoc(projectId, `users/${callerUid}`);
  if (!caller?.fields) return { ok: false, status: 403, error: "unknown member" };
  const suspended =
    (caller.fields["suspended"] as Value | undefined)?.booleanValue === true;
  if (suspended) return { ok: false, status: 403, error: "forbidden" };

  const conv = await getDoc(projectId, `conversations/${conversationId}`);
  if (!conv) return { ok: false, status: 404, error: "conversation not found" };

  const members = memberUidsOf(conv.fields as Record<string, Value> | undefined);
  const isOrphan = members.length === 0;
  const isLastMember = members.length === 1 && members[0] === callerUid;
  if (!isOrphan && !isLastMember) {
    return { ok: false, status: 403, error: "conversation still has members" };
  }

  // Enumerate messages FIRST; the storage paths we delete come only from the
  // message docs we are about to delete — never from caller input.
  const msgs = await listDocs(
    projectId,
    token,
    `conversations/${conversationId}/messages`,
  );
  // Paths are sender-bound: an imageUrl is honored only when it points
  // inside the message SENDER's own chatMedia folder (imageUrl is
  // client-controlled and could otherwise name a victim's object).
  const mediaPaths = new Set<string>();
  for (const m of msgs) {
    const url = (m.fields?.["imageUrl"] as Value | undefined)?.stringValue ?? "";
    const sender = (m.fields?.["senderUid"] as Value | undefined)?.stringValue ?? "";
    if (url && sender) {
      const p = attachmentPathFor(sender, url);
      if (p) mediaPaths.add(p);
    }
  }

  await deleteByName(projectId, token, [
    ...msgs.map((m) => m.name),
    docName(projectId, `conversations/${conversationId}`),
  ]);

  for (const p of mediaPaths) {
    await deleteStorageObject(bucket, token, p);
  }

  return { ok: true, deletedMessages: msgs.length, deletedFiles: mediaPaths.size };
}
