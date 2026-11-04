import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_thread_access = sqliteTable("thread_access", {
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "creator_actor_id": text("creator_actor_id"),
  "access_mode": text("access_mode").notNull(),
  "revision": integer("revision").notNull(),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["server_id"], table["thread_id"]] }),
  check("thread_access_check_0", sql`access_mode IN ('shared','private')`),
  check("thread_access_check_1", sql`revision>=1`),
  check("thread_access_check_2", sql`access_mode!='private' OR creator_actor_id IS NOT NULL`),
]);

export const table_thread_access_audit = sqliteTable("thread_access_audit", {
  "id": integer("id"),
  "server_id": text("server_id").notNull(),
  "thread_id": text("thread_id").notNull(),
  "actor_id": text("actor_id").notNull(),
  "access_mode": text("access_mode").notNull(),
  "revision": integer("revision").notNull(),
  "at": integer("at").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);
