import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, check } from "drizzle-orm/sqlite-core";

export const checkpoint = sqliteTable("account_handoff_checkpoint", {
  singleton: integer("singleton").primaryKey(), value: text("value").notNull(),
}, table => [check("account_handoff_singleton", sql`${table.singleton}=1`)]);
export const requests = sqliteTable("account_request_facts", {
  seq: integer("seq").primaryKey(), id: text("id").notNull().unique(), owner: text("owner").notNull(), route: text("route").notNull(),
  terminal: text("terminal"), settled: integer("settled").notNull(), unknownSeq: integer("unknown_seq").unique(), unknownJson: text("unknown_json"),
}, table => [check("account_request_terminal", sql`${table.terminal} IN ('completed','failed')`),
  check("account_request_settled", sql`${table.settled} IN (0,1)`)]);
