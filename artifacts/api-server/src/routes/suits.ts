import { createHash } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken, getUserPushTargets } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const PIPS = new Set(["spade", "diamond", "heart", "club"]);
const DESTINATIONS = new Set(["table", "jesters-deal", "uniform", "recruit", "target-ticket", "chamber", "social", "discovery"]);
const enc = encodeURIComponent;
type Doc = { name?: string; fields?: Record<string, any>; updateTime?: string };
type Auth = { project: string; token: string; uid: string };
const field = (v: any): any => !v || typeof v !== "object" ? null : "stringValue" in v ? v.stringValue : "booleanValue" in v ? v.booleanValue : "integerValue" in v ? Number(v.integerValue) : "timestampValue" in v ? v.timestampValue : "arrayValue" in v ? (v.arrayValue.values ?? []).map(field) : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, field(x)])) : null;
const read = (d: Doc | null) => Object.fromEntries(Object.entries(d?.fields ?? {}).map(([k, v]) => [k, field(v)]));
const wire = (v: any): any => v === null ? { nullValue: null } : typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? { integerValue: String(v) } : Array.isArray(v) ? { arrayValue: { values: v.map(wire) } } : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) } };
const fields = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
const root = (project: string) => `projects/${project}/databases/(default)/documents`;
const hashId = (...parts: string[]) => `suits-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40)}`;
async function api(url: string, token: string, init: RequestInit = {}) { return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } }); }
async function getDoc(a: Auth, path: string): Promise<Doc | null> { const r = await api(`${firestoreBase(a.project)}/${path}`, a.token); if (r.status === 404) return null; if (!r.ok) throw new Error(`read failed (${r.status})`); return await r.json() as Doc; }
async function authenticate(req: Request): Promise<Auth | null> {
  const project = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  const bearer = req.headers.authorization ?? "";
  const uid = project && bearer.startsWith("Bearer ") ? await verifyFirebaseIdToken(bearer.slice(7), project) : null;
  const token = uid && adminConfigured() ? await getAccessToken() : null;
  return project && uid && token ? { project, uid, token } : null;
}
async function caller(req: Request, jesterOnly = false): Promise<Auth | null> {
  const a = await authenticate(req); if (!a) return null;
  const userDoc = await getDoc(a, `users/${enc(a.uid)}`);
  if (!userDoc) return null;
  const u = read(userDoc);
  if (
    u.suspended === true ||
    (jesterOnly && (u.jokerId !== "00-00" || u.isAdmin !== true))
  ) return null;
  return a;
}
async function assignment(a: Auth, uid: string) { const doc = await getDoc(a, `suitAssignments/${enc(uid)}`); return { doc, data: doc ? read(doc) : { pips: [], streaks: {}, notes: {}, completed: {} } }; }
const precondition = (doc: Doc | null) => doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false };
const auditWrites = (a: Auth, id: string, uid: string, action: string, context: Record<string, unknown>) => [
  { update: { name: `${root(a.project)}/activityEvents/${id}`, fields: fields({ uid, action, section: "suits" }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
  { update: { name: `${root(a.project)}/investigationEvents/${id}`, fields: fields({ uid, action, section: "suits", context }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
];
async function commit(a: Auth, writes: unknown[]) { return api(`${firestoreBase(a.project)}:commit`, a.token, { method: "POST", body: JSON.stringify({ writes }) }); }
async function auditExists(a: Auth, id: string) {
  const [activity, investigation] = await Promise.all([getDoc(a, `activityEvents/${id}`), getDoc(a, `investigationEvents/${id}`)]);
  return Boolean(activity && investigation);
}
async function holders(a: Auth) {
  const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "suitAssignments" }] } }) });
  if (!r.ok) throw new Error("Unable to read SUITS holders");
  const docs = (await r.json() as Array<{ document?: Doc }>).map(x => x.document).filter((d): d is Doc => Boolean(d?.name));
  const all = await Promise.all(docs.map(async d => { const uid = d.name!.split("/").pop()!; const u = await getDoc(a, `users/${enc(uid)}`); const x = read(d); return u ? { uid, jokerId: read(u).jokerId ?? uid, pips: x.pips ?? [], streaks: x.streaks ?? {} } : null; }));
  return all.filter(Boolean);
}
async function notifyRecipients(a: Auth, recipients: string[], pip: string) {
  try {
    const targets = await Promise.all(recipients.map(uid => getUserPushTargets(a.project, uid)));
    const messages = targets.filter(t => t && !t.alertsMuted && t.expoPushToken).map(t => ({ to: t!.expoPushToken, title: "You're marked. Move.", sound: "default", channelId: "dispatches", priority: "high", data: { section: "suits", pip } }));
    if (messages.length) await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(messages) });
  } catch (err) { logger.warn({ err, pip }, "suits holder push failed"); }
}
async function notifyHolders(a: Auth, pip: string) {
  const recipients = (await holders(a)).filter((h: any) => h.pips.includes(pip)).map((h: any) => h.uid);
  await notifyRecipients(a, recipients, pip);
}

