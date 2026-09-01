/**
 * Agora voice-token service — issues short-lived RTC tokens so members can
 * join a Jester's Table voice channel.
 *
 * POST /api/agora/token
 *   Authorization: Bearer <Firebase ID token>
 *   Body: { channel: string }
 *   → { appId, token, channel, uid, expiresIn }
 *
 * The caller is trusted only after their Firebase ID token verifies; the RTC
 * token is bound to their Firebase uid (as Agora string user account) and to
 * the requested channel, and expires after TOKEN_TTL_SECONDS. The Agora App
 * Certificate never leaves the server.
 */
import { Router, type IRouter } from "express";
import { RtcTokenBuilder, RtcRole } from "agora-token";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,60}$/;

router.post("/agora/token", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const appId = process.env["AGORA_APP_ID"];
  const appCertificate = process.env["AGORA_APP_CERTIFICATE"];
  if (!projectId || !appId || !appCertificate) {
    logger.error("agora token service not configured");
    res.status(500).json({ error: "voice service not configured" });
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const uid = idToken ? await verifyFirebaseIdToken(idToken, projectId) : null;
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const channel = typeof req.body?.channel === "string" ? req.body.channel : "";
  if (!CHANNEL_RE.test(channel)) {
    res.status(400).json({ error: "invalid channel" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const token = RtcTokenBuilder.buildTokenWithUserAccount(
    appId,
    appCertificate,
    channel,
    uid,
    RtcRole.PUBLISHER,
    now + TOKEN_TTL_SECONDS,
    now + TOKEN_TTL_SECONDS,
  );

  res.json({ appId, token, channel, uid, expiresIn: TOKEN_TTL_SECONDS });
});

export default router;
