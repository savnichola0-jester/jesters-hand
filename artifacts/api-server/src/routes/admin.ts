/**
 * The Hand — member administration endpoints (admin/00-00 only).
 *
 *   POST /admin/suspend  { targetUid, suspended: boolean }
 *   POST /admin/recover  { targetUid, newPassword }
 *   POST /admin/transfer { targetUid, newPassword, confirmJokerId }
 *
 * All require Authorization: Bearer <Firebase ID token>. The caller's uid is
 * verified cryptographically, then their users/{uid} doc must carry
 * isAdmin == true (server-side check — the client UI gate is not trusted).
 * The admin can never target their own account.
 */
import { Router, type IRouter } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured } from "../lib/firestoreAdmin";
import {
  setAccountDisabled,
  setAccountPassword,
  wipeUser,
  getDoc,
  patchDocFields,
} from "../lib/memberAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PASSWORD_MIN = 6;

interface AdminCtx {
  projectId: string;
  callerUid: string;
}

async function requireAdmin(
  req: { headers: Record<string, unknown> },
): Promise<AdminCtx | { error: string; status: number }> {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId || !adminConfigured()) {
    return { error: "admin endpoints not configured", status: 500 };
  }
  const authHeader = String(req.headers["authorization"] ?? "");
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const callerUid = idToken
    ? await verifyFirebaseIdToken(idToken, projectId)
    : null;
  if (!callerUid) return { error: "unauthorized", status: 401 };

  // Server-side admin check — read the caller's user doc with admin access.
  try {
    const doc = await getDoc(projectId, `users/${callerUid}`);
    const isAdmin =
      (doc?.fields?.["isAdmin"] as { booleanValue?: boolean } | undefined)
        ?.booleanValue === true;
    if (!isAdmin) return { error: "forbidden", status: 403 };
  } catch {
    return { error: "admin check failed", status: 500 };
  }
  return { projectId, callerUid };
}

function badTarget(targetUid: unknown, callerUid: string): string | null {
  if (typeof targetUid !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(targetUid)) {
    return "invalid targetUid";
  }
  if (targetUid === callerUid) return "cannot target your own account";
  return null;
}

router.post("/admin/suspend", async (req, res) => {
  const ctx = await requireAdmin(req);
  if ("error" in ctx) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const { targetUid, suspended } = req.body ?? {};
  const bad = badTarget(targetUid, ctx.callerUid);
  if (bad || typeof suspended !== "boolean") {
    res.status(400).json({ error: bad ?? "suspended must be boolean" });
    return;
  }
  try {
    await setAccountDisabled(ctx.projectId, targetUid, suspended);
    // Display flag on the profile so rosters can show the status.
    await patchDocFields(
      ctx.projectId,
      `users/${targetUid}`,
      { suspended: { booleanValue: suspended } },
      ["suspended"],
    );
    logger.info({ targetUid, suspended }, "member suspend toggled");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, targetUid }, "suspend failed");
    res.status(500).json({ error: "suspend failed" });
  }
});

router.post("/admin/recover", async (req, res) => {
  const ctx = await requireAdmin(req);
  if ("error" in ctx) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const { targetUid, newPassword } = req.body ?? {};
  const bad = badTarget(targetUid, ctx.callerUid);
  if (bad || typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN) {
    res.status(400).json({ error: bad ?? `newPassword must be at least ${PASSWORD_MIN} characters` });
    return;
  }
  try {
    await setAccountPassword(ctx.projectId, targetUid, newPassword);
    logger.info({ targetUid }, "member cipher reset");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, targetUid }, "recover failed");
    res.status(500).json({ error: "recover failed" });
  }
});

router.post("/admin/transfer", async (req, res) => {
  const ctx = await requireAdmin(req);
  if ("error" in ctx) { res.status(ctx.status).json({ error: ctx.error }); return; }
  const bucket = process.env["EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET"];
  if (!bucket) {
    res.status(500).json({ error: "storage bucket not configured" });
    return;
  }
  const { targetUid, newPassword, confirmJokerId } = req.body ?? {};
  const bad = badTarget(targetUid, ctx.callerUid);
  if (bad || typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN) {
    res.status(400).json({ error: bad ?? `newPassword must be at least ${PASSWORD_MIN} characters` });
    return;
  }
  try {
    // The client must echo back the target's Joker ID — a second server-side
    // guard that the admin confirmed the right slot before a permanent wipe.
    const target = await getDoc(ctx.projectId, `users/${targetUid}`);
    const jokerId =
      (target?.fields?.["jokerId"] as { stringValue?: string } | undefined)
        ?.stringValue ?? "";
    if (!jokerId || confirmJokerId !== jokerId) {
      res.status(400).json({ error: "confirmJokerId does not match the target slot" });
      return;
    }
    const targetIsAdmin =
      (target?.fields?.["isAdmin"] as { booleanValue?: boolean } | undefined)
        ?.booleanValue === true;
    if (targetIsAdmin) {
      res.status(400).json({ error: "cannot transfer an admin account" });
      return;
    }

    // 1. Lock the account and cut sessions while the wipe runs.
    await setAccountDisabled(ctx.projectId, targetUid, true);
    // 2. Permanently erase everything tied to the uid (keeps jokerId).
    await wipeUser(ctx.projectId, bucket, targetUid);
    // 3. New cipher for the incoming member, re-enable the slot.
    await setAccountPassword(ctx.projectId, targetUid, newPassword);
    await setAccountDisabled(ctx.projectId, targetUid, false);

    logger.info({ targetUid }, "member transfer complete");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, targetUid }, "transfer failed");
    res.status(500).json({
      error:
        "transfer failed part-way — the slot is locked; retry Transfer to finish the wipe",
    });
  }
});

export default router;
