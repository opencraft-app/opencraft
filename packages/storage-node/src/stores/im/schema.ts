import { sqliteTable, text, integer, real, blob, numeric, primaryKey, unique, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const table_im_channels = sqliteTable("im_channels", {
  "id": text("id").notNull(),
  "owner_id": text("owner_id").notNull(),
  "config": text("config").notNull(),
  "revision": integer("revision").notNull(),
  "route": text("route"),
  "draft": text("draft"),
  "enabled": integer("enabled").notNull(),
  "deleted": integer("deleted").notNull().default(sql`0`),
}, table => [
  primaryKey({ columns: [table["id"]] }),
]);

export const table_im_identity_challenges = sqliteTable("im_identity_challenges", {
  "hash": text("hash").notNull(),
  "channel_id": text("channel_id").notNull(),
  "actor_id": text("actor_id").notNull(),
  "expires_at": integer("expires_at").notNull(),
}, table => [
  primaryKey({ columns: [table["hash"]] }),
]);

export const table_im_messages = sqliteTable("im_messages", {
  "id": text("id").notNull(),
  "channel_id": text("channel_id").notNull(),
  "fingerprint": text("fingerprint").notNull(),
  "actor_id": text("actor_id").notNull(),
  "source": text("source").notNull(),
  "text": text("text").notNull(),
  "route_revision": integer("route_revision").notNull(),
  "decision": text("decision"),
  "conversation_ref": text("conversation_ref"),
  "request_id": text("request_id"),
  "reply_address": text("reply_address"),
  "reply_text": text("reply_text"),
  "state": text("state").notNull(),
  "error": text("error"),
  "created_at": integer("created_at").notNull(),
  "updated_at": integer("updated_at").notNull(),
  "reply_mode": text("reply_mode").notNull().default(sql`'final'`),
  "reply_ref": text("reply_ref"),
  "reply_expires_at": integer("reply_expires_at"),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  uniqueIndex("im_messages_reply_ref").on(table["reply_ref"]).where(sql`reply_ref IS NOT NULL`),
  index("im_messages_channel").on(table["channel_id"], table["created_at"]),
]);

export const table_im_route_versions = sqliteTable("im_route_versions", {
  "channel_id": text("channel_id").notNull(),
  "revision": integer("revision").notNull(),
  "source": text("source"),
  "created_at": integer("created_at").notNull(),
}, table => [
  primaryKey({ columns: [table["channel_id"], table["revision"]] }),
]);

export const table_im_sender_links = sqliteTable("im_sender_links", {
  "channel_id": text("channel_id").notNull(),
  "sender_id": text("sender_id").notNull(),
  "actor_id": text("actor_id").notNull(),
}, table => [
  primaryKey({ columns: [table["channel_id"], table["sender_id"]] }),
]);

export const table_switchboard = sqliteTable("switchboard", {
  "id": text("id").notNull(),
  "bot_endpoint_id": text("bot_endpoint_id").notNull(),
  "source_key": text("source_key").notNull(),
  "conversation_ref": text("conversation_ref").notNull(),
}, table => [
  primaryKey({ columns: [table["id"]] }),
  unique("legacy_unique_switchboard_2").on(table["bot_endpoint_id"], table["source_key"]),
]);
