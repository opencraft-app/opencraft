import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_resource_imports = sqliteTable("resource_imports", {
  "id": text("id").notNull(),
  "digest": text("digest").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_resource_legacy_heads = sqliteTable("resource_legacy_heads", {
  "owner": text("owner").notNull(),
  "value": text("value").notNull(),
}, table => [
  primaryKey({ columns: [table["owner"]] }),
]);

export const table_resource_mutations = sqliteTable("resource_mutations", {
  "seq": integer("seq").primaryKey({ autoIncrement: true }),
  "owner": text("owner").notNull(),
  "id": text("id").notNull(),
  "fingerprint": text("fingerprint").notNull(),
  "result": text("result").notNull(),
}, table => [
  index("resource_mutations_owner_seq").on(table["owner"], table["seq"]),
  unique("legacy_unique_resource_mutations_1").on(table["owner"], table["id"]),
]);

export const table_resource_records = sqliteTable("resource_records", {
  "owner": text("owner").notNull(),
  "collection": text("collection").notNull(),
  "id": text("id").notNull(),
  "revision": integer("revision").notNull(),
  "value": text("value"),
  "page_ref": text("page_ref"),
  "lease_ref": text("lease_ref"),
  "scope_ref": text("scope_ref"),
}, table => [
  primaryKey({ columns: [table["owner"], table["collection"], table["id"]] }),
  index("resource_records_scope").on(table["owner"], table["collection"], table["scope_ref"]),
  index("resource_records_lease").on(table["owner"], table["collection"], table["lease_ref"]),
  index("resource_records_page").on(table["owner"], table["collection"], table["page_ref"]),
  check("resource_records_check_0", sql`revision>0`),
]);
