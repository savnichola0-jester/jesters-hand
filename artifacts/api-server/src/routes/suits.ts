import { createHash } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import { adminConfigured, firestoreBase, getAccessToken, getUserPushTargets } from "../lib/firestoreAdmin";
import { logger } from "../lib/logger";
import { canAwardRoyal, canChangeSuitAssignment, withSuitAssignment } from "../lib/suitsPermissions";

const router: IRouter = Router();
const PIPS = new Set(["spade", "diamond", "heart", "club"]);
const DESTINATIONS = new Set([
  "ticket", "hand", "street-art", "jesters-deal", "suits", "ante", "table",
  "target-ticket", "vault", "chamber", "recruit", "uniform", "system",
  "social", "discovery",
]);
const enc = encodeURIComponent;
type Doc = { name?: string; fields?: Record<string, any>; updateTime?: string };
type Auth = { project: string; token: string; uid: string; jokerId: string };
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
  if (!project || !uid || !token) return null;
  const userDoc = await getDoc({ project, uid, token, jokerId: "" }, `users/${enc(uid)}`);
  if (!userDoc) return null;
  const jokerId = read(userDoc).jokerId;
  return typeof jokerId === "string" ? { project, uid, token, jokerId } : null;
}
async function caller(req: Request, role: "member" | "dealer" = "member"): Promise<Auth | null> {
  const a = await authenticate(req); if (!a) return null;
  const userDoc = await getDoc(a, `users/${enc(a.uid)}`);
  if (!userDoc) return null;
  const u = read(userDoc);
  if (
    u.suspended === true ||
    (role === "dealer" && (u.isAdmin !== true || !["00-00", "01-54"].includes(a.jokerId)))
  ) return null;
  return a;
}
async function assignment(a: Auth, uid: string) { const doc = await getDoc(a, `suitAssignments/${enc(uid)}`); return { doc, data: doc ? read(doc) : { pips: [], streaks: {}, notes: {}, completed: {} } }; }
const precondition = (doc: Doc | null) => doc?.updateTime ? { updateTime: doc.updateTime } : { exists: false };
const auditWrites = (a: Auth, id: string, uid: string, action: string, context: Record<string, unknown>, includeInvestigation = a.jokerId === "00-00") => [
  { update: { name: `${root(a.project)}/activityEvents/${id}`, fields: fields({ uid, action, section: "suits" }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
  ...(includeInvestigation ? [
    { update: { name: `${root(a.project)}/investigationEvents/${id}`, fields: fields({ uid, action, section: "suits", context }) }, updateTransforms: [{ fieldPath: "occurredAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
  ] : []),
];
async function commit(a: Auth, writes: unknown[]) { return api(`${firestoreBase(a.project)}:commit`, a.token, { method: "POST", body: JSON.stringify({ writes }) }); }
async function auditExists(a: Auth, id: string, includeInvestigation = a.jokerId === "00-00") {
  const activity = await getDoc(a, `activityEvents/${id}`);
  if (!activity) return false;
  return !includeInvestigation || Boolean(await getDoc(a, `investigationEvents/${id}`));
}
async function holders(a: Auth) {
  const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "suitAssignments" }] } }) });
  if (!r.ok) throw new Error("Unable to read SUITS holders");
  const docs = (await r.json() as Array<{ document?: Doc }>).map(x => x.document).filter((d): d is Doc => Boolean(d?.name));
  const all = await Promise.all(docs.map(async d => { const uid = d.name!.split("/").pop()!; const u = await getDoc(a, `users/${enc(uid)}`); const x = read(d); return u ? { uid, jokerId: read(u).jokerId ?? uid, pips: x.pips ?? [], streaks: x.streaks ?? {}, privateCards: x.privateCards ?? {} } : null; }));
  return all.filter(Boolean);
}
async function notifyRecipients(a: Auth, recipients: string[], pip: string, title = "You're marked. Move.", body?: string, type?: string) {
  try {
    const targets = await Promise.all(recipients.map(uid => getUserPushTargets(a.project, uid)));
    const messages = targets.filter(t => t && !t.alertsMuted && t.expoPushToken).map(t => ({
      to: t!.expoPushToken,
      title,
      ...(body ? { body } : {}),
      sound: "default",
      channelId: "dispatches",
      priority: "high",
      data: type ? { type, pip, route: "/(tabs)/jesters-deal" } : { section: "suits", pip },
    }));
    if (messages.length) await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(messages) });
  } catch (err) { logger.warn({ err, pip }, "suits push failed"); }
}
async function notificationUsers(a: Auth) {
  const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }] } }),
  });
  if (!r.ok) throw new Error("Unable to load community notification recipients");
  return (await r.json() as Array<{ document?: Doc }>)
    .map(x => x.document)
    .filter((d): d is Doc => Boolean(d?.name))
    .map(d => ({ doc: d, uid: d.name!.split("/").pop()!, user: read(d) }))
    .filter(x => x.user.suspended !== true);
}
async function dealRecipients(a: Auth, pip: string, audience: string | undefined) {
  const active = await notificationUsers(a);
  if (audience !== "suit_group") return active.map(x => ({ uid: x.uid }));
  const activeUids = new Set(active.map(x => x.uid));
  const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, {
    method: "POST",
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "suitAssignments" }] } }),
  });
  if (!r.ok) throw new Error("Unable to load dealer-assigned suit roster");
  return (await r.json() as Array<{ document?: Doc }>)
    .map(row => row.document)
    .filter((d): d is Doc => Boolean(d?.name))
    .map(d => ({ uid: d.name!.split("/").pop()!, pips: read(d).pips }))
    .filter(x => activeUids.has(x.uid) && Array.isArray(x.pips) && x.pips.includes(pip))
    .map(x => ({ uid: x.uid }));
}