router.get("/suits/me", async (req, res) => { try { const a = await caller(req); if (!a) return void res.status(403).json({ error: "active member required" }); const [x, c] = await Promise.all([assignment(a, a.uid), getDoc(a, "suitConfig/current")]); const config = read(c); res.json({ state: { pips: x.data.pips ?? [], streaks: x.data.streaks ?? {}, notes: x.data.notes ?? {}, completed: x.data.completed ?? {}, inPlay: config.inPlay ?? {} } }); } catch (err) { logger.error({ err }, "suits me failed"); res.status(500).json({ error: "SUITS unavailable" }); } });
router.get("/suits/lookup/:jokerId", async (req, res) => { try { const a = await caller(req); if (!a) return void res.status(403).json({ error: "active member required" }); const id = String(req.params.jokerId); if (!/^\d{2}-\d{2}$/.test(id)) return void res.status(400).json({ error: "use a Joker ID" }); const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "jokerId" }, op: "EQUAL", value: { stringValue: id } } }, limit: 1 } }) }); const d = r.ok ? (await r.json() as Array<{ document?: Doc }>).find(x => x.document)?.document : null; if (!d) return void res.json({ holder: null }); const uid = d.name!.split("/").pop()!; const x = await assignment(a, uid); res.json({ holder: { uid, jokerId: id, pips: x.data.pips ?? [], streaks: x.data.streaks ?? {} } }); } catch { res.status(500).json({ error: "lookup unavailable" }); } });
router.get("/suits/admin", async (req, res) => { const a = await caller(req, true); if (!a) return void res.status(403).json({ error: "active Jester 00-00 only" }); try { const c = read(await getDoc(a, "suitConfig/current")); res.json({ holders: await holders(a), inPlay: c.inPlay ?? {} }); } catch (err) { logger.error({ err }, "suits admin read failed"); res.status(500).json({ error: "SUITS unavailable" }); } });

