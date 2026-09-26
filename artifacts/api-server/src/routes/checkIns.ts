import { randomBytes, createHash } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import webpush from "web-push";
import { checkInDayKey as dayKey, runCheckInBatch } from "../lib/checkInBatch";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, clearDeadWebPushSub, firestoreBase, getAccessToken, getUserPushTargets } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const enc = encodeURIComponent;
const root = (project: string) => `${firestoreBase(project)}`;
const documentName = (project: string, path: string) => `projects/${project}/databases/(default)/documents/${path}`;
const PINNED = new Set(["00-00", "01-54"]);
const SYSTEM_SENDER_UID = "check-in-system";
type Doc = { name?: string; fields?: Record<string, any>; updateTime?: string };
type Auth = { project: string; uid: string; token: string; jokerId: string };
type CheckInMilestone = { milestoneId: string; dateKey: string; streak: number; earnedAt: string; rewardType?: string; description?: string };
type PendingMilestone = { milestoneId: string; streak: number };
type Ledger = {
  history: Array<{ dateKey: string; checkedInAt?: string }>;
  pending: PendingMilestone[];
  milestones: CheckInMilestone[];
  issued: Record<string, string>;
  streak: number;
  bestStreak: number;
  total: number;
};
const field = (v: any): any => !v || typeof v !== "object" ? null : "stringValue" in v ? v.stringValue : "booleanValue" in v ? v.booleanValue : "integerValue" in v ? Number(v.integerValue) : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(field) : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, field(x)])) : null;
const read = (d: Doc | null) => Object.fromEntries(Object.entries(d?.fields ?? {}).map(([k, v]) => [k, field(v)]));
const wire = (v: any): any => v === null ? { nullValue: null } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(wire) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) } };
const fields = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
const precondition = (doc: Doc | null) => doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyLedger = (): Ledger => ({ history: [], pending: [], milestones: [], issued: {}, streak: 0, bestStreak: 0, total: 0 });
let vapidReady: boolean | null = null;
function webPushConfigured() {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env["VAPID_PUBLIC_KEY"], priv = process.env["VAPID_PRIVATE_KEY"];
  if (!pub || !priv) return (vapidReady = false);
  try {
    webpush.setVapidDetails(process.env["VAPID_SUBJECT"] ?? "mailto:admin@jestershand.local", pub, priv);
    vapidReady = true;
  } catch (err) {
    logger.warn({ err }, "check-in web push configuration invalid");
    vapidReady = false;
  }
  return vapidReady;
}
function emptyMap(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}
function canonicalCheckInEntry(doc: Doc, data: Record<string, any>, expected: {
  tab: string; title: string; date: string; notes: string; createdBy: string;
}) {
  const keys = Object.keys(doc.fields ?? {}).sort();
  const expectedKeys = ["commentCount", "createdAt", "createdBy", "date", "notes", "reactions", "tab", "title"].sort();
  return keys.join("\0") === expectedKeys.join("\0")
    && data.tab === expected.tab
    && data.title === expected.title
    && data.date === expected.date
    && data.notes === expected.notes
    && data.createdBy === expected.createdBy
    && data.commentCount === 0
    && emptyMap(data.reactions)
    && typeof doc.fields?.["createdAt"]?.timestampValue === "string";
}
function asLedger(data: Record<string, any>): Ledger {
  const milestones: CheckInMilestone[] = (Array.isArray(data.milestones) ? data.milestones : []).flatMap((m: any, index: number) => {
    if (!m || !Number.isInteger(m.streak)) return [];
    const dateKey = typeof m.dateKey === "string" ? m.dateKey
      : typeof m.milestoneId === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.milestoneId) ? m.milestoneId
      : typeof m.earnedAt === "string" && !Number.isNaN(Date.parse(m.earnedAt)) ? dayKey(new Date(m.earnedAt))
      : `legacy-${m.streak}-${index}`;
    const milestoneId = typeof m.milestoneId === "string" ? m.milestoneId : dateKey;
    return [{ ...m, milestoneId, dateKey, earnedAt: typeof m.earnedAt === "string" ? m.earnedAt : `${dateKey}T00:00:00.000Z` }];
  });
  const pending: PendingMilestone[] = (Array.isArray(data.pending) ? data.pending : []).flatMap((item: any) => {
    if (item && typeof item.milestoneId === "string" && Number.isInteger(item.streak)) return [{ milestoneId: item.milestoneId, streak: item.streak }];
    if (Number.isInteger(item)) {
      const occurrence = [...milestones].reverse().find(m => m.streak === item && !m.rewardType);
      return [{ milestoneId: occurrence?.milestoneId ?? `legacy-${item}`, streak: item }];
    }
    return [];
  });
  return {
    history: Array.isArray(data.history) ? data.history : [],
    pending,
    milestones,
    issued: data.issued && typeof data.issued === "object" ? data.issued : {},
    streak: Number.isInteger(data.streak) ? data.streak : 0,
    bestStreak: Number.isInteger(data.bestStreak) ? data.bestStreak : 0,
    total: Number.isInteger(data.total) ? data.total : 0,
  };
}
function yesterdayKey(today: string) {
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}
function currentStreak(ledger: Ledger, today: string) {
  const latest = ledger.history.reduce((date, item) => item.dateKey > date ? item.dateKey : date, "");
  return latest >= yesterdayKey(today) ? ledger.streak : 0;
}
async function api(url: string, token: string, init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}
async function getDoc(a: Auth, path: string): Promise<Doc | null> {
  const r = await api(`${root(a.project)}/${path}`, a.token);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore read failed (${r.status})`);
  return await r.json() as Doc;
}
async function commit(a: Auth, writes: unknown[]) {
  return api(`${root(a.project)}:commit`, a.token, { method: "POST", body: JSON.stringify({ writes }) });
}
const isPreconditionConflict = (status: number) => status === 400 || status === 409 || status === 412;
async function authenticate(req: Request): Promise<Auth | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bearer = req.headers.authorization ?? "";
  const uid = project && bearer.startsWith("Bearer ") ? await verifyFirebaseIdToken(bearer.slice(7), project) : null;
  const token = uid && adminConfigured() ? await getAccessToken() : null;
  if (!project || !uid || !token) return null;
  const user = read(await getDoc({ project, uid, token, jokerId: "" }, `users/${enc(uid)}`));
  if (!user.jokerId) return null;
  return { project, uid, token, jokerId: user.jokerId };
}
async function activeCaller(req: Request, dealer = false): Promise<Auth | null> {
  const a = await authenticate(req);
  if (!a) return null;
  const user = read(await getDoc(a, `users/${enc(a.uid)}`));
  if (!user.jokerId || user.suspended === true) return null;
  if (dealer && (user.isAdmin !== true || !PINNED.has(a.jokerId))) return null;
  return a;
}
async function userList(a: Auth): Promise<Array<{ uid: string; data: Record<string, any> }>> {
  const r = await api(`${root(a.project)}:runQuery`, a.token, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }] } }) });
  if (!r.ok) throw new Error(`user query failed (${r.status})`);
  const rows = await r.json() as Array<{ document?: Doc }>;
  return rows.flatMap(row => {
    const d = row.document;
    if (!d?.name) return [];
    return [{ uid: decodeURIComponent(d.name.slice(d.name.lastIndexOf("/") + 1)), data: read(d) }];
  });
}
const ledgerPath = (uid: string) => `checkInLedger/${enc(uid)}`;
async function getLedger(a: Auth, uid: string) {
  const doc = await getDoc(a, ledgerPath(uid));
  return { doc, value: asLedger(read(doc)) };
}
function state(ledger: Ledger, today: string) {
  return {
    dateKey: today,
    issuedToday: typeof ledger.issued[today] === "string",
    checkedInToday: ledger.history.some(x => x.dateKey === today),
    streak: currentStreak(ledger, today),
    bestStreak: ledger.bestStreak,
    total: ledger.total,
    history: [...ledger.history].sort((a, b) => b.dateKey.localeCompare(a.dateKey)),
    milestones: ledger.milestones,
  };
}
function batchLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  })).then(() => out);
}

async function notify(a: Auth, uid: string, conversationId: string): Promise<boolean> {
  try {
    const target = await getUserPushTargets(a.project, uid);
    if (target?.alertsMuted) return true;
    if (!target) return false;
    const title = "A private check-in is ready";
    const body = "Your private Pocket has a check-in waiting.";
    const data = { type: "message", conversationId };
    const deliveries: Promise<boolean>[] = [];
    if (target.expoPushToken) deliveries.push((async () => {
      try {
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ to: target.expoPushToken, title, body, sound: "default", channelId: "dispatches", priority: "high", data }]),
        });
        const result = await response.json().catch(() => ({})) as { data?: Array<{ status?: string; details?: { error?: string } }> };
        if (!response.ok) {
          logger.warn({ status: response.status }, "check-in Expo push request failed");
          return false;
        } else if (result.data?.some(ticket => ticket.status === "error")) {
          logger.warn({ errors: result.data.filter(ticket => ticket.status === "error").map(ticket => ticket.details?.error ?? "unknown") }, "check-in Expo push ticket failed");
          return false;
        }
        return result.data?.some(ticket => ticket.status === "ok") ?? false;
      } catch (err) {
        logger.warn({ err }, "check-in Expo push request failed");
        return false;
      }
    })());
    if (target.webSubs.length && !webPushConfigured()) {
      logger.warn("check-in web push requested but VAPID keys are not configured");
    } else if (target.webSubs.length) {
      for (const sub of target.webSubs) deliveries.push((async () => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify({ title, body, data }),
            { TTL: 3600 },
          );
          return true;
        } catch (err) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) void clearDeadWebPushSub(a.project, sub.endpoint);
          else logger.warn({ status }, "check-in web push delivery failed");
          return false;
        }
      })());
    }
    const results = await Promise.allSettled(deliveries);
    return results.some(result => result.status === "fulfilled" && result.value === true);
  } catch (err) { logger.warn({ err, uid }, "check-in push failed"); return false; }
}
async function issueOne(a: Auth, uid: string, today: string, dealers: string[]): Promise<"issued" | "issued_push_failed" | "already" | "failed" | "stale"> {
  try {
    const target = read(await getDoc(a, `users/${enc(uid)}`));
    if (typeof target.jokerId !== "string" || !target.jokerId || target.suspended === true) return "failed";
    const conversationId = `checkins_${uid}`;
    const convoPath = `conversations/${conversationId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (dayKey() !== today) return "stale";
      const { doc: ledgerDoc, value: ledger } = await getLedger(a, uid);
      if (ledger.issued[today]) return "already";
      const existingConv = await getDoc(a, convoPath);
      const existingData = read(existingConv);
      const memberUids = [...new Set([uid, ...dealers])];
      const unreadCounts = Object.fromEntries(memberUids.map(id => [id, Number(existingData.unreadCounts?.[id] ?? 0) + 1]));
      if (existingConv) {
        if (existingData.kind !== "check_ins" || existingData.checkInProtected !== true
          || existingData.isGroup !== true
          || !Array.isArray(existingData.memberUids) || !existingData.memberUids.includes(uid)
          || (existingData.createdBy !== "check-in-server"
            && existingData.createdBy !== SYSTEM_SENDER_UID
            && !existingData.memberUids.includes(existingData.createdBy))) {
          throw new Error("protected Pocket canonical fields mismatch");
        }
      }
      const code = randomBytes(24).toString("base64url");
      const codeHash = hash(code);
      const codePath = `checkInCodes/${codeHash}`;
      const next: Ledger = { ...ledger, issued: { ...ledger.issued, [today]: codeHash } };
      const msgId = `issued-${today}`;
      const writes: any[] = [
        { update: { name: documentName(a.project, ledgerPath(uid)), fields: fields(next) }, currentDocument: precondition(ledgerDoc) },
        { update: { name: documentName(a.project, codePath), fields: fields({ uid, dateKey: today, redeemed: false }) }, currentDocument: { exists: false } },
      ];
      if (!existingConv) writes.push({
        update: { name: documentName(a.project, convoPath), fields: fields({ memberUids, isGroup: true, kind: "check_ins", groupName: "Private Check-In", createdBy: a.uid, lastMessage: "A private check-in code is ready.", unreadCounts, checkInProtected: true }) },
        updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }, { fieldPath: "lastMessageAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: false },
      });
      writes.push({
        update: { name: documentName(a.project, `${convoPath}/messages/${msgId}`), fields: fields({ senderUid: a.uid, text: `Your check-in code: ${code}`, reactions: {}, checkInProtected: true }) },
        updateTransforms: [{ fieldPath: "sentAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: false },
      });
      if (existingConv) writes.push({
        update: { name: documentName(a.project, convoPath), fields: fields({ memberUids, unreadCounts, lastMessage: "A private check-in code is ready." }) },
        updateMask: { fieldPaths: ["memberUids", "unreadCounts", "lastMessage"] },
        updateTransforms: [
          { fieldPath: "lastMessageAt", setToServerValue: "REQUEST_TIME" },
        ],
        currentDocument: precondition(existingConv),
      });
      const notifId = `checkin-${today}`;
      writes.push({
        update: { name: documentName(a.project, `notifications/${enc(uid)}/items/${notifId}`), fields: fields({ type: "message", fromUid: a.uid, conversationId, text: "A private check-in code is waiting in Pocket.", read: false }) },
        updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: false },
      });
      if (dayKey() !== today) return "stale";
      const r = await commit(a, writes);
      if (r.ok) { return await notify(a, uid, conversationId) ? "issued" : "issued_push_failed"; }
      if (!isPreconditionConflict(r.status)) throw new Error(`check-in issue commit failed (${r.status})`);
      const refreshed = (await getLedger(a, uid)).value;
      if (refreshed.issued[today]) return "already";
      logger.warn({ uid, status: r.status, details: (await r.clone().text()).slice(0, 300) }, "check-in commit conflict without a committed ledger");
    }
    return "failed";
  } catch (err) { logger.warn({ err, uid }, "check-in issue failed"); return "failed"; }
}

