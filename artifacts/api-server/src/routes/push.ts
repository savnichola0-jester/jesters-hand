/**
 * Push relay — accepts push messages from an authenticated app user and
 * forwards them to Expo's push service.
 *
 * POST /api/push/send
 *   Authorization: Bearer <Firebase ID token>
 *   Body: { toUids: string[], title, body, data? }
 *
 * The client is trusted only after its Firebase ID token verifies, and it can
 * only name recipients by uid — the relay reads each recipient's registered
 * Expo token and Web Push subscriptions from their user doc itself (honoring
 * alertsMuted), so a caller can never inject arbitrary delivery targets.
 * Expo messages are forwarded to https://exp.host/--/api/v2/push/send;
 * batches are capped to prevent abuse.
 *
 * Dead-token cleanup happens server-side: ticket-stage DeviceNotRegistered
 * errors are cleared immediately, and because Expo sometimes only learns a
 * device is gone after handing the message to Apple/Google (push *receipts*,
 * which can take up to ~15 minutes), the server schedules its own delayed
 * getReceipts polls after each send. This runs regardless of what the sending
 * device does after the request, so tokens are cleaned up even if the sender
 * closes the app right away.
 */
import { Router, type IRouter } from "express";
import webpush from "web-push";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import {
  adminConfigured,
  clearDeadPushToken,
  clearDeadWebPushSub,
  deletePendingReceipts,
  getUserPushTargets,
  listPendingReceipts,
  savePendingReceipts,
} from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const MAX_MESSAGES = 100;
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_\-+/=]+\]$/;

// ── Web Push (browser) delivery ──────────────────────────────────────────────

let vapidReady: boolean | null = null;
function webPushConfigured(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env["VAPID_PUBLIC_KEY"];
  const priv = process.env["VAPID_PRIVATE_KEY"];
  const subject = process.env["VAPID_SUBJECT"] ?? "mailto:admin@jestershand.local";
  if (pub && priv) {
    try {
      webpush.setVapidDetails(subject, pub, priv);
      vapidReady = true;
    } catch (err) {
      logger.error({ err }, "invalid VAPID configuration");
      vapidReady = false;
    }
  } else {
    vapidReady = false;
  }
  return vapidReady;
}

