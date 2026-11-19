import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_apps = sqliteTable("apps", {
  "owner": text("owner").notNull(),
  "id": text("id").notNull(),
  "version": integer("version").notNull(),
  "active": integer("active"),
  "next": integer("next").notNull(),
  "draft": text("draft").notNull(),
  "deleted": integer("deleted").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["owner"], table["id"]] }),
]);

export const table_releases = sqliteTable("releases", {
  "owner": text("owner").notNull(),
  "id": text("id").notNull(),
  "revision": integer("revision").notNull(),
  "uri": text("uri").notNull(),
  "spec": text("spec").notNull(),
  "created": integer("created").notNull(),
}, table => [
  primaryKey({ columns: [table["owner"], table["id"], table["revision"]] }),
  foreignKey({ columns: [table["owner"], table["id"]], foreignColumns: [table_apps["owner"], table_apps["id"]] }).onUpdate("no action").onDelete("cascade"),
]);