/**
 * Issue one code to each active Joker for a Denver calendar day, including
 * the pinned Hand seats.
 * Firestore preconditions inside issueOne make repeated or concurrent runs
 * idempotent per recipient and day.
 */
export async function issueDailyCheckInBatch(date = new Date()) {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!project || !adminConfigured()) throw new Error("daily check-in issuer is not configured");
  const token = await getAccessToken();
  if (!token) throw new Error("daily check-in issuer could not obtain Firestore access");
  const issuer: Auth = { project, uid: SYSTEM_SENDER_UID, token, jokerId: "" };
  const users = await userList(issuer);
  const recipients = users
    .filter(user => typeof user.data.jokerId === "string"
      && user.data.jokerId.length > 0
      && user.data.suspended !== true)
    .map(user => user.uid);
  const handMembers = users
    .filter(user => user.data.isAdmin === true
      && typeof user.data.jokerId === "string"
      && PINNED.has(user.data.jokerId)
      && user.data.suspended !== true)
    .map(user => user.uid);
  const today = dayKey(date);
  const result = await runCheckInBatch(
    recipients,
    8,
    uid => issueOne(issuer, uid, today, handMembers),
    {
      maxAttempts: 3,
      backoffMs: [1000, 3000],
      shouldContinue: () => dayKey() === today,
    },
  );
  return { dateKey: today, dealerUids: handMembers, ...result };
}

