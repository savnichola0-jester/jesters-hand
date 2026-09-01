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
import { adminConfigured } from "../lib/firestoreAdmin";
import { teardownConversation } from "../lib/chatCleanup";
import { logger } from "../lib/logger";

const router: IRouter = Router();

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
