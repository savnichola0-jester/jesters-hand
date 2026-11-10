import { Router, type IRouter } from "express";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db, dossiersTable } from "@workspace/db";
import { CreateDossierBody, UpdateDossierBody } from "@workspace/api-zod";
import { actorFor, type MemberActor } from "../lib/memberActor";
import { parseDossierDocument } from "../lib/dossierValidation";

const router: IRouter = Router();
type Row = typeof dossiersTable.$inferSelect;
function dto(row: Row, actor: MemberActor) {
  const canEdit = actor.isKeeper && row.ownerUid === actor.uid;
  const published = !!row.publication && !row.archived;
  const snapshot = !canEdit && published ? row.publication! : null;
  return {
    id: row.id, title: snapshot?.title ?? row.title, category: snapshot?.category ?? row.category,
    document: JSON.stringify(snapshot?.document ?? row.document),
    version: canEdit ? row.version : 0, archived: row.archived,
    published, publishedAt: published ? row.publication!.publishedAt : null, canEdit,
    createdAt: snapshot?.publishedAt ?? row.createdAt.toISOString(),
    updatedAt: snapshot?.publishedAt ?? row.updatedAt.toISOString(),
  };
}
router.use("/dossiers", async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = await actorFor(req);
    if (!actor) { res.status(403).json({ error: "An active member login is required." }); return; }
    res.locals.dossierActor = actor;
    res.locals.dossierUid = actor.uid;
    next();
  } catch {
    res.status(503).json({ error: "Could not verify Dossier access. Try again." });
  }
});

router.get("/dossiers", async (req, res) => {
  if (req.query.archived !== undefined && !["true", "false"].includes(String(req.query.archived))) {
    res.status(400).json({ error: "Invalid archive filter." }); return;
  }
  const actor: MemberActor = res.locals.dossierActor;
  const archived = req.query.archived === "true";
  if (archived && !actor.isKeeper) { res.json([]); return; }
  const own = actor.isKeeper ? eq(dossiersTable.ownerUid, actor.uid) : undefined;
  const visible = archived ? own! : own ? or(own, isNotNull(dossiersTable.publication)) : isNotNull(dossiersTable.publication);
  const rows = await db.select().from(dossiersTable).where(and(
    eq(dossiersTable.archived, archived), visible,
  )).orderBy(desc(dossiersTable.updatedAt));
  res.json(rows.map(row => dto(row, actor)));
});

router.get("/dossiers/:id", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) { res.status(404).end(); return; }
  const actor: MemberActor = res.locals.dossierActor;
  const [row] = await db.select().from(dossiersTable).where(eq(dossiersTable.id, String(req.params.id)));
  if (!row || (!(actor.isKeeper && row.ownerUid === actor.uid) && (!row.publication || row.archived))) {
    res.status(404).json({ error: "Dossier not found." }); return;
  }
  res.json(dto(row, actor));
});

router.post("/dossiers", async (req, res) => {
  const actor: MemberActor = res.locals.dossierActor;
  if (!actor.isKeeper) { res.status(403).json({ error: "Only 00-00 can create or publish a Dossier." }); return; }
  const body = CreateDossierBody.safeParse(req.body);
  if (!body.success || !body.data.title.trim() || body.data.archived || body.data.version !== 0) {
    res.status(400).json({ error: "A title, category, and valid new dossier are required." }); return;
  }
  let document: Record<string, unknown>;
  try { document = parseDossierDocument(body.data.document, res.locals.dossierUid); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence." }); return; }
  const title = body.data.title.trim();
  const savedDocument = { ...document, title };
  const [row] = await db.insert(dossiersTable).values({
    ownerUid: res.locals.dossierUid, title: body.data.title.trim(), category: body.data.category,
    document: savedDocument,
    publication: body.data.publish ? { title, category: body.data.category, document: savedDocument, publishedAt: new Date().toISOString() } : null,
  }).returning();
  res.status(201).json(dto(row!, actor));
});

router.put("/dossiers/:id", async (req, res) => {
  const actor: MemberActor = res.locals.dossierActor;
  if (!actor.isKeeper) { res.status(403).json({ error: "Only 00-00 can edit or publish a Dossier." }); return; }
  const body = UpdateDossierBody.safeParse(req.body);
  if (!body.success || !body.data.title.trim() || (body.data.archived && body.data.publish) || !/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
    res.status(400).json({ error: "Invalid dossier." }); return;
  }
  let document: Record<string, unknown>;
  try { document = parseDossierDocument(body.data.document, res.locals.dossierUid); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence." }); return; }
  const title = body.data.title.trim();
  const savedDocument = { ...document, title };
  // Draft saves never replace what members read. Sealing withdraws publication;
  // restoring remains a draft until 00-00 explicitly publishes it again.
  const [row] = await db.update(dossiersTable).set({
    title: body.data.title.trim(), category: body.data.category,
    document: savedDocument, archived: body.data.archived,
    publication: body.data.archived ? null : body.data.publish
      ? { title, category: body.data.category, document: savedDocument, publishedAt: new Date().toISOString() }
      : undefined,
    version: sql`${dossiersTable.version} + 1`, updatedAt: new Date(),
  }).where(and(eq(dossiersTable.id, String(req.params.id)),
    eq(dossiersTable.ownerUid, res.locals.dossierUid), eq(dossiersTable.version, body.data.version))).returning();
  if (!row) { res.status(409).json({ error: "This dossier changed on another device. Reload it before saving." }); return; }
  res.json(dto(row, actor));
});

export default router;