router.get("/suits/me", async (req, res) => { try { const a = await caller(req); if (!a) return void res.status(403).json({ error: "active member required" }); const [x, c] = await Promise.all([assignment(a, a.uid), getDoc(a, "suitConfig/current")]); const config = read(c); res.json({ state: { pips: x.data.pips ?? [], streaks: x.data.streaks ?? {}, notes: x.data.notes ?? {}, completed: x.data.completed ?? {}, inPlay: config.inPlay ?? {}, privateCards: x.data.privateCards ?? {} } }); } catch (err) { logger.error({ err }, "suits me failed"); res.status(500).json({ error: "SUITS unavailable" }); } });
router.get("/suits/lookup/:jokerId", async (req, res) => { try { const a = await caller(req, "dealer"); if (!a) return void res.status(403).json({ error: "dealer seat required" }); const id = String(req.params.jokerId); if (!/^\d{2}-\d{2}$/.test(id)) return void res.status(400).json({ error: "use a Joker ID" }); const r = await api(`${firestoreBase(a.project)}:runQuery`, a.token, { method: "POST", body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "jokerId" }, op: "EQUAL", value: { stringValue: id } } }, limit: 1 } }) }); const d = r.ok ? (await r.json() as Array<{ document?: Doc }>).find(x => x.document)?.document : null; if (!d || read(d).suspended === true) return void res.json({ holder: null }); const uid = d.name!.split("/").pop()!; const x = await assignment(a, uid); res.json({ holder: { uid, jokerId: id, pips: x.data.pips ?? [], streaks: x.data.streaks ?? {}, privateCards: x.data.privateCards ?? {} } }); } catch { res.status(500).json({ error: "lookup unavailable" }); } });
router.get("/suits/admin", async (req, res) => { const a = await caller(req, "dealer"); if (!a) return void res.status(403).json({ error: "dealer seat required" }); try { const c = read(await getDoc(a, "suitConfig/current")); res.json({ holders: await holders(a), inPlay: c.inPlay ?? {} }); } catch (err) { logger.error({ err }, "suits admin read failed"); res.status(500).json({ error: "SUITS unavailable" }); } });

router.post("/suits/assignment", async (req, res) => {
  const a = await caller(req, "dealer"), b = req.body;
  if (!a) return void res.status(403).json({ error: "dealer seat required" });
  if (!b || typeof b.targetUid !== "string" || !/^\d{2}-\d{2}$/.test(b.jokerId) || !PIPS.has(b.pip) || typeof b.assigned !== "boolean") {
    return void res.status(400).json({ error: "invalid SUITS assignment" });
  }
  if (!canChangeSuitAssignment(a.jokerId, b.jokerId)) return void res.status(403).json({ error: "pinned Hand seat required" });
  try {
    const target = await getDoc(a, `users/${enc(b.targetUid)}`);
    const targetUser = read(target);
    if (!target || targetUser.jokerId !== b.jokerId || targetUser.suspended === true) {
      return void res.status(404).json({ error: "active Joker not found; search again" });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = await assignment(a, b.targetUid);
      const next = withSuitAssignment(x.data, b.pip, b.assigned);
      const marker = x.data.auditMutation?.[b.pip];
      if (
        JSON.stringify(x.data.pips ?? []) === JSON.stringify(next.pips) &&
        typeof marker === "string" &&
        await auditExists(a, marker, true)
      ) return void res.json({ ok: true, idempotent: true });

      const id = hashId("assignment", a.uid, b.targetUid, b.jokerId, b.pip, String(b.assigned), x.doc?.updateTime ?? "missing");
      next.auditMutation = { ...(x.data.auditMutation ?? {}), [b.pip]: id };
      // Preserve raw Firestore types in historical completion/streak fields.
      // read()/wire() would otherwise turn timestampValue into stringValue.
      const writes = [
        {
          update: {
            name: `${root(a.project)}/suitAssignments/${enc(b.targetUid)}`,
            fields: fields({ pips: next.pips, auditMutation: next.auditMutation }),
          },
          updateMask: { fieldPaths: ["pips", "auditMutation"] },
          updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }],
          currentDocument: precondition(x.doc),
        },
        ...auditWrites(a, id, b.targetUid, "suit_assignment_updated", {
          actorUid: a.uid,
          actorJokerId: a.jokerId,
          targetJokerId: b.jokerId,
          pip: b.pip,
          assigned: b.assigned,
        }, true),
      ];
      const r = await commit(a, writes);
      if (r.ok) return void res.json({ ok: true });
      if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "assignment changed concurrently; retry" });
  } catch (err) {
    logger.error({ err }, "suit assignment failed");
    res.status(500).json({ error: "SUITS assignment failed" });
  }
});

