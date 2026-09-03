import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "../lib/firestoreAdmin";
import { listDocs } from "../lib/memberAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const UID = /^[A-Za-z0-9:_-]{1,128}$/;

type FirestoreValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude?: number; longitude?: number };
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

function valueOf(value: FirestoreValue | undefined): unknown {
  if (!value) return null;
  if ("nullValue" in value) return null;
  if (typeof value.booleanValue === "boolean") return value.booleanValue;
  if (typeof value.integerValue === "string") return Number(value.integerValue);
  if (typeof value.doubleValue === "number") return value.doubleValue;
  if (typeof value.timestampValue === "string") return value.timestampValue;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.bytesValue === "string") return value.bytesValue;
  if (typeof value.referenceValue === "string") return value.referenceValue;
  if (value.geoPointValue) return value.geoPointValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(valueOf);
  if (value.mapValue) return fieldsOf(value.mapValue.fields);
  return null;
}

function fieldsOf(fields?: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([key, value]) => [key, valueOf(value)]));
}

function documentId(name?: string): string | null {
  if (!name) return null;
  const marker = "/documents/";
  const path = name.includes(marker) ? name.slice(name.indexOf(marker) + marker.length) : "";
  const parts = path.split("/");
  return parts.length >= 2 && parts[parts.length - 1] ? parts[parts.length - 1]! : null;
}

async function queryByUid(
  base: string,
  token: string,
  collectionId: "activityEvents" | "investigationEvents",
  uid: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const response = await fetch(`${base}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: "uid" },
            op: "EQUAL",
            value: { stringValue: uid },
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`${collectionId} query failed (${response.status})`);
  const rows = await response.json() as Array<{ document?: FirestoreDocument }>;
  return rows.flatMap(({ document }) => {
    const id = documentId(document?.name);
    return id ? [{ id, data: fieldsOf(document?.fields) }] : [];
  });
}

async function authorizeJester(req: Request) {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";
  const callerUid = projectId && bearer ? await verifyFirebaseIdToken(bearer, projectId) : null;
  if (!projectId || !callerUid || !adminConfigured()) return null;
  const token = await getAccessToken();
  if (!token) return null;
  const base = firestoreBase(projectId);
  const response = await fetch(`${base}/users/${encodeURIComponent(callerUid)}?mask.fieldPaths=jokerId&mask.fieldPaths=isAdmin&mask.fieldPaths=suspended`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const caller = await response.json() as FirestoreDocument;
  if (
    caller.fields?.["jokerId"]?.stringValue !== "00-00" ||
    caller.fields?.["isAdmin"]?.booleanValue !== true ||
    caller.fields?.["suspended"]?.booleanValue === true
  ) return null;
  return { projectId, token, base };
}

async function pocketMessages(
  projectId: string,
  token: string,
  targetUid: string,
): Promise<{
  messages: Array<{
    sentAt: string | null;
  }>;
  partial: boolean;
  failures: number;
}> {
  const conversations = await listDocs(projectId, token, "conversations");
  const messages: Array<{
    sentAt: string | null;
  }> = [];
  let failures = 0;

  // Bound concurrent scans so a large Pocket does not exhaust sockets.
  for (let offset = 0; offset < conversations.length; offset += 8) {
    const batch = conversations.slice(offset, offset + 8);
    await Promise.all(batch.map(async conversation => {
      const conversationId = documentId(conversation.name);
      if (!conversationId) return;
      try {
        const docs = await listDocs(
          projectId,
          token,
          `conversations/${encodeURIComponent(conversationId)}/messages`,
        );
        for (const message of docs) {
          const data = fieldsOf(message.fields);
          if (data.senderUid !== targetUid) continue;
          messages.push({
            sentAt: typeof data.sentAt === "string" ? data.sentAt : null,
          });
        }
      } catch {
        failures++;
      }
    }));
  }
  return { messages, partial: failures > 0, failures };
}

router.get("/audit/activity/:uid", async (req, res) => {
  if (!UID.test(req.params.uid ?? "")) return void res.status(400).json({ error: "invalid target uid" });
  try {
    const authz = await authorizeJester(req);
    if (!authz) return void res.status(403).json({ error: "Joker 00-00 authorization required" });
    const records = await queryByUid(authz.base, authz.token, "activityEvents", req.params.uid);
    // Explicit allow-list: an Activity response can never carry body/context.
    const events = records.map(({ id, data }) => ({
      id,
      action: typeof data.action === "string" ? data.action : null,
      type: typeof data.type === "string" ? data.type : null,
      section: typeof data.section === "string" ? data.section : null,
      category: typeof data.category === "string" ? data.category : null,
      at: typeof data.at === "string" ? data.at : null,
      occurredAt: typeof data.occurredAt === "string" ? data.occurredAt : null,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
      timestamp: typeof data.timestamp === "string" ? data.timestamp : null,
    }));
    return void res.json({ events });
  } catch (err) {
    logger.error({ err }, "privileged activity audit failed");
    return void res.status(500).json({ error: "privileged activity audit failed" });
  }
});

router.get("/audit/investigation/:uid", async (req, res) => {
  if (!UID.test(req.params.uid ?? "")) return void res.status(400).json({ error: "invalid target uid" });
  try {
    const authz = await authorizeJester(req);
    if (!authz) return void res.status(403).json({ error: "Joker 00-00 authorization required" });
    const events = await queryByUid(authz.base, authz.token, "investigationEvents", req.params.uid);
    let pocket = { messages: [] as Awaited<ReturnType<typeof pocketMessages>>["messages"], partial: false, failures: 0 };
    try {
      pocket = await pocketMessages(authz.projectId, authz.token, req.params.uid);
    } catch (err) {
      logger.warn({ err }, "Pocket audit scan unavailable");
      pocket.partial = true;
      pocket.failures = 1;
    }
    return void res.json({
      events: events.map(({ id, data }) => ({ ...data, id })),
      // Pocket is usage-only in Investigations. The response deliberately
      // excludes bodies, attachments, recipients, and source identifiers.
      pocketMessages: pocket.messages.map(message => ({ sentAt: message.sentAt })),
      partial: { pocket: pocket.partial, pocketFailures: pocket.failures },
    });
  } catch (err) {
    logger.error({ err }, "privileged investigation audit failed");
    return void res.status(500).json({ error: "privileged investigation audit failed" });
  }
});

export default router;