import { Router, type IRouter } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import {
  adminConfigured,
  firestoreBase,
  getAccessToken,
  getUserPushTargets,
} from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const documentRoot = (projectId: string) =>
  `projects/${projectId}/databases/(default)/documents`;

type FirestoreDoc = {
  name?: string;
  fields?: Record<string, unknown>;
};

async function readDocument(base: string, accessToken: string, path: string): Promise<FirestoreDoc | null> {
  const res = await fetch(`${base}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore read failed (${res.status})`);
  return await res.json() as FirestoreDoc;
}

async function findJester(base: string, accessToken: string): Promise<{ uid: string } | null> {
  const res = await fetch(`${base}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: { fieldFilter: { field: { fieldPath: "jokerId" }, op: "EQUAL", value: { stringValue: "00-00" } } },
        limit: 1,
      },
    }),
  });
  if (!res.ok) throw new Error(`Jester lookup failed (${res.status})`);
  const row = (await res.json() as Array<{ document?: FirestoreDoc }>).find(r => r.document?.name);
  const name = row?.document?.name;
  return name ? { uid: decodeURIComponent(name.slice(name.lastIndexOf("/") + 1)) } : null;
}

router.post("/hidden-jest/found", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const rawToken = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const uid = projectId && rawToken ? await verifyFirebaseIdToken(rawToken, projectId) : null;
  const entryId = req.body?.entryId;
  if (!uid) return void res.status(401).json({ error: "unauthorized" });
  if (typeof entryId !== "string" || !ENTRY_ID.test(entryId)) {
    return void res.status(400).json({ error: "invalid hidden jest" });
  }
  if (!adminConfigured()) return void res.status(500).json({ error: "audit service not configured" });

  try {
    const accessToken = await getAccessToken();
    if (!accessToken || !projectId) throw new Error("admin access unavailable");
    const base = firestoreBase(projectId);
    const actor = await readDocument(base, accessToken, `users/${encodeURIComponent(uid)}`);
    if (!actor || (actor.fields?.["suspended"] as { booleanValue?: boolean } | undefined)?.booleanValue === true) {
      return void res.status(403).json({ error: "active member required" });
    }
    const [entry, jester] = await Promise.all([
      readDocument(base, accessToken, `vault/${encodeURIComponent(entryId)}`),
      findJester(base, accessToken),
    ]);
    const actorFields = actor?.fields ?? {};
    const decoded = (actorFields["decodedJests"] as { mapValue?: { fields?: Record<string, { booleanValue?: boolean }> } } | undefined)
      ?.mapValue?.fields?.[entryId]?.booleanValue === true;
    const entryFields = entry?.fields ?? {};
    const section = (entryFields["section"] as { stringValue?: string } | undefined)?.stringValue;
    const title = (entryFields["title"] as { stringValue?: string } | undefined)?.stringValue;
    const locked = typeof (entryFields["decoderHash"] as { stringValue?: string } | undefined)?.stringValue === "string";
    const jokerId = (actorFields["jokerId"] as { stringValue?: string } | undefined)?.stringValue ?? "Unknown Joker";
    if (!decoded || !locked || (section !== "margins" && section !== "cut") || !title) {
      return void res.status(403).json({ error: "hidden jest was not verified" });
    }
    if (!jester) return void res.status(404).json({ error: "Jester not found" });

    // One immutable event per finder+entry avoids duplicate alerts from retries.
    const eventId = `hidden-${uid}-${entryId}`;
    const now = new Date().toISOString();
    const root = documentRoot(projectId);
    const notificationName = `${root}/notifications/${encodeURIComponent(jester.uid)}/items/${encodeURIComponent(eventId)}`;
    const auditName = `${root}/investigationEvents/${encodeURIComponent(eventId)}`;
    const commit = await fetch(`${base}:commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ writes: [
        { update: { name: notificationName, fields: {
          type: { stringValue: "announcement" }, fromUid: { stringValue: uid },
          text: { stringValue: `${jokerId} found the Hidden Jest in ${title}.` },
          createdAt: { timestampValue: now }, read: { booleanValue: false },
        } }, currentDocument: { exists: false } },
        { update: { name: auditName, fields: {
          uid: { stringValue: uid }, jokerId: { stringValue: jokerId },
          action: { stringValue: "Hidden Jest found" }, entryId: { stringValue: entryId },
          entryTitle: { stringValue: title }, section: { stringValue: section },
          occurredAt: { timestampValue: now },
        } }, currentDocument: { exists: false } },
        // Intentionally body-free activity row: it is safe for compact feeds
        // while investigationEvents retains the contextual evidence.
        { update: { name: `${root}/activityEvents/${encodeURIComponent(eventId)}`, fields: {
          uid: { stringValue: uid }, action: { stringValue: "hidden_jest_found" },
          entryId: { stringValue: entryId }, occurredAt: { timestampValue: now },
        } }, currentDocument: { exists: false } },
      ] }),
    });
    // The first request has already made the record; retries are successful.
    if (commit.status === 409 || commit.status === 412) return void res.json({ ok: true, duplicate: true });
    if (!commit.ok) throw new Error(`audit commit failed (${commit.status})`);

    const target = await getUserPushTargets(projectId, jester.uid);
    if (!target?.alertsMuted && target?.expoPushToken) {
      void fetch(EXPO_PUSH_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ to: target.expoPushToken, title: "A Hidden Jest was found.", body: `${jokerId} found the Hidden Jest in ${title}.`, sound: "default", channelId: "dispatches", priority: "high", data: { type: "announcement" } }]),
      }).catch(err => logger.warn({ err }, "hidden jest push failed"));
    }
    logger.info({ uid, entryId }, "hidden jest recorded");
    return void res.json({ ok: true });
  } catch (err) {
    logger.error({ err, uid, entryId }, "hidden jest record failed");
    return void res.status(500).json({ error: "hidden jest record failed" });
  }
});

export default router;