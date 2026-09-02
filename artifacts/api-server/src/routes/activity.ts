import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

/** Body-free seat activity.  This is intentionally separate from investigations. */
const router: IRouter = Router();
const CATEGORIES = ["login", "conversation", "participation", "deal_suits"] as const;
type Category = typeof CATEGORIES[number];
type Value = { stringValue?: string; integerValue?: string; timestampValue?: string; booleanValue?: boolean };
type FireDoc = { name?: string; fields?: Record<string, Value> };
type Auth = {
  uid: string;
  project: string;
  token: string;
  base: string;
  jester: boolean;
  handAdmin: boolean;
};
const UID = /^[A-Za-z0-9:_-]{1,128}$/;
const DAY = 86_400_000;

const val = (v?: Value): string | number | boolean | null =>
  typeof v?.stringValue === "string" ? v.stringValue
    : typeof v?.timestampValue === "string" ? v.timestampValue
      : typeof v?.integerValue === "string" ? Number(v.integerValue)
        : typeof v?.booleanValue === "boolean" ? v.booleanValue : null;
const date = (v: unknown): number | null => {
  if (typeof v === "number") return v > 1e11 ? v : null;
  if (typeof v === "string") { const d = Date.parse(v); return Number.isNaN(d) ? null : d; }
  return null;
};
const fields = (d?: FireDoc) => Object.fromEntries(Object.entries(d?.fields ?? {}).map(([k, v]) => [k, val(v)]));

