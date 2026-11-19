import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_opencraft_message_attachments = sqliteTable("opencraft_message_attachments", {
  "thread_id": text("thread_id").notNull(),
  "client_message_id": text("client_message_id").notNull(),
  "attachment_id": text("attachment_id").notNull(),
  "ordinal": integer("ordinal").notNull(),
  "ref_json": text("ref_json").notNull(),
}, table => [
  primaryKey({ columns: [table["thread_id"], table["client_message_id"], table["attachment_id"]] }),
  index("opencraft_message_attachments_message").on(table["thread_id"], table["client_message_id"], table["ordinal"]),
]);