router.post("/suits/assignment", async (req, res) => {
  const a = await caller(req, true), b = req.body;
  if (!a) return void res.status(403).json({ error: "active Jester 00-00 only" });
  if (!b || typeof b.targetUid !== "string" || !PIPS.has(b.pip) || typeof b.assigned !== "boolean") return void res.status(400).json({ error: "invalid assignment" });
  try {
    if (!await getDoc(a, `users/${enc(b.targetUid)}`)) return void res.status(404).json({ error: "member not found" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = await assignment(a, b.targetUid); const pips = new Set<string>(x.data.pips ?? []);
      const intended = b.assigned ? pips.has(b.pip) : !pips.has(b.pip);
      const priorMarker = x.data.auditMutation?.[b.pip];
      if (intended && typeof priorMarker === "string" && await auditExists(a, priorMarker)) return void res.json({ ok: true, idempotent: true });
      b.assigned ? pips.add(b.pip) : pips.delete(b.pip);
      const id = hashId("assignment", b.targetUid, b.pip, String(b.assigned), x.doc?.updateTime ?? "missing");
      const data = { ...x.data, pips: [...pips].slice(0, 4), auditMutation: { ...(x.data.auditMutation ?? {}), [b.pip]: id } };
      const writes = [{ update: { name: `${root(a.project)}/suitAssignments/${enc(b.targetUid)}`, fields: fields(data) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(x.doc) }, ...auditWrites(a, id, b.targetUid, b.assigned ? "suit_assigned" : "suit_removed", { pip: b.pip, actorUid: a.uid })];
      const r = await commit(a, writes); if (r.ok) { if (b.assigned) await notifyRecipients(a, [b.targetUid], b.pip); return void res.json({ ok: true }); } if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "assignment changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "assignment failed"); res.status(500).json({ error: "assignment failed" }); }
});

router.post("/suits/in-play", async (req, res) => {
  const a = await caller(req, true), b = req.body, task = b?.task;
  if (!a) return void res.status(403).json({ error: "active Jester 00-00 only" });
  if (!b || !PIPS.has(b.pip) || !task || typeof task.active !== "boolean" || typeof task.title !== "string" || !task.title.trim() || task.title.length > 160 || (task.destination && !DESTINATIONS.has(task.destination))) return void res.status(400).json({ error: "invalid suit task" });
  const milestoneNotes = task.milestoneNotes && typeof task.milestoneNotes === "object"
    ? Object.fromEntries(["3", "6", "9"].flatMap(day => typeof task.milestoneNotes[day] === "string" && task.milestoneNotes[day].trim() ? [[day, task.milestoneNotes[day].trim().slice(0, 280)]] : []))
    : {};
  const intended = { active: task.active, title: task.title.trim(), ...(typeof task.instruction === "string" ? { instruction: task.instruction.slice(0, 280) } : {}), ...(task.destination ? { destination: task.destination } : {}), ...(Object.keys(milestoneNotes).length ? { milestoneNotes } : {}) };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await getDoc(a, "suitConfig/current"), data = read(old), current = data.inPlay?.[b.pip];
      const marker = data.auditMutation?.[b.pip];
      if (JSON.stringify(current) === JSON.stringify(intended) && typeof marker === "string" && await auditExists(a, marker)) return void res.json({ ok: true, idempotent: true });
      const id = hashId("task", b.pip, JSON.stringify(intended), old?.updateTime ?? "missing");
      const next = { ...data, inPlay: { ...(data.inPlay ?? {}), [b.pip]: intended }, auditMutation: { ...(data.auditMutation ?? {}), [b.pip]: id } };
      const writes = [{ update: { name: `${root(a.project)}/suitConfig/current`, fields: fields(next) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(old) }, ...auditWrites(a, id, a.uid, "suit_task_updated", { pip: b.pip, active: task.active, destination: task.destination ?? null })];
      const r = await commit(a, writes); if (r.ok) { if (task.active) await notifyHolders(a, b.pip); return void res.json({ ok: true }); } if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "configuration changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "configuration failed"); res.status(500).json({ error: "configuration failed" }); }
});

router.post("/suits/stamp", async (req, res) => {
  const a = await caller(req, true), b = req.body;
  if (!a) return void res.status(403).json({ error: "active Jester 00-00 only" });
  if (!b || typeof b.targetUid !== "string" || !PIPS.has(b.pip)) return void res.status(400).json({ error: "invalid stamp" });
  try {
    const today = new Date().toISOString().slice(0, 10), id = hashId("stamp", b.targetUid, b.pip, today), royalId = `suits-royal-${b.pip}-${today}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = await assignment(a, b.targetUid);
      if (!(x.data.pips ?? []).includes(b.pip)) return void res.status(409).json({ error: "only a holder is eligible" });
      if (String(x.data.completed?.[b.pip] ?? "").slice(0, 10) === today) {
        const royal = await getDoc(a, `blackBook/${enc(b.targetUid)}/entries/${enc(royalId)}`);
        if (royal && await auditExists(a, id)) return void res.json({ ok: true, idempotent: true, streak: x.data.streaks?.[b.pip] ?? 1 });
        return void res.status(409).json({ error: "incomplete prior stamp; manual review required" });
      }
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const nextStreak = String(x.data.completed?.[b.pip] ?? "").slice(0, 10) === yesterday ? Number(x.data.streaks?.[b.pip] ?? 0) + 1 : 1;
      const config = read(await getDoc(a, "suitConfig/current"));
      const jesterNote = config.inPlay?.[b.pip]?.milestoneNotes?.[String(nextStreak)];
      const next = { ...x.data, streaks: { ...(x.data.streaks ?? {}), [b.pip]: nextStreak }, notes: { ...(x.data.notes ?? {}), ...([3, 6, 9].includes(nextStreak) && typeof jesterNote === "string" ? { [b.pip]: jesterNote } : {}) }, completed: { ...(x.data.completed ?? {}) } };
      const stampState = { pips: x.data.pips, streaks: next.streaks, notes: next.notes };
      const writes = [
        { update: { name: `${root(a.project)}/suitAssignments/${enc(b.targetUid)}`, fields: fields(stampState) }, updateMask: { fieldPaths: ["pips", "streaks", "notes"] }, updateTransforms: [{ fieldPath: `completed.${b.pip}`, setToServerValue: "REQUEST_TIME" }, { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(x.doc) },
        { update: { name: `${root(a.project)}/blackBook/${enc(b.targetUid)}/entries/${enc(royalId)}`, fields: fields({ tab: "royals", title: `${b.pip} Royal`, suit: b.pip, notes: "Awarded through SUITS", createdBy: a.uid }) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
        ...auditWrites(a, id, b.targetUid, "suit_completed_royal_awarded", { pip: b.pip, streak: nextStreak, actorUid: a.uid }),
      ];
      const r = await commit(a, writes); if (r.ok) return void res.json({ ok: true, streak: nextStreak }); if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "assignment changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "stamp failed"); res.status(500).json({ error: "stamp failed" }); }
});

export default router;