async function auth(req: Request): Promise<Auth | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const uid = project && bearer ? await verifyFirebaseIdToken(bearer, project) : null;
  const token = uid && adminConfigured() ? await getAccessToken() : null;
  if (!project || !uid || !token) return null;
  const base = firestoreBase(project);
  const response = await fetch(`${base}/users/${encodeURIComponent(uid)}?mask.fieldPaths=jokerId&mask.fieldPaths=isAdmin&mask.fieldPaths=suspended`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const user = fields(await response.json() as FireDoc);
  if (user.suspended === true) return null;
  const jokerId = user.jokerId;
  const admin = user.isAdmin === true;
  return {
    uid,
    project,
    token,
    base,
    jester: admin && jokerId === "00-00",
    handAdmin: admin && (jokerId === "00-00" || jokerId === "01-54"),
  };
}
async function runQuery(a: Auth, parent: string, query: unknown): Promise<FireDoc[]> {
  const response = await fetch(`${a.base}${parent}:runQuery`, {
    method: "POST", headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: query }),
  });
  if (!response.ok) throw new Error(`activity query failed (${response.status})`);
  return (await response.json() as Array<{ document?: FireDoc }>).flatMap(row => row.document ? [row.document] : []);
}
async function getDoc(a: Auth, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${a.base}/${path}`, { headers: { Authorization: `Bearer ${a.token}` } });
  return response.ok ? fields(await response.json() as FireDoc) : {};
}
async function safeQuery(a: Auth, label: string, parent: string, query: unknown): Promise<FireDoc[]> {
  try { return await runQuery(a, parent, query); }
  catch (err) { logger.warn({ err, label }, "seat activity source unavailable"); return []; }
}
function push(events: Array<{ category: Category; at: number }>, category: Category, at: unknown) {
  const ms = date(at); if (ms && ms <= Date.now() + 60_000 && ms > Date.now() - 31 * DAY) events.push({ category, at: ms });
}
/** Pure scorer: five fresh Black Book entries plus a filed Ticket is Warm. */
export function scoreSeatEvents(events: Array<{ category: Category; at: number }>, now = Date.now()) {
  const counts: Record<Category, number> = { login: 0, conversation: 0, participation: 0, deal_suits: 0 };
  const timestamps: Partial<Record<Category, string>> = {};
  let score = 0;
  events.forEach(e => {
    counts[e.category]++;
    if (!timestamps[e.category] || e.at > Date.parse(timestamps[e.category]!)) {
      timestamps[e.category] = new Date(e.at).toISOString();
    }
    const base = e.category === "participation"
      ? 6
      : e.category === "deal_suits"
        ? 12
        : e.category === "conversation"
          ? 5
          : 3;
    score += base * Math.exp(-(now - e.at) / (7 * DAY));
  });
  score = Math.round(Math.min(100, score));
  const active = CATEGORIES.filter(c => counts[c] > 0);
  return {
    score,
    temperature: active.length === CATEGORIES.length && score >= 55
      ? "Hot"
      : counts.participation > 0 && score >= 24
        ? "Warm"
        : score > 0
          ? "Lukewarm"
          : "Cold",
    counts,
    timestamps,
  };
}

router.get(["/activity/summary", "/activity/summary/:uid"], async (req, res) => {
  const rawRequested = req.params.uid;
  const requested = Array.isArray(rawRequested) ? rawRequested[0] : rawRequested;
  try {
    const a = await auth(req); if (!a) return void res.status(401).json({ error: "authentication required" });
    const target = requested || a.uid;
    if (!UID.test(target)) return void res.status(400).json({ error: "invalid target uid" });
    if (target !== a.uid && !a.handAdmin) return void res.status(403).json({ error: "activity is private" });
    const events: Array<{ category: Category; at: number }> = [];
    const bySender = { where: { fieldFilter: { field: { fieldPath: "senderUid" }, op: "EQUAL", value: { stringValue: target } } }, limit: 150 };
    const [generic, sessions, blackbook, user, deal, messages, antePosts, comments, targets] = await Promise.all([
      safeQuery(a, "server audit", "", { from: [{ collectionId: "activityEvents" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: target } } }, limit: 500 }),
      safeQuery(a, "sessions", `/sessions/${encodeURIComponent(target)}`, { from: [{ collectionId: "logs" }], orderBy: [{ field: { fieldPath: "startedAt" }, direction: "DESCENDING" }], limit: 100 }),
      safeQuery(a, "black book", `/blackBook/${encodeURIComponent(target)}`, { from: [{ collectionId: "entries" }], orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }], limit: 100 }),
      getDoc(a, `users/${encodeURIComponent(target)}?mask.fieldPaths=filedAt&mask.fieldPaths=updatedAt&mask.fieldPaths=filed`),
      safeQuery(a, "deal", `/dealActivity/${encodeURIComponent(target)}`, { from: [{ collectionId: "events" }], orderBy: [{ field: { fieldPath: "occurredAt" }, direction: "DESCENDING" }], limit: 100 }),
      safeQuery(a, "messages", "", { ...bySender, from: [{ collectionId: "messages", allDescendants: true }] }),
      safeQuery(a, "ante posts", "", { ...bySender, from: [{ collectionId: "posts", allDescendants: true }] }),
      safeQuery(a, "comments", "", { ...bySender, from: [{ collectionId: "comments", allDescendants: true }] }),
      safeQuery(a, "target tickets", "", { ...bySender, from: [{ collectionId: "targetTickets" }] }),
    ]);
    generic.forEach(doc => { const d = fields(doc); if (String(d.section ?? "").toLowerCase() === "suits") push(events, "deal_suits", d.occurredAt ?? d.at ?? d.createdAt ?? d.timestamp); });
    sessions.forEach(doc => push(events, "login", fields(doc).startedAt));
    blackbook.forEach(doc => push(events, "participation", fields(doc).createdAt ?? fields(doc).updatedAt));
    push(events, "participation", user.filedAt); push(events, "participation", user.updatedAt);
    deal.forEach(doc => push(events, "deal_suits", fields(doc).occurredAt));
    messages.forEach(doc => push(events, "conversation", fields(doc).sentAt ?? fields(doc).createdAt));
    antePosts.forEach(doc => push(events, "participation", fields(doc).createdAt));
    comments.forEach(doc => push(events, "participation", fields(doc).createdAt));
    targets.forEach(doc => push(events, "participation", fields(doc).createdAt ?? fields(doc).updatedAt));
    const { score, temperature, counts, timestamps } = scoreSeatEvents(events);
    const latest = events.reduce((m, e) => Math.max(m, e.at), 0);
    const mayInspectActivity = target === a.uid || a.jester;
    return void res.json({
      score: mayInspectActivity ? score : null,
      temperature,
      lastActivityAt: mayInspectActivity && latest ? new Date(latest).toISOString() : null,
      categoryCounts: mayInspectActivity
        ? counts
        : { login: 0, conversation: 0, participation: 0, deal_suits: 0 },
      categoryTimestamps: mayInspectActivity ? timestamps : {},
    });
  } catch (err) { logger.error({ err }, "seat activity summary failed"); return void res.status(500).json({ error: "activity summary failed" }); }
});

export default router;