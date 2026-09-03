import { Router, type IRouter } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
// Legacy evidence types remain supported. Named table tasks are intentionally
// accepted as definitions but cannot complete until an evidence verifier exists.
const TASK_TYPES = new Set(["mark", "black_book", "target_whisper", "vault_mark", "ticket", "the_hand", "street_art", "jesters_deal", "suits", "ante", "jesters_table", "target_ticket", "vault", "chamber", "recruit", "uniform", "system", "website", "facebook", "instagram", "x", "tiktok", "twitch", "suno"]);
type WireFields = Record<string, any>;
type Instant = { timestampValue: string };

interface DealTask { id: string; type: string; targetCount: number; assigneeUid: string | null }
interface ActiveDeal { id: string; tasks: DealTask[]; previousDealId: string | null; publishedAt: string; expiresAt: string | null }
interface Completion { uid: string; taskCounts: Record<string, number>; completedTaskIds: string[]; completedAt: string | null; updatedAt: string | null }
interface Stats { uid: string; currentStreak: number; bestStreak: number; lastCompletedDealId: string | null; lastCompletedAt: string | null; lastActivityAt: string | null }

const value = (v: any): any => {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(value);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, value(x)]));
  return null;
};
const fields = (doc: any): Record<string, any> => Object.fromEntries(Object.entries(doc?.fields ?? {}).map(([k, v]) => [k, value(v)]));
const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const time = (v: unknown): string | null => {
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
};
const wire = (v: any): any => {
  if (v === null) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return { integerValue: String(v) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(wire) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) } };
};
const documentFields = (data: Record<string, any>, timestamps: string[] = []): WireFields =>
  Object.fromEntries(Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, timestamps.includes(k) && typeof v === "string" ? { timestampValue: v } : wire(v)]));
const documentRoot = (projectId: string): string =>
  `projects/${projectId}/databases/(default)/documents`;
const docId = (name: string): string => decodeURIComponent(name.slice(name.lastIndexOf("/") + 1));
const pathPart = (v: string): string => encodeURIComponent(v);
const reactedBy = (data: Record<string, any>, emoji: string, uid: string): boolean =>
  !!(data.reactions && typeof data.reactions === "object" && Array.isArray(data.reactions[emoji])
    && data.reactions[emoji].includes(uid));
function eventId(dealId: string, type: string, source: string): string {
  // A deterministic, path-safe ID makes retries and reaction re-toggles harmless.
  let hash = 2166136261;
  for (const c of `${dealId}\0${type}\0${source}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `${type}-${(hash >>> 0).toString(36)}`;
}
/** Append-only, deterministic audit records; failures never affect evidence/progress. */
async function auditDeal(projectId: string, token: string, id: string, uid: string, action: string, context: Record<string, unknown>): Promise<void> {
  try {
    const base = firestoreBase(projectId); const r = documentRoot(projectId);
    const writes = [
      { update: { name: `${r}/activityEvents/${pathPart(`deal-${id}`)}`, fields: documentFields({ uid, action, section: "deal" }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
      { update: { name: `${r}/investigationEvents/${pathPart(`deal-${id}`)}`, fields: documentFields({ uid, action, section: "deal", context }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
    ];
    await firestoreFetch(`${base}:commit`, token, { writes });
  } catch (err) { logger.warn({ err, id }, "deal audit write failed"); }
}

async function firestoreFetch(url: string, token: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function query(base: string, token: string, structuredQuery: any, transaction: string): Promise<any[]> {
  const res = await firestoreFetch(`${base}:runQuery`, token, { structuredQuery, ...(transaction ? { transaction } : {}) });
  if (!res.ok) throw new Error(`Firestore query failed (${res.status})`);
  return ((await res.json()) as any[]).map((r: any) => r.document).filter(Boolean);
}
async function getMany(base: string, token: string, names: string[], transaction: string): Promise<any[]> {
  const res = await firestoreFetch(`${base}:batchGet`, token, { documents: names, transaction });
  if (!res.ok) throw new Error(`Firestore read failed (${res.status})`);
  return ((await res.json()) as any[]).map((r: any) => r.found).filter(Boolean);
}

async function getOne(base: string, token: string, relative: string): Promise<Record<string, any> | null> {
  const res = await firestoreFetch(`${base}/${relative}`, token);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore evidence read failed (${res.status})`);
  return fields(await res.json());
}

