import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";
import {
  APP_ICON_IDS, scoreIconEvents, scoreSeatEvents,
  type AppIconId, type IconActivityEvent, type SeatCategory, type SeatEvent,
} from "../lib/seatScoring";

/** Body-free seat activity.  This is intentionally separate from investigations. */
const router: IRouter = Router();
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
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`activity query failed (${response.status}): ${detail}`);
  }
  return (await response.json() as Array<{ document?: FireDoc }>).flatMap(row => row.document ? [row.document] : []);
}
async function getDoc(a: Auth, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${a.base}/${path}`, { headers: { Authorization: `Bearer ${a.token}` } });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`activity document lookup failed (${response.status})`);
  return fields(await response.json() as FireDoc);
}
function docId(doc: FireDoc): string {
  const name = doc.name ?? "";
  return decodeURIComponent(name.slice(name.lastIndexOf("/") + 1));
}
function push(events: SeatEvent[], category: SeatCategory, at: unknown, key?: string) {
  const ms = date(at);
  if (ms && ms <= Date.now() + 60_000 && ms > Date.now() - 31 * DAY) {
    events.push({ category, at: ms, ...(key ? { key } : {}) });
  }
}
function pushIcon(
  events: IconActivityEvent[],
  icon: AppIconId,
  at: unknown,
  key: string,
  points = 6,
) {
  const ms = date(at);
  if (ms && ms <= Date.now() + 60_000 && ms > Date.now() - 31 * DAY) {
    events.push({ icon, at: ms, key, points });
  }
}
function genericIcon(section: string): AppIconId | null {
  const value = section.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (value.includes("pocket")) return "pocket";
  if (value.includes("black_book")) return "street_art";
  if (value.includes("street_art")) return "street_art";
  if (value.includes("jester_s_deal") || value === "deal") return "jesters_deal";
  if (value.includes("suits")) return "suits";
  if (value.includes("ante")) return "ante";
  if (value.includes("table")) return "table";
  if (value.includes("target")) return "target_ticket";
  if (value.includes("recruit")) return "recruit";
  if (value.includes("vault")) return "vault";
  if (value.includes("chamber")) return "chamber";
  if (value.includes("uniform")) return "uniform";
  if (value.includes("jester_s_hand")) return "jesters_hand";
  if (value === "the_hand" || value === "hand") return "hand";
  if (value.includes("ticket") || value.includes("profile")) return "ticket";
  if (value.includes("system")) return "system";
  return null;
}
function pathIcon(name = ""): AppIconId | null {
  if (name.includes("/conversations/")) return "pocket";
  if (name.includes("/tableChannels/") || name.includes("/tableMessages/")) return "table";
  if (name.includes("/anteBoards/") || name.includes("/antePosts/")) return "ante";
  if (name.includes("/targetTickets/")) return "target_ticket";
  if (name.includes("/recruitPosts/")) return "recruit";
  if (name.includes("/vault")) return "vault";
  if (name.toLowerCase().includes("/streetart")) return "street_art";
  return null;
}
router.get(["/activity/summary", "/activity/summary/:uid"], async (req, res) => {
  const rawRequested = req.params.uid;
  const requested = Array.isArray(rawRequested) ? rawRequested[0] : rawRequested;
  try {
    const a = await auth(req); if (!a) return void res.status(401).json({ error: "authentication required" });
    const target = requested || a.uid;
    if (!UID.test(target)) return void res.status(400).json({ error: "invalid target uid" });
    if (target !== a.uid && !a.handAdmin) return void res.status(403).json({ error: "activity is private" });
    const events: SeatEvent[] = [];
    const iconEvents: IconActivityEvent[] = [];
    const cutoff = new Date(Date.now() - 31 * DAY).toISOString();
    const since = (fieldPath: string) => ({
      fieldFilter: {
        field: { fieldPath },
        op: "GREATER_THAN_OR_EQUAL",
        value: { timestampValue: cutoff },
      },
    });
    const byActorSince = (actorField: string, dateField: string, selected: string[] = []) => ({
      where: { compositeFilter: { op: "AND", filters: [
        { fieldFilter: { field: { fieldPath: actorField }, op: "EQUAL", value: { stringValue: target } } },
        since(dateField),
      ] } },
      orderBy: [{ field: { fieldPath: dateField }, direction: "DESCENDING" }],
      select: { fields: [actorField, dateField, ...selected].map(fieldPath => ({ fieldPath })) },
    });
    const [
      genericOccurredAt, genericAt, genericCreatedAt, genericTimestamp,
      sessions, blackbook, authoredBlackbook, user, deal, messages,
      conversations, antePosts, comments, targets, recruitPosts,
    ] = await Promise.all([
      runQuery(a, "", { ...byActorSince("uid", "occurredAt", ["action", "type", "section", "category", "icon"]), from: [{ collectionId: "activityEvents" }] }),
      runQuery(a, "", { ...byActorSince("uid", "at", ["action", "type", "section", "category", "icon"]), from: [{ collectionId: "activityEvents" }] }),
      runQuery(a, "", { ...byActorSince("uid", "createdAt", ["action", "type", "section", "category", "icon"]), from: [{ collectionId: "activityEvents" }] }),
      runQuery(a, "", { ...byActorSince("uid", "timestamp", ["action", "type", "section", "category", "icon"]), from: [{ collectionId: "activityEvents" }] }),
      runQuery(a, `/sessions/${encodeURIComponent(target)}`, {
        from: [{ collectionId: "logs" }],
        where: since("startedAt"),
        orderBy: [{ field: { fieldPath: "startedAt" }, direction: "DESCENDING" }],
      }),
      runQuery(a, `/blackBook/${encodeURIComponent(target)}`, {
        from: [{ collectionId: "entries" }],
        where: since("createdAt"),
        orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      }),
      runQuery(a, "", {
        ...byActorSince("createdBy", "createdAt", ["tab"]),
        from: [{ collectionId: "entries", allDescendants: true }],
      }),
      getDoc(a, `users/${encodeURIComponent(target)}?mask.fieldPaths=filedAt&mask.fieldPaths=filed`),
      runQuery(a, `/dealActivity/${encodeURIComponent(target)}`, {
        from: [{ collectionId: "events" }],
        where: since("occurredAt"),
        orderBy: [{ field: { fieldPath: "occurredAt" }, direction: "DESCENDING" }],
      }),
      runQuery(a, "", { ...byActorSince("senderUid", "sentAt", ["createdAt"]), from: [{ collectionId: "messages", allDescendants: true }] }),
      runQuery(a, "", { ...byActorSince("createdBy", "createdAt"), from: [{ collectionId: "conversations" }] }),
      runQuery(a, "", { ...byActorSince("senderUid", "createdAt"), from: [{ collectionId: "posts", allDescendants: true }] }),
      runQuery(a, "", { ...byActorSince("senderUid", "createdAt"), from: [{ collectionId: "comments", allDescendants: true }] }),
      runQuery(a, "", { ...byActorSince("senderUid", "createdAt"), from: [{ collectionId: "targetTickets" }] }),
      runQuery(a, "", { ...byActorSince("createdBy", "createdAt", ["section", "status"]), from: [{ collectionId: "recruitPosts" }] }),
    ]);
    const generic = [...genericOccurredAt, ...genericAt, ...genericCreatedAt, ...genericTimestamp];
    generic.forEach(doc => {
      const d = fields(doc);
      const section = String(d.section ?? "").toLowerCase();
      const id = docId(doc);
      const occurredAt = d.occurredAt ?? d.at ?? d.createdAt ?? d.timestamp;
      if (d.category === "app_usage") return;
      const icon = genericIcon(String(d.icon ?? d.section ?? d.category ?? ""));
      if (icon) pushIcon(iconEvents, icon, occurredAt, `audit:${doc.name}`, 8);
      if (section === "deal") {
        push(events, "deal_suits", occurredAt, `deal:${id.replace(/^deal-/, "")}`);
      } else if (section === "suits") {
        push(events, "deal_suits", occurredAt, `suits:${doc.name}`);
      } else {
        push(events, "participation", occurredAt, `audit:${doc.name}`);
      }
    });
    sessions.forEach(doc => push(events, "login", fields(doc).startedAt, `login:${doc.name}`));
    blackbook.forEach(doc => {
      push(events, "participation", fields(doc).createdAt, `blackbook:${docId(doc)}`);
      pushIcon(iconEvents, "street_art", fields(doc).createdAt, `blackbook:${docId(doc)}`, 8);
    });
    authoredBlackbook.forEach(doc => {
      push(events, "participation", fields(doc).createdAt, `blackbook:${docId(doc)}`);
      pushIcon(iconEvents, "street_art", fields(doc).createdAt, `blackbook:${docId(doc)}`, 8);
    });
    push(events, "participation", user.filedAt, `ticket-filed:${target}`);
    pushIcon(iconEvents, "ticket", user.filedAt, `ticket-filed:${target}`, 8);
    deal.forEach(doc => {
      const d = fields(doc);
      const sourceId = String(d.sourceId ?? "");
      const type = String(d.type ?? "");
      const blackBookId = type === "black_book" && sourceId.startsWith("entry:") ? sourceId.slice(6) : "";
      push(
        events,
        blackBookId ? "participation" : "deal_suits",
        d.occurredAt,
        blackBookId ? `blackbook:${blackBookId}` : `deal:${doc.name}`,
      );
      pushIcon(
        iconEvents,
        blackBookId ? "street_art" : "jesters_deal",
        d.occurredAt,
        blackBookId ? `blackbook:${blackBookId}` : `deal:${doc.name}`,
        blackBookId ? 8 : 12,
      );
    });
    messages.forEach(doc => {
      const at = fields(doc).sentAt ?? fields(doc).createdAt;
      push(events, "conversation", at, `message:${doc.name}`);
      const icon = pathIcon(doc.name);
      if (icon) pushIcon(iconEvents, icon, at, `message:${doc.name}`, 6);
    });
    conversations.forEach(doc => {
      push(events, "conversation", fields(doc).createdAt, `conversation:${docId(doc)}`);
      pushIcon(iconEvents, "pocket", fields(doc).createdAt, `conversation:${docId(doc)}`, 8);
    });
    antePosts.forEach(doc => {
      push(events, "participation", fields(doc).createdAt, `ante:${doc.name}`);
      pushIcon(iconEvents, "ante", fields(doc).createdAt, `ante:${doc.name}`, 8);
    });
    comments.forEach(doc => {
      push(events, "participation", fields(doc).createdAt, `comment:${doc.name}`);
      const icon = pathIcon(doc.name);
      if (icon) pushIcon(iconEvents, icon, fields(doc).createdAt, `comment:${doc.name}`, 6);
    });
    targets.forEach(doc => {
      push(events, "participation", fields(doc).createdAt, `target:${doc.name}`);
      pushIcon(iconEvents, "target_ticket", fields(doc).createdAt, `target:${doc.name}`, 8);
    });
    recruitPosts.forEach(doc => {
      const d = fields(doc);
      pushIcon(iconEvents, "recruit", d.createdAt, `recruit:${doc.name}`, 8);
      if (d.section === "verdict" && d.status === "published") {
        push(events, "participation", d.createdAt, `verdict:${doc.name}`);
      }
    });
    const { score, temperature, counts, timestamps } = scoreSeatEvents(events);
    const latest = Object.values(timestamps).reduce((max, timestamp) =>
      Math.max(max, timestamp ? Date.parse(timestamp) : 0), 0);
    const mayInspectActivity = target === a.uid || a.jester;
    return void res.json({
      score: mayInspectActivity ? score : null,
      temperature,
      lastActivityAt: mayInspectActivity && latest ? new Date(latest).toISOString() : null,
      categoryCounts: mayInspectActivity
        ? counts
        : { login: 0, conversation: 0, participation: 0, deal_suits: 0 },
      categoryTimestamps: mayInspectActivity ? timestamps : {},
      iconSummaries: mayInspectActivity ? scoreIconEvents(iconEvents) : null,
    });
  } catch (err) { logger.error({ err }, "seat activity summary failed"); return void res.status(500).json({ error: "activity summary failed" }); }
});

export default router;