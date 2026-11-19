import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_im_post_receipts = sqliteTable("im_post_receipts", {
  "scope": text("scope").notNull(),
  "request_id": text("request_id").notNull(),
  "fingerprint": text("fingerprint").notNull(),
  "state": text("state").notNull(),
  "post_id": text("post_id"),
  "updated_at": integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table["scope"], table["request_id"]] }),
  check("im_post_receipts_check_0", sql`state IN ('sending','delivered','rejected','unknown')`),
]);