router.post("/suits/in-play", async (req, res) => {
  const a = await caller(req, "dealer"), b = req.body, task = b?.task;
  if (!a) return void res.status(403).json({ error: "dealer seat required" });
  if (!b || !PIPS.has(b.pip) || !task || typeof task.active !== "boolean" || typeof task.title !== "string" || !task.title.trim() || task.title.length > 160 || (task.destination && !DESTINATIONS.has(task.destination)) || !["community", "private"].includes(task.visibility ?? "community") || (task.notifyAudience !== undefined && !["community", "suit_group"].includes(task.notifyAudience)) || (task.visibility === "private" && (task.notifyAudience !== undefined || typeof b.targetUid !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(b.targetUid) || !/^\d{2}-\d{2}$/.test(b.jokerId)))) return void res.status(400).json({ error: "invalid suit task" });
  const milestoneNotes = task.milestoneNotes && typeof task.milestoneNotes === "object"
    ? Object.fromEntries(["3", "6", "9"].flatMap(day => typeof task.milestoneNotes[day] === "string" && task.milestoneNotes[day].trim() ? [[day, task.milestoneNotes[day].trim().slice(0, 280)]] : []))
    : {};
  const privateCard = task.visibility === "private";
  const authored = { active: task.active, title: task.title.trim(), ...(typeof task.instruction === "string" ? { instruction: task.instruction.slice(0, 280) } : {}), ...(task.destination ? { destination: task.destination } : {}), ...(Object.keys(milestoneNotes).length ? { milestoneNotes } : {}), ...(task.notifyAudience === "suit_group" ? { notifyAudience: "suit_group" } : {}) };
  try {
    if (privateCard) {
      const target = read(await getDoc(a, `users/${enc(b.targetUid)}`));
      if (target.jokerId !== b.jokerId || target.suspended === true || ["00-00", "01-54"].includes(b.jokerId)) return void res.status(404).json({ error: "active Joker not found; search again" });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await getDoc(a, "suitConfig/current"), data = read(old), current = data.inPlay?.[b.pip];
      const intended = privateCard
        ? { active: false, title: "", visibility: "private", privateTargetUid: b.targetUid }
        : { ...authored, visibility: "community" };
      const priorUid = typeof current?.privateTargetUid === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(current.privateTargetUid) ? current.privateTargetUid : null;
      const previous = priorUid ? await assignment(a, priorUid) : null;
      const recipient = privateCard ? (b.targetUid === priorUid ? previous! : await assignment(a, b.targetUid)) : null;
      const existingPrivate = recipient?.data.privateCards?.[b.pip];
      const marker = data.auditMutation?.[b.pip];
      if (JSON.stringify(current) === JSON.stringify(intended) && (!privateCard || JSON.stringify(existingPrivate) === JSON.stringify(authored)) && typeof marker === "string" && await auditExists(a, marker)) return void res.json({ ok: true, idempotent: true });
      const id = hashId("task", a.uid, b.pip, JSON.stringify(intended), old?.updateTime ?? "missing");
      const next = { ...data, inPlay: { ...(data.inPlay ?? {}), [b.pip]: intended }, auditMutation: { ...(data.auditMutation ?? {}), [b.pip]: id } };
      const activation = task.active && (
        current?.active !== true || privateCard ||
        (!privateCard && (current?.notifyAudience === "suit_group") !== (task.notifyAudience === "suit_group"))
      );
      const deal = privateCard
        ? { title: "The Jester has dealt you a card.", text: "A private card has been dealt to you.", type: "deal_personal" }
        : task.notifyAudience === "suit_group"
          ? { title: "Your suit is in play.", text: "A card matching your suit is in play.", type: "deal_suit" }
          : { title: "The Jester has dealt a card.", text: "A card is in play for the whole Hand.", type: "deal_community" };
      const users = activation
        ? privateCard
          ? [{ uid: b.targetUid }]
          : await dealRecipients(a, b.pip, task.notifyAudience)
        : [];
      const writes: unknown[] = [
        { update: { name: `${root(a.project)}/suitConfig/current`, fields: fields(next) }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(old) },
      ];
      if (previous && priorUid !== (privateCard ? b.targetUid : null)) {
        const privateCards = { ...(previous.data.privateCards ?? {}) };
        delete privateCards[b.pip];
        writes.push({ update: { name: `${root(a.project)}/suitAssignments/${enc(priorUid!)}`, fields: fields({ privateCards }) }, updateMask: { fieldPaths: ["privateCards"] }, currentDocument: precondition(previous.doc) });
      }
      if (recipient) {
        const privateCards = { ...(recipient.data.privateCards ?? {}), [b.pip]: authored };
        writes.push({ update: { name: `${root(a.project)}/suitAssignments/${enc(b.targetUid)}`, fields: fields({ privateCards }) }, updateMask: { fieldPaths: ["privateCards"] }, updateTransforms: [{ fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(recipient.doc) });
      }
      if (activation) {
        for (const { uid } of users) {
          const notificationId = hashId("deal-notification", id, uid);
          writes.push({
            update: {
              name: `${root(a.project)}/notifications/${enc(uid)}/items/${notificationId}`,
              fields: fields({ title: deal.title, text: deal.text, type: deal.type, read: false }),
            },
            updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }],
            currentDocument: { exists: false },
          });
        }
      }
      writes.push(...auditWrites(a, id, a.uid, "suit_task_updated", { pip: b.pip, active: task.active, destination: task.destination ?? null, visibility: privateCard ? "private" : "community", ...(privateCard ? { targetUid: b.targetUid, targetJokerId: b.jokerId } : {}) }));
      const r = await commit(a, writes); if (r.ok) {
        if (activation && users.length) {
          await notifyRecipients(a, users.map(x => x.uid), b.pip, deal.title, deal.text, deal.type);
        }
        return void res.json({ ok: true });
      } if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "configuration changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "configuration failed"); res.status(500).json({ error: "configuration failed" }); }
});

router.post("/suits/stamp", async (req, res) => {
  const a = await caller(req, "dealer"), b = req.body;
  if (!a) return void res.status(403).json({ error: "dealer seat required" });
  if (!canAwardRoyal(a.jokerId)) return void res.status(403).json({ error: "00-00 is required to award Royals" });
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
       const currentCard = config.inPlay?.[b.pip];
       const jesterNote = (currentCard?.visibility === "private"
         ? (currentCard.privateTargetUid === b.targetUid ? x.data.privateCards?.[b.pip]?.milestoneNotes : undefined)
         : currentCard?.milestoneNotes)?.[String(nextStreak)];
      const next = { ...x.data, streaks: { ...(x.data.streaks ?? {}), [b.pip]: nextStreak }, notes: { ...(x.data.notes ?? {}), ...([3, 6, 9].includes(nextStreak) && typeof jesterNote === "string" ? { [b.pip]: jesterNote } : {}) }, completed: { ...(x.data.completed ?? {}) } };
      const stampState = { pips: x.data.pips, streaks: next.streaks, notes: next.notes };
      const writes = [
        { update: { name: `${root(a.project)}/suitAssignments/${enc(b.targetUid)}`, fields: fields(stampState) }, updateMask: { fieldPaths: ["pips", "streaks", "notes"] }, updateTransforms: [{ fieldPath: `completed.${b.pip}`, setToServerValue: "REQUEST_TIME" }, { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" }], currentDocument: precondition(x.doc) },
        { update: { name: `${root(a.project)}/blackBook/${enc(b.targetUid)}/entries/${enc(royalId)}`, fields: fields({ tab: "royals", title: `${b.pip} Royal`, suit: b.pip, notes: "Awarded through SUITS", createdBy: a.uid }) }, updateTransforms: [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }], currentDocument: { exists: false } },
        ...auditWrites(a, id, b.targetUid, "suit_completed_royal_awarded", { pip: b.pip, streak: nextStreak, actorUid: a.uid }),
      ];
      const r = await commit(a, writes); if (r.ok) {
        await notifyRecipients(a, [b.targetUid], b.pip, "Cred stamped.", `${b.pip} Royal awarded.`);
        return void res.json({ ok: true, streak: nextStreak });
      } if (r.status !== 409 && r.status !== 412) throw new Error(`commit failed (${r.status})`);
    }
    return void res.status(409).json({ error: "assignment changed concurrently; retry" });
  } catch (err) { logger.error({ err }, "stamp failed"); res.status(500).json({ error: "stamp failed" }); }
});

export default router;