/** Used by the scheduled issuer even when recipient enumeration/issuance fails. */
export async function activeCheckInDealerUids(): Promise<string[]> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const token = await getAccessToken();
  if (!project || !token) throw new Error("dealer lookup unavailable");
  return (await userList({ project, token, uid: SYSTEM_SENDER_UID, jokerId: "" }))
    .filter(user => user.data.isAdmin === true && PINNED.has(user.data.jokerId) && user.data.suspended !== true)
    .map(user => user.uid);
}

router.get("/check-ins/me", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "active member required" });
  try { const { value } = await getLedger(a, a.uid); res.json({ state: state(value, dayKey()) }); }
  catch (err) { logger.error({ err }, "check-in state read failed"); res.status(500).json({ error: "check-ins unavailable" }); }
});

router.get("/check-ins/members", async (req, res) => {
  const a = await activeCaller(req);
  if (!a) return void res.status(403).json({ error: "active member required" });
  try {
    const today = dayKey();
    const users = await userList(a);
    const members = await batchLimit(users.filter(x =>
      typeof x.data.jokerId === "string" && x.data.jokerId.length > 0 && x.data.suspended !== true,
    ), 12, async x => {
      const { value } = await getLedger(a, x.uid);
      return {
        uid: x.uid,
        jokerId: x.data.jokerId,
        streak: currentStreak(value, today),
        checkedInToday: value.history.some(h => h.dateKey === today),
        issuedToday: Boolean(value.issued[today]),
      };
    });
    res.json({ members });
  } catch (err) {
    logger.error({ err }, "check-in roster read failed");
    res.status(500).json({ error: "check-ins unavailable" });
  }
});

