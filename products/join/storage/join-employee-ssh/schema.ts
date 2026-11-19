import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_employee_ssh_credentials = sqliteTable("employee_ssh_credentials", {
  "actor_id": text("actor_id").notNull(),
  "subject": text("subject").notNull(),
  "username": text("username").notNull(),
  "generation": integer("generation").notNull(),
  "private_key": text("private_key").notNull(),
  "public_key": text("public_key").notNull(),
  "fingerprint": text("fingerprint").notNull(),
  "created_at": integer("created_at").notNull(),
}, table => [
  primaryKey({ columns: [table["actor_id"]] }),
  unique("legacy_unique_employee_ssh_credentials_3").on(table["username"]),
  unique("legacy_unique_employee_ssh_credentials_2").on(table["subject"]),
]);

export const employeeCliKeys = sqliteTable('employee_cli_keys', {
  id: text('id').primaryKey(), actorId: text('actor_id').notNull(), subject: text('subject').notNull(),
  username: text('username').notNull(), generation: integer('generation').notNull(), name: text('name').notNull(),
  membershipRevision: integer('membership_revision').notNull().default(0),
  publicKey: text('public_key').notNull(), fingerprint: text('fingerprint').notNull(), createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'), revokedAt: integer('revoked_at'), revokedBy: text('revoked_by'),
}, table => [index('employee_cli_keys_actor').on(table.actorId), index('employee_cli_keys_fingerprint').on(table.fingerprint)]);
export const employeeCliKeyAudit = sqliteTable('employee_cli_key_audit', {
  id: integer('id').primaryKey({autoIncrement:true}), operator: text('operator').notNull(), employee: text('employee').notNull(),
  actorId: text('actor_id'), fingerprint: text('fingerprint'), action: text('action').notNull(), at: integer('at').notNull(), result: text('result').notNull(),
});
