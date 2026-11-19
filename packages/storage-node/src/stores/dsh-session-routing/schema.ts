import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_dsh_pending_generations = sqliteTable("dsh_pending_generations", {
  "native_id": text("native_id"),
  "logical_id": text("logical_id").notNull(),
  "intent": text("intent"),
}, table => [
  primaryKey({ columns: [table["native_id"]] }),
]);

export const table_dsh_session_generations = sqliteTable("dsh_session_generations", {
  "logical_id": text("logical_id").notNull(),
  "native_id": text("native_id").notNull(),
  "generation": integer("generation").notNull(),
  "seed_seq": integer("seed_seq").notNull(),
  "seed_turn": integer("seed_turn").notNull(),
  "prior_seq": integer("prior_seq").notNull(),
  "prior_turn": integer("prior_turn").notNull(),
}, table => [
  primaryKey({ columns: [table["logical_id"], table["generation"]] }),
  unique("legacy_unique_dsh_session_generations_1").on(table["native_id"]),
]);
