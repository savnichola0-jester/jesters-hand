/**
 * Whisper conversation teardown — deletes a conversation the caller may
 * legitimately remove (orphaned, or the caller is the sole remaining member),
 * its messages, AND every chatMedia attachment those messages referenced.
 *
 * POST /api/chat/teardown
 *   Authorization: Bearer <Firebase ID token>
 *   Body: { conversationId: string }
 *   → { ok: true, deletedMessages, deletedFiles }
 *
 * Attachments may live under OTHER members' chatMedia folders, which the
 * caller has no Storage permission to delete — so the server does the whole
 * teardown with owner credentials. Storage paths are derived exclusively
 * from the message docs the server deletes, never from caller input.
 */
import { Router, type IRouter } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import {
  adminConfigured,
  firestoreBase,
  getAccessToken,
} from "../lib/firestoreAdmin";
import { listDocs } from "../lib/memberAdmin";
import { teardownConversation } from "../lib/chatCleanup";
import { logger } from "../lib/logger";

const router: IRouter = Router();

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreValue[] };
};

function stringField(fields: Record<string, FirestoreValue>, key: string): string {
  return fields[key]?.stringValue ?? "";
}

function stringArrayField(fields: Record<string, FirestoreValue>, key: string): string[] {
  return (fields[key]?.arrayValue?.values ?? [])
    .map(value => value.stringValue)
    .filter((value): value is string => typeof value === "string");
}

function trueField(fields: Record<string, FirestoreValue>, key: string): boolean {
  return fields[key]?.booleanValue === true;
}

// The client cannot list conversations with a broad memberUids query: Firestore
// correctly rejects it because that query could include another member's
// protected Check-In thread. Use the verified server identity to return only
// ordinary conversations the caller belongs to; the client then listens to
// those individual documents under normal member-only rules.
router.get("/chat/conversations", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const uid = projectId && idToken
    ? await verifyFirebaseIdToken(idToken, projectId)
    : null;
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!projectId || !adminConfigured()) {
    res.status(503).json({ error: "conversation directory unavailable" });
    return;
  }

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      res.status(503).json({ error: "conversation directory unavailable" });
      return;
    }
    const userResponse = await fetch(
      `${firestoreBase(projectId)}/users/${encodeURIComponent(uid)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (userResponse.status === 404) {
      res.status(403).json({ error: "active account required" });
      return;
    }
    if (!userResponse.ok) throw new Error(`user read failed (${userResponse.status})`);
    const userDocument = await userResponse.json() as {
      fields?: Record<string, FirestoreValue>;
    };
    if (userDocument.fields?.suspended?.booleanValue === true) {
      res.status(403).json({ error: "active account required" });
      return;
    }

    const documents = await listDocs(projectId, accessToken, "conversations");
    const conversations = documents.flatMap(document => {
      const id = decodeURIComponent(document.name.slice(document.name.lastIndexOf("/") + 1));
      const fields = document.fields as Record<string, FirestoreValue> | undefined;
      if (!fields) return [];
      const memberUids = stringArrayField(fields, "memberUids");
      const deletedBy = stringArrayField(fields, "deletedBy");
      const kind = stringField(fields, "kind");
      const isPrivateCheckIn =
        id.startsWith("checkins_") ||
        id.startsWith("checkin-") ||
        kind === "check_ins" ||
        trueField(fields, "checkInProtected") ||
        typeof fields.ownerUid?.stringValue === "string";
      if (
        isPrivateCheckIn ||
        !memberUids.includes(uid) ||
        deletedBy.includes(uid)
      ) return [];
      return [{
        id,
        memberUids,
        isGroup: trueField(fields, "isGroup"),
      }];
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ conversations });
  } catch (error) {
    logger.error({ err: error, uid }, "conversation directory read failed");
    res.status(503).json({ error: "conversation directory unavailable" });
  }
});

router.post("/chat/teardown", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bucket = process.env["EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET"];
  if (!projectId || !bucket || !adminConfigured()) {
    res.status(500).json({ error: "chat cleanup not configured" });
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const uid = idToken ? await verifyFirebaseIdToken(idToken, projectId) : null;
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // Membership + suspension are enforced inside teardownConversation itself
  // (a missing users/{uid} doc or suspended == true is rejected with 403),
  // so the destructive path cannot be reached by a bare auth account.
  const conversationId =
    typeof req.body?.conversationId === "string" ? req.body.conversationId : "";

  try {
    const result = await teardownConversation(projectId, bucket, conversationId, uid);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    logger.info(
      { conversationId, uid, ...result },
      "conversation teardown complete",
    );
    res.json(result);
  } catch (e) {
    logger.error({ err: e, conversationId }, "conversation teardown failed");
    res.status(500).json({ error: "teardown failed" });
  }
});

export default router;