/** Returns a canonical source only after checking the immutable/current producer. */
async function verifyEvidence(base: string, token: string, uid: string, type: string, source: string): Promise<string | null> {
  let m: RegExpExecArray | null;
  if (type === "black_book" && (m = /^entry:([A-Za-z0-9_-]{1,200})$/.exec(source))) {
    const d = await getOne(base, token, `blackBook/${pathPart(uid)}/entries/${pathPart(m[1])}`);
    // An administrator's Royals award is not an action by its recipient.
    return d && d.createdBy === uid ? source : null;
  }
  if (type === "target_whisper" && (m = /^ticket:([A-Za-z0-9_-]{1,200}):comment:([A-Za-z0-9_-]{1,200})$/.exec(source))) {
    const d = await getOne(base, token, `targetTickets/${pathPart(m[1])}/comments/${pathPart(m[2])}`);
    return d?.senderUid === uid ? source : null;
  }
  if (type === "mark" && (m = /^ticket:([A-Za-z0-9_-]{1,200})(?::comment:([A-Za-z0-9_-]{1,200}))?:(.{1,32})$/u.exec(source))) {
    const d = await getOne(base, token, m[2]
      ? `targetTickets/${pathPart(m[1])}/comments/${pathPart(m[2])}`
      : `targetTickets/${pathPart(m[1])}`);
    return d && reactedBy(d, m[3], uid) ? source : null;
  }
  if (type === "mark" && (m = /^table:([A-Za-z0-9_-]{1,200}):message:([A-Za-z0-9_-]{1,200}):(.{1,32})$/u.exec(source))) {
    const d = await getOne(base, token, `tableMessages/${pathPart(m[1])}/messages/${pathPart(m[2])}`);
    return d && reactedBy(d, m[3], uid) ? source : null;
  }
  if (type === "vault_mark" && (m = /^vault:([A-Za-z0-9_-]{1,200}):entry:(.{1,32})$/u.exec(source))) {
    const entry = await getOne(base, token, `vault/${pathPart(m[1])}`);
    return entry?.status === "published" && reactedBy(entry, m[2], uid) ? source : null;
  }
  if (type === "vault_mark" && (m = /^vault:([A-Za-z0-9_-]{1,200}):(comment|target):([A-Za-z0-9_-]{1,200}):(.{1,32})$/u.exec(source))) {
    const entry = await getOne(base, token, `vault/${pathPart(m[1])}`);
    if (entry?.status !== "published") return null;
    if (m[2] === "comment" && m[4]) {
      const d = await getOne(base, token, `vault/${pathPart(m[1])}/comments/${pathPart(m[3])}`);
      return d && reactedBy(d, m[4], uid) ? source : null;
    }
    if (m[2] === "target" && m[4]) {
      const d = await getOne(base, token, `vault/${pathPart(m[1])}/marks/${pathPart(`${m[3]}__${uid}`)}`);
      return d?.uid === uid && Array.isArray(d.emojis) && d.emojis.includes(m[4]) ? source : null;
    }
  }
  return null;
}