interface WebMessage {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** Send browser pushes; returns endpoints whose subscriptions are dead. */
async function sendWebMessages(
  projectId: string,
  msgs: WebMessage[],
): Promise<string[]> {
  if (msgs.length === 0) return [];
  if (!webPushConfigured()) {
    logger.warn("web push requested but VAPID keys are not configured");
    return [];
  }
  const staleEndpoints: string[] = [];
  await Promise.allSettled(
    msgs.map(async (m) => {
      try {
        await webpush.sendNotification(
          m.subscription,
          JSON.stringify({ title: m.title, body: m.body, data: m.data }),
          { TTL: 3600 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription is permanently gone (browser data cleared, site
          // notifications revoked) — clean it off the owner's user doc.
          staleEndpoints.push(m.subscription.endpoint);
          if (adminConfigured()) {
            void clearDeadWebPushSub(projectId, m.subscription.endpoint);
          }
        } else {
          logger.warn({ status }, "web push send failed");
        }
      }
    }),
  );
  return staleEndpoints;
}

router.post("/push/send", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId) {
    logger.error("EXPO_PUBLIC_FIREBASE_PROJECT_ID is not set");
    res.status(500).json({ error: "push relay not configured" });
    return;
  }

  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const uid = idToken
    ? await verifyFirebaseIdToken(idToken, projectId)
    : null;
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  // The relay resolves delivery targets server-side from the recipients'
  // user docs — clients name recipients by uid only, and can never supply
  // arbitrary Expo tokens or Web Push endpoints/keys.
  const rawUids = req.body?.toUids;
  const title = req.body?.title;
  const body = req.body?.body;
  const data =
    typeof req.body?.data === "object" && req.body.data !== null
      ? (req.body.data as Record<string, unknown>)
      : {};
  if (
    !Array.isArray(rawUids) ||
    rawUids.length === 0 ||
    rawUids.length > MAX_MESSAGES ||
    typeof title !== "string" ||
    typeof body !== "string" ||
    title.length === 0 ||
    title.length > 200 ||
    body.length > 600 ||
    !rawUids.every(
      (u: unknown) => typeof u === "string" && /^[A-Za-z0-9]{10,128}$/.test(u),
    )
  ) {
    res.status(400).json({ error: "invalid push payload" });
    return;
  }
  if (!adminConfigured()) {
    logger.error("push relay requires FIREBASE_TOKEN to resolve recipients");
    res.status(500).json({ error: "push relay not configured" });
    return;
  }
  const toUids = [...new Set(rawUids as string[])];

  const targetResults = await Promise.all(
    toUids.map((u) => getUserPushTargets(projectId, u)),
  );
  const messages: Array<{
    to: string;
    title: string;
    body: string;
    sound: "default";
    channelId: "dispatches";
    priority: "high";
    data: Record<string, unknown>;
  }> = [];
  const webMessages: WebMessage[] = [];
  for (const t of targetResults) {
    if (!t || t.alertsMuted) continue;
    if (t.expoPushToken && EXPO_TOKEN_RE.test(t.expoPushToken)) {
      messages.push({
        to: t.expoPushToken,
        title,
        body,
        sound: "default" as const,
        channelId: "dispatches" as const,
        priority: "high" as const,
        data,
      });
    }
    for (const s of t.webSubs) {
      webMessages.push({
        subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        title,
        body,
        data,
      });
    }
  }
  if (messages.length === 0 && webMessages.length === 0) {
    res.json({ ok: true, staleTokens: [], receipts: [], staleEndpoints: [] });
    return;
  }

  try {
    // Browser (Web Push) deliveries run alongside the Expo relay.
    const webSendPromise = sendWebMessages(projectId, webMessages);

    if (messages.length === 0) {
      const staleEndpoints = await webSendPromise;
      logger.info({ uid, webCount: webMessages.length }, "web push relayed");
      res.json({ ok: true, staleTokens: [], receipts: [], staleEndpoints });
      return;
    }

    const expoRes = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
    const result = (await expoRes.json().catch(() => ({}))) as {
      data?: Array<{
        status?: string;
        id?: string;
        details?: { error?: string };
      }>;
    };
    if (!expoRes.ok) {
      logger.warn({ status: expoRes.status, result }, "expo push send failed");
      res.status(502).json({ error: "push delivery failed" });
      return;
    }

    // Expo returns one ticket per message, in order. A ticket with
    // DeviceNotRegistered means the token is permanently dead (app deleted,
    // device changed) — report those back so the caller can clean them up.
    // Successful tickets carry a receipt id; the server polls Expo's
    // getReceipts for those itself (see scheduleReceiptPolls) to catch
    // failures Expo only learns about after delivery.
    const staleTokens: string[] = [];
    const receipts: Array<{ id: string; token: string }> = [];
    const tickets = Array.isArray(result.data) ? result.data : [];
    tickets.forEach((ticket, i) => {
      const message = messages[i];
      if (!message) return;
      if (
        ticket?.status === "error" &&
        ticket.details?.error === "DeviceNotRegistered"
      ) {
        staleTokens.push(message.to);
      } else if (ticket?.status === "ok" && typeof ticket.id === "string") {
        receipts.push({ id: ticket.id, token: message.to });
      }
    });
    if (staleTokens.length > 0) {
      logger.info(
        { uid, staleCount: staleTokens.length },
        "expo reported dead push tokens",
      );
      // Clear ticket-stage dead tokens server-side (fire-and-forget). The
      // response still lists them so older clients can also clean up.
      if (adminConfigured()) {
        for (const token of staleTokens) {
          void clearDeadPushToken(projectId, token);
        }
      }
    }

    // Receipt-stage failures (DeviceNotRegistered discovered after handoff to
    // Apple/Google) are polled for server-side, so cleanup happens even if
    // the sending device disappears immediately after this response.
    if (receipts.length > 0) {
      if (adminConfigured()) {
        scheduleReceiptPolls(projectId, receipts);
      } else {
        logger.warn(
          "FIREBASE_TOKEN not set — server-side receipt polling disabled",
        );
      }
    }

    const staleEndpoints = await webSendPromise;
    logger.info(
      { uid, count: messages.length, webCount: webMessages.length },
      "push relayed",
    );
    res.json({ ok: true, staleTokens, receipts, staleEndpoints });
  } catch (err) {
    logger.error({ err }, "expo push send error");
    res.status(502).json({ error: "push delivery failed" });
  }
});

// ── Server-side receipt polling ──────────────────────────────────────────────

// Expo says receipts can take up to ~15 minutes to settle, though most land
// within seconds. Poll a few times with growing delays; a receipt that has
// appeared (any status) is final, so it's dropped from later polls.
const RECEIPT_POLL_DELAYS_MS = [30_000, 5 * 60_000, 16 * 60_000];

// Ticket ids currently being polled by in-process timers, so the persistent
// sweeper doesn't double-poll receipts the live schedule is already handling.
const inFlightTicketIds = new Set<string>();

/**
 * Poll Expo's getReceipts once for the given pending tickets, clearing dead
 * tokens for DeviceNotRegistered receipts and deleting resolved ticket ids
 * from the persistent queue. Resolved ids are removed from `pending`.
 */
async function pollReceiptsOnce(
  projectId: string,
  pending: Map<string, string>,
  label: string,
): Promise<void> {
  if (pending.size === 0) return;
  try {
    const expoRes = await fetch(EXPO_RECEIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...pending.keys()] }),
    });
    const result = (await expoRes.json().catch(() => ({}))) as {
      data?: Record<
        string,
        { status?: string; details?: { error?: string } } | undefined
      >;
    };
    if (!expoRes.ok) {
      logger.warn({ status: expoRes.status, label }, "expo receipts poll failed");
      return;
    }
    const receiptData =
      result.data && typeof result.data === "object" ? result.data : {};
    const resolvedIds: string[] = [];
    for (const [id, token] of [...pending]) {
      const receipt = receiptData[id];
      if (!receipt) continue; // not settled yet — retry next round
      pending.delete(id);
      inFlightTicketIds.delete(id);
      resolvedIds.push(id);
      if (
        receipt.status === "error" &&
        receipt.details?.error === "DeviceNotRegistered"
      ) {
        logger.info({ label }, "receipt reported dead push token");
        void clearDeadPushToken(projectId, token);
      }
    }
    if (resolvedIds.length > 0) {
      void deletePendingReceipts(projectId, resolvedIds);
    }
  } catch (err) {
    logger.warn({ err, label }, "expo receipts poll error");
  }
}