router.get("/check-ins/admin", async (req, res) => {
  const a = await activeCaller(req, true);
  if (!a) return void res.status(403).json({ error: "pinned Hand seat required" });
  try {
    const today = dayKey();
    const users = await userList(a);
    const members = await batchLimit(users.filter(x =>
      typeof x.data.jokerId === "string" && x.data.jokerId.length > 0 && x.data.suspended !== true,
    ), 12, async x => {
      const { value } = await getLedger(a, x.uid);
      return { uid: x.uid, jokerId: typeof x.data.jokerId === "string" ? x.data.jokerId : "", streak: currentStreak(value, today), checkedInToday: value.history.some(h => h.dateKey === today), issuedToday: Boolean(value.issued[today]), pendingMilestones: value.pending };
    });
    res.json({ members });
  } catch (err) { logger.error({ err }, "check-in admin read failed"); res.status(500).json({ error: "check-ins unavailable" }); }
});

router.post("/check-ins/redeem", async (req, res) => {
  const a = await activeCaller(req), code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!a) return void res.status(403).json({ error: "active member required" });
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code)) return void res.status(400).json({ error: "invalid code" });
  try {
    const today = dayKey(), codeHash = hash(code), path = `checkInCodes/${codeHash}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const codeDoc = await getDoc(a, path), c = read(codeDoc);
      if (!codeDoc || c.uid !== a.uid || c.dateKey !== today) return void res.status(404).json({ error: "valid check-in code not found" });
      const { doc: ledgerDoc, value: ledger } = await getLedger(a, a.uid);
      if (ledger.history.some(x => x.dateKey === today)) return void res.status(409).json({ error: "already checked in today" });
      if (c.redeemed === true) return void res.status(409).json({ error: "code already redeemed" });
      const previous = ledger.history.reduce((latest: any, h: any) => !latest || h.dateKey > latest.dateKey ? h : latest, null);
      const previousDay = new Date(`${today}T00:00:00Z`); previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      const yesterday = previousDay.toISOString().slice(0, 10);
      const streak = previous?.dateKey === yesterday ? ledger.streak + 1 : 1;
      const now = new Date().toISOString();
      const history = [...ledger.history, { dateKey: today, checkedInAt: now }];
      const milestoneId = today;
      const occurrenceAlreadyExists = ledger.milestones.some(x => x.milestoneId === milestoneId);
      const isMilestone = streak % 7 === 0 && !occurrenceAlreadyExists;
      const pending = isMilestone && !ledger.pending.some(x => x.milestoneId === milestoneId)
        ? [...ledger.pending, { milestoneId, streak }]
        : ledger.pending;
      const milestones = isMilestone
        ? [...ledger.milestones, { milestoneId, dateKey: today, streak, earnedAt: now }]
        : ledger.milestones;
      const next: Ledger = { ...ledger, history, pending, milestones, streak, bestStreak: Math.max(ledger.bestStreak, streak), total: ledger.total + 1 };
      const blackBookPath = `blackBook/${enc(a.uid)}/entries/checkin_${today}`;
      const blackBookDoc = await getDoc(a, blackBookPath);
      const blackBookData = {
        tab: "checkins",
        title: "Daily check-in",
        date: today,
        notes: `Streak: ${streak} ${streak === 1 ? "day" : "days"}.`,
        createdBy: a.uid,
        reactions: {},
        commentCount: 0,
      };
      if (blackBookDoc && !canonicalCheckInEntry(blackBookDoc, read(blackBookDoc), blackBookData)) {
        return void res.status(409).json({ error: "check-in entry conflict; code was not redeemed" });
      }
      const writes: any[] = [
        { update: { name: documentName(a.project, ledgerPath(a.uid)), fields: fields(next) }, currentDocument: precondition(ledgerDoc) },
        { update: { name: documentName(a.project, path), fields: fields({ redeemed: true, redeemedDateKey: today }) }, updateMask: { fieldPaths: ["redeemed", "redeemedDateKey"] }, currentDocument: precondition(codeDoc) },
      ];
      if (!blackBookDoc) writes.push({
        update: { name: documentName(a.project, blackBookPath), fields: fields(blackBookData) },
        updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
        currentDocument: { exists: false },
      });
      const r = await commit(a, writes);
      if (r.ok) return void res.json({ state: state(next, today) });
      if (!isPreconditionConflict(r.status)) throw new Error(`check-in redemption failed (${r.status})`);
    }
    res.status(409).json({ error: "check-in changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "check-in redemption failed"); res.status(500).json({ error: "check-in redemption failed" }); }
});

router.post("/check-ins/award", async (req, res) => {
  const a = await activeCaller(req, true), b = req.body;
  if (!a) return void res.status(403).json({ error: "pinned Hand seat required" });
  if (!b || typeof b.targetUid !== "string" || typeof b.milestoneId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.milestoneId) || !["royal", "merch"].includes(b.kind) || typeof b.description !== "string" || !b.description.trim() || b.description.length > 280) return void res.status(400).json({ error: "invalid milestone award" });
  try {
    const target = read(await getDoc(a, `users/${enc(b.targetUid)}`));
    if (typeof target.jokerId !== "string" || !target.jokerId || target.suspended === true) return void res.status(404).json({ error: "active member not found" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const { doc, value } = await getLedger(a, b.targetUid);
      const pendingOccurrence = value.pending.find(x => x.milestoneId === b.milestoneId);
      if (!pendingOccurrence) return void res.status(409).json({ error: "milestone is not pending" });
      const { streak } = pendingOccurrence;
      const earnedAt = new Date().toISOString();
      const milestones = value.milestones.some(x => x.milestoneId === b.milestoneId)
        ? value.milestones.map(x => x.milestoneId === b.milestoneId ? { ...x, rewardType: b.kind, description: b.description.trim() } : x)
        : [...value.milestones, { milestoneId: b.milestoneId, dateKey: b.milestoneId, streak, earnedAt, rewardType: b.kind, description: b.description.trim() }];
      const next = { ...value, pending: value.pending.filter(x => x.milestoneId !== b.milestoneId), milestones };
      const today = dayKey();
      const entryPath = `blackBook/${enc(b.targetUid)}/entries/checkin_milestone_${b.milestoneId}`;
      const entry = await getDoc(a, entryPath);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(b.milestoneId) ? b.milestoneId : today;
      const previousNotes = `Streak milestone: ${streak} days.`;
      if (entry && !canonicalCheckInEntry(entry, read(entry), {
        tab: "checkins", title: "Check-in milestone", date, notes: previousNotes, createdBy: b.targetUid,
      })) {
        return void res.status(409).json({ error: "milestone entry conflict; award was not recorded" });
      }
      const entryFields = {
        tab: "checkins",
        title: "Check-in milestone",
        date,
        notes: `${previousNotes}\nReward: ${b.kind} — ${b.description.trim()}`.slice(0, 2000),
        createdBy: b.targetUid,
        reactions: {},
        commentCount: 0,
      };
      const entryWrite = entry
        ? { update: { name: documentName(a.project, entryPath), fields: fields({ notes: entryFields.notes }) }, updateMask: { fieldPaths: ["notes"] }, currentDocument: precondition(entry) }
        : { update: { name: documentName(a.project, entryPath), fields: fields(entryFields) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } };
      const r = await commit(a, [
        { update: { name: documentName(a.project, ledgerPath(b.targetUid)), fields: fields(next) }, currentDocument: precondition(doc) },
        entryWrite,
      ]);
      if (r.ok) return void res.json({ ok: true });
      if (!isPreconditionConflict(r.status)) throw new Error(`milestone award failed (${r.status})`);
    }
    res.status(409).json({ error: "milestone changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "check-in award failed"); res.status(500).json({ error: "check-in award failed" }); }
});

export default router;