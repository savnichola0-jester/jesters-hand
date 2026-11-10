import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";

// New Dossier content lives in PostgreSQL, not in Firebase. Firebase remains
// the existing identity provider; ownerUid is derived from its verified token.
export const dossiersTable = pgTable("jesters_dossiers", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUid: text("owner_uid").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  document: jsonb("document").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("dossiers_owner_archive_idx").on(table.ownerUid, table.archived)]);