function activeDeal(docs: any[]): ActiveDeal | null {
  const now = Date.now();
  const candidates = docs.map(d => ({ id: docId(d.name), data: fields(d) })).map(({ id, data }) => {
    const publishedAt = time(data.publishedAt);
    const expiresAt = data.expiresAt === null ? null : time(data.expiresAt);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    if (data.status !== "published" || !publishedAt || (expiresAt && Date.parse(expiresAt) <= now) ||
      !tasks.length || tasks.length > 20 || !tasks.every(t => t && typeof t.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(t.id) && TASK_TYPES.has(t.type) && Number.isInteger(t.targetCount) && t.targetCount >= 1 && t.targetCount <= 100 && (t.assigneeUid === undefined || (typeof t.assigneeUid === "string" && t.assigneeUid.length > 0 && t.assigneeUid.length <= 128)))) return null;
    const normalizedTasks = tasks.map(t => ({ ...t, assigneeUid: typeof t.assigneeUid === "string" ? t.assigneeUid : null }));
    return { id, tasks: normalizedTasks, previousDealId: typeof data.previousDealId === "string" ? data.previousDealId : null, publishedAt, expiresAt } as ActiveDeal;
  }).filter((x): x is ActiveDeal => x !== null);
  return candidates.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] ?? null;
}
function parseCompletion(data: Record<string, any> | null, uid: string): Completion | null {
  if (!data) return null;
  if (data.uid !== uid || !data.taskCounts || typeof data.taskCounts !== "object" || !Array.isArray(data.completedTaskIds)) throw new Error("invalid stored completion");
  return { uid, taskCounts: data.taskCounts, completedTaskIds: data.completedTaskIds, completedAt: time(data.completedAt), updatedAt: time(data.updatedAt) };
}
function parseStats(data: Record<string, any> | null, uid: string): Stats | null {
  if (!data) return null;
  if (data.uid !== uid || !Number.isInteger(data.currentStreak) || !Number.isInteger(data.bestStreak)) throw new Error("invalid stored member stats");
  return { uid, currentStreak: data.currentStreak, bestStreak: data.bestStreak, lastCompletedDealId: data.lastCompletedDealId === null ? null : str(data.lastCompletedDealId), lastCompletedAt: time(data.lastCompletedAt), lastActivityAt: time(data.lastActivityAt) };
}

router.post("/deal/activity", async (req, res) => {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId || !adminConfigured()) return void res.status(500).json({ error: "deal activity not configured" });
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 2 || typeof body.type !== "string" || typeof body.sourceId !== "string"
    || body.sourceId.length === 0 || body.sourceId.length > 500 || !TASK_TYPES.has(body.type)) {
    return void res.status(400).json({ error: "invalid deal activity" });
  }
  const bearer = req.headers.authorization ?? "";
  const idToken = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  const uid = idToken ? await verifyFirebaseIdToken(idToken, projectId) : null;
  if (!uid) return void res.status(401).json({ error: "unauthorized" });
  const accessToken = await getAccessToken();
  if (!accessToken) return void res.status(500).json({ error: "deal activity not configured" });
  const base = firestoreBase(projectId);
  try {
    const deals = await query(base, accessToken, { from: [{ collectionId: "deals" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "published" } } } }, "");
    const deal = activeDeal(deals);
    if (!deal || !deal.tasks.some(t => t.type === body.type && (t.assigneeUid === null || t.assigneeUid === uid))) {
      return void res.status(409).json({ error: "no live Deal task assigned to this member accepts this activity" });
    }
    const canonicalSource = await verifyEvidence(base, accessToken, uid, body.type, body.sourceId);
    if (!canonicalSource) return void res.status(400).json({ error: "activity evidence was not verified" });
    const name = `${documentRoot(projectId)}/dealActivity/${pathPart(uid)}/events/${pathPart(eventId(deal.id, body.type, canonicalSource))}`;
    const commit = await firestoreFetch(`${base}:commit`, accessToken, { writes: [{
      update: { name, fields: documentFields({ uid, type: body.type, sourceId: canonicalSource }) },
      updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: false },
    }] });
    // ALREADY_EXISTS is the expected result for a deterministic retry.
    if (!commit.ok && commit.status !== 409 && commit.status !== 412) throw new Error(`Firestore activity commit failed (${commit.status})`);
    void auditDeal(projectId, accessToken, eventId(deal.id, body.type, canonicalSource), uid, "verified_evidence", { dealId: deal.id, type: body.type });
    // Rebuild counters from the immutable event immediately.  Reuse the same
    // trusted reconciliation path exposed for screen-entry repair; its result
    // is intentionally not allowed to turn a successful real action into a
    // client-visible failure.
    const internalResponse: any = {};
    internalResponse.status = () => internalResponse;
    internalResponse.json = () => internalResponse;
    await reconcileHandler({ body: {}, headers: { authorization: bearer } }, internalResponse);
    return void res.json({ added: commit.ok, dealId: deal.id });
  } catch (err) {
    logger.error({ err, uid }, "deal activity failed");
    return void res.status(500).json({ error: "deal activity failed" });
  }
});

