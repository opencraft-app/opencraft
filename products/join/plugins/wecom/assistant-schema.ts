import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Internal distribution tables, migrated with the native timeline's database so
// intake and delivery are atomic with their source messages.
export const wecomAssistantRequests = sqliteTable('join_wecom_assistant_requests', {
  messageId: text('message_id').primaryKey(),
  scope: text('scope'),
  source: text('source').notNull(), sourceEpoch: text('source_epoch').notNull(),
  channelId: text('channel_id').notNull(), userId: text('user_id').notNull(),
  ownerId: text('owner_id'), ownerGeneration: integer('owner_generation'),
  assistantId: text('assistant_id'), assistantEpoch: text('assistant_epoch'),
  memberEpoch: text('member_epoch'), reason: text('reason'),
}, table => [index('join_wecom_assistant_scope').on(table.assistantId, table.scope)]);
export const wecomAssistantReplies = sqliteTable('join_wecom_assistant_replies', {
  messageId: text('message_id').primaryKey(), requestId: text('request_id').notNull(), payloadHash:text('payload_hash').notNull(),
});

// Operation journal and confirmed transport facts, not a second membership table.
export const wecomGroupSync = sqliteTable('join_wecom_group_sync', {
  source:text('source').primaryKey(), channelId:text('channel_id').notNull(), value:text('value').notNull(),
}, table=>[index('join_wecom_sync_channel').on(table.channelId)]);
