import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, dossiersTable } from "@workspace/db";

/** Only images in the actual published snapshot become readable to members.
 * Uploads and unpublished draft additions remain owner-only. */
export async function dossierPhotoPublished(path: string): Promise<boolean> {
  const [match] = await db.select({ id: dossiersTable.id }).from(dossiersTable).where(and(
    eq(dossiersTable.archived, false),
    isNotNull(dossiersTable.publication),
    sql`${dossiersTable.publication}->'document'->'spread'->'elements' @> ${JSON.stringify([{ uri: `dossier://${path}` }])}::jsonb`,
  )).limit(1);
  return !!match;
}