async function reconcileHandler(req: any, res: any): Promise<void> {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId || !adminConfigured()) return void res.status(500).json({ error: "deal reconciliation not configured" });
  if (req.body && typeof req.body === "object" && ("uid" in req.body || "targetUid" in req.body)) return void res.status(400).json({ error: "target uid is not accepted" });
  const token = (req.headers.authorization ?? "").startsWith("Bearer ") ? (req.headers.authorization ?? "").slice(7) : "";
  const uid = token ? await verifyFirebaseIdToken(token, projectId) : null;
  if (!uid) return void res.status(401).json({ error: "unauthorized" });
  const accessToken = await getAccessToken();
  if (!accessToken) return void res.status(500).json({ error: "deal reconciliation not configured" });
  const base = firestoreBase(projectId);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const begin = await firestoreFetch(`${base}:beginTransaction`, accessToken, {});
      if (!begin.ok) throw new Error(`Firestore transaction failed (${begin.status})`);
      const transaction = ((await begin.json()) as { transaction?: string }).transaction ?? "";
      if (!transaction) throw new Error("Firestore transaction did not start");
      const deals = await query(base, accessToken, { from: [{ collectionId: "deals" }], where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "published" } } } }, transaction);
      const deal = activeDeal(deals);
      if (!deal) return void res.json({ completion: null, stats: null });
      const activityQuery = {
        from: [{ collectionId: "events" }],
        where: { compositeFilter: { op: "AND", filters: [
          { fieldFilter: { field: { fieldPath: "occurredAt" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: deal.publishedAt } } },
          ...(deal.expiresAt ? [{ fieldFilter: { field: { fieldPath: "occurredAt" }, op: "LESS_THAN", value: { timestampValue: deal.expiresAt } } }] : []),
        ] } },
        orderBy: [{ field: { fieldPath: "occurredAt" }, direction: "ASCENDING" }],
      };
      const activities = await query(`${base}/dealActivity/${encodeURIComponent(uid)}`, accessToken, activityQuery, transaction);
      const root = documentRoot(projectId);
      const userName = `${root}/users/${encodeURIComponent(uid)}`;
      const names = [
        `${root}/dealCompletions/${encodeURIComponent(deal.id)}/members/${encodeURIComponent(uid)}`,
        `${root}/dealMemberStats/${encodeURIComponent(uid)}`,
        userName,
      ];
      const existing = await getMany(base, accessToken, names, transaction);
      const userDoc = existing.find(d => d.name === userName);
      if (userDoc && fields(userDoc).suspended === true) {
        await firestoreFetch(`${base}:rollback`, accessToken, { transaction });
        return void res.status(403).json({ error: "suspended members cannot reconcile Deals" });
      }
      const completionDoc = existing.find(d => d.name === names[0]);
      const statsDoc = existing.find(d => d.name === names[1]);
      const completion = parseCompletion(completionDoc ? fields(completionDoc) : null, uid);
      const stats = parseStats(statsDoc ? fields(statsDoc) : null, uid);
      const countsByType: Record<string, number> = {};
      let latestActivityAt: string | null = null;
      for (const activity of activities.map(fields)) {
        const at = time(activity.occurredAt);
        if (!at || typeof activity.type !== "string" || !TASK_TYPES.has(activity.type) || activity.uid !== uid || typeof activity.sourceId !== "string") throw new Error("invalid stored deal activity");
        countsByType[activity.type] = (countsByType[activity.type] ?? 0) + 1;
        latestActivityAt = at;
      }
      const assignedTasks = deal.tasks.filter(t => t.assigneeUid === null || t.assigneeUid === uid);
      const taskCounts = Object.fromEntries(assignedTasks.map(t => [t.id, countsByType[t.type] ?? 0]));
      const completedTaskIds = assignedTasks.filter(t => taskCounts[t.id] >= t.targetCount).map(t => t.id);
      const complete = assignedTasks.length > 0 && completedTaskIds.length === assignedTasks.length;
      const newCompletionTime = complete && !completion?.completedAt;
      const completionData = { uid, taskCounts, completedTaskIds, completedAt: newCompletionTime ? undefined : (complete ? completion?.completedAt : null) };
      const writes: any[] = [{ update: { name: names[0], fields: documentFields(completionData, ["completedAt"]) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }] }];
      let outputStats: Stats | null = stats;
      if (complete) {
        const sameDeal = stats?.lastCompletedDealId === deal.id;
        const currentStreak = sameDeal ? Math.max(1, stats?.currentStreak ?? 1) : deal.previousDealId && stats?.lastCompletedDealId === deal.previousDealId ? (stats?.currentStreak ?? 0) + 1 : 1;
        outputStats = { uid, currentStreak, bestStreak: Math.max(stats?.bestStreak ?? 0, currentStreak), lastCompletedDealId: deal.id, lastCompletedAt: completion?.completedAt ?? null, lastActivityAt: latestActivityAt ?? stats?.lastActivityAt ?? null };
      } else if (latestActivityAt) {
        outputStats = { uid, currentStreak: stats?.currentStreak ?? 0, bestStreak: stats?.bestStreak ?? 0, lastCompletedDealId: stats?.lastCompletedDealId ?? null, lastCompletedAt: stats?.lastCompletedAt ?? null, lastActivityAt: latestActivityAt };
      }
      if (outputStats && (complete || latestActivityAt)) {
        const data: Record<string, any> = { ...outputStats };
        const newCompletedAt = complete && !completion?.completedAt;
        if (newCompletedAt) data.lastCompletedAt = undefined;
        writes.push({ update: { name: names[1], fields: documentFields(data, ["lastCompletedAt", "lastActivityAt"]) }, updateTransforms: [
          ...(newCompletedAt ? [{ fieldPath: "lastCompletedAt", setToServerValue: "REQUEST_TIME" }] : []),
        ] });
      }
      if (newCompletionTime) writes[0].updateTransforms.unshift({ fieldPath: "completedAt", setToServerValue: "REQUEST_TIME" });
      const commit = await firestoreFetch(`${base}:commit`, accessToken, { transaction, writes });
      if (commit.status === 409 || commit.status === 412) continue;
      if (!commit.ok) throw new Error(`Firestore commit failed (${commit.status})`);
      const commitTime = ((await commit.json()) as { commitTime?: string }).commitTime;
      if (!commitTime || !Number.isFinite(Date.parse(commitTime))) throw new Error("Firestore commit returned no timestamp");
      const result: Completion = { uid, taskCounts, completedTaskIds, completedAt: complete ? (completion?.completedAt ?? commitTime) : null, updatedAt: commitTime };
      if (newCompletionTime) void auditDeal(projectId, accessToken, `completion-${deal.id}-${uid}`, uid, "deal_completed", { dealId: deal.id, taskCount: assignedTasks.length });
      if (outputStats) {
        if (complete && !completion?.completedAt) outputStats.lastCompletedAt = commitTime;
      }
      return void res.json({ completion: result, stats: outputStats });
    }
    res.status(409).json({ error: "deal reconciliation conflicted; retry" });
  } catch (err) {
    logger.error({ err, uid }, "deal reconciliation failed");
    res.status(500).json({ error: "deal reconciliation failed" });
  }
}

router.post("/deal/reconcile", reconcileHandler);

export default router;