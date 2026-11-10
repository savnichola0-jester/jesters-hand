import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, dossiersTable } from "@workspace/db";
import { CreateDossierBody, UpdateDossierBody } from "@workspace/api-zod";
import { actorFor } from "../lib/memberActor";
import { parseDossierDocument } from "../lib/dossierValidation";

const router: IRouter = Router();
type Row = typeof dossiersTable.$inferSelect;
function dto(row: Row) {
  return {
    id: row.id, title: row.title, category: row.category,
    document: JSON.stringify(row.document), version: row.version, archived: row.archived,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}
router.use("/dossiers", async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const actor = await actorFor(req);
    if (!actor?.isKeeper) { res.status(403).json({ error: "Only the active 00-00 login may access the Dossier." }); return; }
    res.locals.dossierUid = actor.uid;
    next();
  } catch {
    res.status(503).json({ error: "Could not verify private Dossier access. Try again." });
  }
});

router.get("/dossiers", async (req, res) => {
  if (req.query.archived !== undefined && !["true", "false"].includes(String(req.query.archived))) {
    res.status(400).json({ error: "Invalid archive filter." }); return;
  }
  const rows = await db.select().from(dossiersTable).where(and(
    eq(dossiersTable.ownerUid, res.locals.dossierUid),
    eq(dossiersTable.archived, req.query.archived === "true"),
  )).orderBy(desc(dossiersTable.updatedAt));
  res.json(rows.map(dto));
});

router.get("/dossiers/:id", async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) { res.status(404).end(); return; }
  const [row] = await db.select().from(dossiersTable).where(and(
    eq(dossiersTable.id, String(req.params.id)), eq(dossiersTable.ownerUid, res.locals.dossierUid),
  ));
  if (!row) { res.status(404).json({ error: "Dossier not found." }); return; }
  res.json(dto(row));
});

router.post("/dossiers", async (req, res) => {
  const body = CreateDossierBody.safeParse(req.body);
  if (!body.success || !body.data.title.trim() || body.data.archived || body.data.version !== 0) {
    res.status(400).json({ error: "A title, category, and valid new dossier are required." }); return;
  }
  let document: Record<string, unknown>;
  try { document = parseDossierDocument(body.data.document, res.locals.dossierUid); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence." }); return; }
  const [row] = await db.insert(dossiersTable).values({
    ownerUid: res.locals.dossierUid, title: body.data.title.trim(), category: body.data.category,
    document: { ...document, title: body.data.title.trim() },
  }).returning();
  res.status(201).json(dto(row!));
});

router.put("/dossiers/:id", async (req, res) => {
  const body = UpdateDossierBody.safeParse(req.body);
  if (!body.success || !body.data.title.trim() || !/^[0-9a-f-]{36}$/i.test(String(req.params.id))) {
    res.status(400).json({ error: "Invalid dossier." }); return;
  }
  let document: Record<string, unknown>;
  try { document = parseDossierDocument(body.data.document, res.locals.dossierUid); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid evidence." }); return; }
  // Archiving retains the complete evidence board and files privately. Never
  // write this content to shared Hand Archives or emit member notifications.
  const [row] = await db.update(dossiersTable).set({
    title: body.data.title.trim(), category: body.data.category,
    document: { ...document, title: body.data.title.trim() }, archived: body.data.archived,
    version: sql`${dossiersTable.version} + 1`, updatedAt: new Date(),
  }).where(and(eq(dossiersTable.id, String(req.params.id)),
    eq(dossiersTable.ownerUid, res.locals.dossierUid), eq(dossiersTable.version, body.data.version))).returning();
  if (!row) { res.status(409).json({ error: "This dossier changed on another device. Reload it before saving." }); return; }
  res.json(dto(row));
});

export default router;