/**
 * Fire-and-forget: poll Expo's getReceipts for the given tickets on a delayed
 * schedule and clear users/{uid}.expoPushToken for any DeviceNotRegistered
 * receipt. Pending ticket ids are also persisted to Firestore
 * (pushReceiptQueue) so the sweeper can finish the job if the server
 * restarts before these in-process timers fire.
 */
function scheduleReceiptPolls(
  projectId: string,
  receipts: Array<{ id: string; token: string }>,
): void {
  // ticket id → token, pruned as receipts resolve.
  const pending = new Map(receipts.map((r) => [r.id, r.token]));
  for (const id of pending.keys()) inFlightTicketIds.add(id);
  // Persist so cleanup survives a restart; the sweeper picks these up.
  void savePendingReceipts(projectId, receipts);

  const poll = async (attempt: number): Promise<void> => {
    await pollReceiptsOnce(projectId, pending, `attempt ${attempt}`);
    const nextDelay = RECEIPT_POLL_DELAYS_MS[attempt + 1];
    if (pending.size > 0 && nextDelay !== undefined) {
      const t = setTimeout(() => void poll(attempt + 1), nextDelay);
      t.unref?.();
    } else {
      // In-process schedule is done; leave any unresolved ids to the sweeper.
      for (const id of pending.keys()) inFlightTicketIds.delete(id);
    }
  };

  const firstDelay = RECEIPT_POLL_DELAYS_MS[0] ?? 30_000;
  const t = setTimeout(() => void poll(0), firstDelay);
  t.unref?.();
}

// ── Persistent receipt sweeper ───────────────────────────────────────────────

// How often the sweeper re-checks the persisted queue, how old an entry must
// be before the sweeper touches it (younger ones are still inside the normal
// in-process window and are skipped when tracked there), and when an entry is
// abandoned (Expo drops receipts after ~24h, so nothing more can be learned).
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SWEEP_STARTUP_DELAY_MS = 15_000;
const SWEEP_MIN_AGE_MS = 60_000;
const SWEEP_EXPIRE_MS = 24 * 60 * 60_000;

async function sweepPendingReceipts(projectId: string): Promise<void> {
  const persisted = await listPendingReceipts(projectId);
  if (persisted.length === 0) return;
  const now = Date.now();
  const expiredIds: string[] = [];
  const pending = new Map<string, string>();
  for (const r of persisted) {
    if (now - r.createdAtMs > SWEEP_EXPIRE_MS) {
      expiredIds.push(r.id);
    } else if (
      now - r.createdAtMs >= SWEEP_MIN_AGE_MS &&
      !inFlightTicketIds.has(r.id)
    ) {
      pending.set(r.id, r.token);
    }
  }
  if (expiredIds.length > 0) {
    logger.info({ count: expiredIds.length }, "expiring stale receipt queue entries");
    void deletePendingReceipts(projectId, expiredIds);
  }
  if (pending.size > 0) {
    logger.info({ count: pending.size }, "sweeping persisted push receipts");
    await pollReceiptsOnce(projectId, pending, "sweep");
  }
}

/**
 * Start the persistent receipt sweeper: shortly after startup and on an
 * interval, poll Expo for any pending receipts persisted in Firestore that
 * no in-process timer is handling (i.e. left over from a previous process).
 */
export function startReceiptSweeper(): void {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId || !adminConfigured()) {
    logger.warn(
      "receipt sweeper disabled (missing project id or FIREBASE_TOKEN)",
    );
    return;
  }
  const run = (): void => {
    void sweepPendingReceipts(projectId).catch((err) =>
      logger.warn({ err }, "receipt sweep error"),
    );
  };
  const startT = setTimeout(run, SWEEP_STARTUP_DELAY_MS);
  startT.unref?.();
  const intervalT = setInterval(run, SWEEP_INTERVAL_MS);
  intervalT.unref?.();
}

export default router;
