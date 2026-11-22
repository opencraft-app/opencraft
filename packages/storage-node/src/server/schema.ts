import { sqliteTable, text, integer, real, blob, primaryKey, index, uniqueIndex, foreignKey, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const accessAudit = sqliteTable("access_audit", {
  id: integer("id").primaryKey(),
  at: integer("at").notNull(),
  operator: text("operator").notNull(),
  binding: text("binding").notNull(),
  action: text("action").notNull(),
}, table => [
]);

export const accessImports = sqliteTable("access_imports", {
  source: text("source").notNull().primaryKey(),
}, table => [
]);

export const accountInvitations = sqliteTable("account_invitations", {
  digest: text("digest").notNull().primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  state: text("state").notNull(),
  username: text("username"),
  subject: text("subject").notNull(),
  actorId: text("actor_id"),
  createdBy: text("created_by").notNull(),
}, table => [
]);

export const accountSetup = sqliteTable("account_setup", {
  id: integer("id").primaryKey(),
  state: text("state").notNull(),
  mode: text("mode"),
  username: text("username"),
  subject: text("subject"),
  ownerActor: text("owner_actor"),
}, table => [
  check("account_setup_check_1", sql.raw("id=1")),
]);

export const actorAudit = sqliteTable("actor_audit", {
  id: integer("id").primaryKey(),
  at: integer("at").notNull(),
  operator: text("operator").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  resource: text("resource"),
}, table => [
]);

export const actorAuthority = sqliteTable("actor_authority", {
  singleton: integer("singleton").primaryKey(),
  id: text("id").notNull(),
}, table => [
  check("actor_authority_check_1", sql.raw("singleton=1")),
]);

export const actorBindings = sqliteTable("actor_bindings", {
  binding: text("binding").notNull().primaryKey(),
  actorId: text("actor_id").notNull(),
}, table => [
  foreignKey({ columns: [table.actorId], foreignColumns: [actors.id] }),
]);

export const actorCollaborationAudit = sqliteTable("actor_collaboration_audit", {
  id: text("id").notNull().primaryKey(),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  resourceId: text("resource_id").notNull(),
  detail: text("detail").notNull(),
  happenedAt: integer("happened_at").notNull(),
}, table => [
]);

export const actorCredentials = sqliteTable("actor_credentials", {
  id: text("id").notNull().primaryKey(),
  actorId: text("actor_id").notNull(),
  digest: text("digest").notNull(),
  generation: integer("generation").notNull(),
  expiresAt: integer("expires_at").notNull(),
  enabled: integer("enabled").notNull(),
}, table => [
  foreignKey({ columns: [table.actorId], foreignColumns: [actors.id] }),
  check("actor_credentials_check_1", sql.raw("enabled IN (0,1)")),
]);

export const actorDeliveries = sqliteTable("actor_deliveries", {
  messageId: text("message_id").notNull(),
  receiverId: text("receiver_id").notNull(),
  state: text("state").notNull(),
  receivedAt: integer("received_at").notNull(),
  readAt: integer("read_at"),
}, table => [
  primaryKey({ columns: [table.messageId, table.receiverId] }),
  foreignKey({ columns: [table.messageId], foreignColumns: [actorMessages.id] }),
  check("actor_deliveries_check_1", sql.raw("state IN ('received','read')")),
]);

export const actorExecutionInputs = sqliteTable("actor_execution_inputs", {
  requestId: text("request_id").notNull(),
  messageId: text("message_id").notNull(),
  position: integer("position").notNull(),
}, table => [
  primaryKey({ columns: [table.requestId, table.messageId] }),
  uniqueIndex("actor_execution_inputs_request_id_position_unique").on(table.requestId, table.position),
  foreignKey({ columns: [table.messageId], foreignColumns: [actorMessages.id] }),
  foreignKey({ columns: [table.requestId], foreignColumns: [actorExecutionRequests.id] }),
]);

export const actorExecutionRequests = sqliteTable("actor_execution_requests", {
  id: text("id").notNull().primaryKey(),
  requesterId: text("requester_id").notNull(),
  requesterGeneration: integer("requester_generation").notNull(),
  targetId: text("target_id").notNull(),
  targetGeneration: integer("target_generation").notNull(),
  bindingEpoch: integer("binding_epoch").notNull(),
  threadId: text("thread_id").notNull(),
  mode: text("mode").notNull(),
  expectedTurnId: text("expected_turn_id"),
  state: text("state").notNull(),
  queueId: text("queue_id"),
  turnId: text("turn_id"),
  reason: text("reason"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  targetKind: text("target_kind").notNull().default(sql.raw("'actor'")),
  hostId: text("host_id").default(sql.raw("'local-codex'")),
  serverId: text("server_id"),
  credentialId: text("credential_id"),
  expiresAt: integer("expires_at"),
}, table => [
  index("actor_execution_pending").on(table.state, table.createdAt),
  check("actor_execution_requests_check_1", sql.raw("mode IN ('queue','steer')")),
  check("actor_execution_requests_check_2", sql.raw("state IN ('accepted','transferring','queued','submitted','injected','rejected','cancelled','unknown')")),
]);

export const actorGrants = sqliteTable("actor_grants", {
  actorId: text("actor_id").notNull(),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  enabled: integer("enabled").notNull(),
}, table => [
  primaryKey({ columns: [table.actorId, table.resource, table.action] }),
  foreignKey({ columns: [table.actorId], foreignColumns: [actors.id] }),
  check("actor_grants_check_1", sql.raw("enabled IN (0,1)")),
]);

export const actorMembers = sqliteTable("actor_members", {
  actorId: text("actor_id").notNull().primaryKey(),
  role: text("role").notNull(),
  enabled: integer("enabled").notNull(),
}, table => [
  check("actor_members_check_1", sql.raw("role IN ('admin','member')")),
  check("actor_members_check_2", sql.raw("enabled IN (0,1)")),
]);

export const actorMessages = sqliteTable("actor_messages", {
  id: text("id").notNull().primaryKey(),
  seq: integer("seq").notNull(),
  channelId: text("channel_id").notNull(),
  authorId: text("author_id").notNull(),
  targetId: text("target_id").notNull(),
  content: text("content").notNull(),
  replyTo: text("reply_to"),
  createdAt: integer("created_at").notNull(),
  targetKind: text("target_kind").notNull().default(sql.raw("'actor'")),
  serverId: text("server_id"),
  sourceRef: text("source_ref"),
  delegationId: text("delegation_id"),
  authorDisplayName: text("author_display_name"),
}, table => [
  index("actor_messages_channel").on(table.channelId, table.seq),
  uniqueIndex("actor_messages_seq_unique").on(table.seq),
]);

export const actorChannelMentions = sqliteTable("actor_channel_mentions", {
  messageId: text("message_id").notNull().references(() => actorMessages.id),
  actorId: text("actor_id").notNull(),
  start: integer("start").notNull(), end: integer("end").notNull(),
  displayName: text("display_name").notNull(), actorKind: text("actor_kind").notNull(),
}, table => [primaryKey({columns:[table.messageId,table.start]}),
  index("actor_channel_mentions_receiver").on(table.actorId,table.messageId),
  check("actor_channel_mentions_range",sql.raw("start >= 0 AND end > start")),
  check("actor_channel_mentions_kind",sql.raw("actor_kind IN ('human','session')"))]);

/** A visible mention is acknowledged independently of the ordinary read-to-latest cursor. */
export const actorChannelMentionReads = sqliteTable("actor_channel_mention_reads", {
  messageId: text("message_id").notNull().references(() => actorMessages.id),
  actorId: text("actor_id").notNull(),
}, table => [primaryKey({columns:[table.messageId,table.actorId]})]);

export const actorRunBindings = sqliteTable("actor_run_bindings", {
  actorId: text("actor_id").notNull().primaryKey(),
  hostId: text("host_id").notNull(),
  threadId: text("thread_id").notNull(),
  epoch: integer("epoch").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, table => [
  uniqueIndex("actor_run_bindings_thread_id_unique").on(table.threadId),
]);

export const actorSendKeys = sqliteTable("actor_send_keys", {
  actorId: text("actor_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  messageId: text("message_id"),
  requestId: text("request_id"),
}, table => [
  primaryKey({ columns: [table.actorId, table.idempotencyKey] }),
]);

export const actors = sqliteTable("actors", {
  id: text("id").notNull().primaryKey(),
  kind: text("kind").notNull(),
  displayName: text("display_name").notNull(),
  enabled: integer("enabled").notNull(),
  generation: integer("generation").notNull(),
  createdAt: integer("created_at").notNull(),
  createdBy: text("created_by"),
}, table => [
  check("actors_check_1", sql.raw("kind IN ('human','session')")),
  check("actors_check_2", sql.raw("enabled IN (0,1)")),
]);

export const capabilityBindings = sqliteTable("capability_bindings", {
  id: text("id").notNull().primaryKey(),
  serverId: text("server_id").notNull(),
  threadId: text("thread_id").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("capability_bindings_server_id_thread_id_unique").on(table.serverId, table.threadId),
]);

export const conversationAuthorities = sqliteTable("conversation_authorities", {
  id: text("id").notNull().primaryKey(),
  threadId: text("thread_id").notNull(),
  turnId: text("turn_id"),
  inputId: text("input_id"),
  actorId: text("actor_id").notNull(),
  generation: integer("generation").notNull(),
  credentialId: text("credential_id"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
}, table => [
  uniqueIndex("conversation_authorities_thread_id_input_id_unique").on(table.threadId, table.inputId),
  uniqueIndex("conversation_authorities_thread_id_turn_id_unique").on(table.threadId, table.turnId),
]);

export const conversationToolBudget = sqliteTable("conversation_tool_budget", {
  authorityId: text("authority_id").notNull().primaryKey(),
  sent: integer("sent").notNull(),
}, table => [
]);

export const conversationTurnAuthorities = sqliteTable("conversation_turn_authorities", {
  threadId: text("thread_id").notNull(),
  turnId: text("turn_id").notNull(),
  authorityId: text("authority_id").notNull(),
}, table => [
  primaryKey({ columns: [table.threadId, table.turnId] }),
  foreignKey({ columns: [table.authorityId], foreignColumns: [conversationAuthorities.id] }),
]);

export const humanIdentityLabels = sqliteTable("human_identity_labels", {
  binding: text("binding").notNull().primaryKey(),
  label: text("label").notNull(),
}, table => [
]);

export const humanLogins = sqliteTable("human_logins", {
  digest: text("digest").notNull().primaryKey(),
  principal: text("principal").notNull(),
  actorId: text("actor_id").notNull(),
  generation: integer("generation").notNull(),
  accountVersion: integer("account_version"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, table => [
  index("human_logins_expiry").on(table.expiresAt),
]);

export const localAccounts = sqliteTable("local_accounts", {
  id: text("id").notNull().primaryKey(),
  username: text("username").notNull(),
  displayName: text("display_name").notNull(),
  salt: text("salt").notNull(),
  passwordDigest: text("password_digest").notNull(),
  enabled: integer("enabled").notNull(),
  version: integer("version").notNull(),
}, table => [
  uniqueIndex("local_accounts_username_unique").on(table.username),
  check("local_accounts_check_1", sql.raw("enabled IN (0,1)")),
]);

export const members = sqliteTable("members", {
  binding: text("binding").notNull().primaryKey(),
  role: text("role").notNull(),
  enabled: integer("enabled").notNull(),
}, table => [
  check("members_check_1", sql.raw("role IN ('admin','member')")),
  check("members_check_2", sql.raw("enabled IN (0,1)")),
]);

export const opencraftDelegationRoots = sqliteTable("opencraft_delegation_roots", {
  authorityId: text("authority_id").notNull().primaryKey(),
  rootAuthorityId: text("root_authority_id").notNull(),
}, table => [
  foreignKey({ columns: [table.rootAuthorityId], foreignColumns: [conversationAuthorities.id] }),
  foreignKey({ columns: [table.authorityId], foreignColumns: [conversationAuthorities.id] }),
]);

export const opencraftInputAuthorities = sqliteTable("opencraft_input_authorities", {
  threadId: text("thread_id").notNull(),
  inputId: text("input_id").notNull(),
  authorityId: text("authority_id").notNull(),
}, table => [
  primaryKey({ columns: [table.threadId, table.inputId] }),
  foreignKey({ columns: [table.authorityId], foreignColumns: [conversationAuthorities.id] }),
]);

export const opencraftInputOrigins = sqliteTable("opencraft_input_origins", {
  threadId: text("thread_id").notNull(),
  inputId: text("input_id").notNull(),
  originJson: text("origin_json").notNull(),
}, table => [
  primaryKey({ columns: [table.threadId, table.inputId] }),
]);

export const opencraftNotificationAuthorities = sqliteTable("opencraft_notification_authorities", {
  batchId: text("batch_id").notNull().primaryKey(),
  authorityId: text("authority_id").notNull(),
}, table => [
  foreignKey({ columns: [table.authorityId], foreignColumns: [conversationAuthorities.id] }),
  foreignKey({ columns: [table.batchId], foreignColumns: [opencraftParentNotificationBatches.batchId] }),
]);

export const opencraftOrchestrationAcks = sqliteTable("opencraft_orchestration_acks", {
  operationId: text("operation_id").notNull().primaryKey(),
}, table => [
  foreignKey({ columns: [table.operationId], foreignColumns: [opencraftOrchestrationOperations.operationId] }),
]);

export const opencraftOrchestrationOperations = sqliteTable("opencraft_orchestration_operations", {
  operationId: text("operation_id").notNull().primaryKey(),
  toolCallKey: text("tool_call_key").notNull(),
  idempotencyKey: text("idempotency_key"),
  fingerprint: text("fingerprint").notNull(),
  argumentsJson: text("arguments_json").notNull(),
  delegationId: text("delegation_id").notNull(),
  issuerActorId: text("issuer_actor_id").notNull(),
  kind: text("kind").notNull(),
  senderThreadId: text("sender_thread_id").notNull(),
  targetThreadId: text("target_thread_id"),
  clientMessageId: text("client_message_id"),
  mode: text("mode").notNull(),
  state: text("state").notNull(),
  waitingOn: text("waiting_on"),
  resultJson: text("result_json"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  quotaReserved: integer("quota_reserved").notNull().default(sql.raw("0")),
}, table => [
  index("opencraft_orchestration_pending").on(table.state, table.createdAtMs),
  uniqueIndex("opencraft_orchestration_operations_client_message_id_unique").on(table.clientMessageId),
  uniqueIndex("opencraft_orchestration_operations_idempotency_key_unique").on(table.idempotencyKey),
  uniqueIndex("opencraft_orchestration_operations_tool_call_key_unique").on(table.toolCallKey),
]);

export const opencraftOrchestrationRuntimeViews = sqliteTable("opencraft_orchestration_runtime_views", {
  threadId: text("thread_id").notNull().primaryKey(),
  rootTurnId: text("root_turn_id"),
  turnId: text("turn_id"),
  state: text("state").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
}, table => [
]);

export const opencraftOrchestrationToolCalls = sqliteTable("opencraft_orchestration_tool_calls", {
  toolCallKey: text("tool_call_key").notNull().primaryKey(),
  operationId: text("operation_id").notNull(),
}, table => [
  foreignKey({ columns: [table.operationId], foreignColumns: [opencraftOrchestrationOperations.operationId] }),
]);

export const opencraftParentNotificationBatches = sqliteTable("opencraft_parent_notification_batches", {
  batchId: text("batch_id").notNull().primaryKey(),
  parentThreadId: text("parent_thread_id").notNull(),
  childThreadId: text("child_thread_id").notNull(),
  childRootTurnId: text("child_root_turn_id").notNull(),
  outcomeKind: text("outcome_kind").notNull(),
  hasDirectUserInput: integer("has_direct_user_input").notNull().default(sql.raw("0")),
  userInputExcerpt: text("user_input_excerpt"),
  summaryJson: text("summary_json").notNull(),
  firstQueuedAtMs: integer("first_queued_at_ms").notNull(),
  deliverAfterMs: integer("deliver_after_ms").notNull(),
  maxDeadlineMs: integer("max_deadline_ms").notNull(),
  state: text("state").notNull().default(sql.raw("'pending'")),
  clientMessageId: text("client_message_id"),
}, table => [
  index("opencraft_parent_notification_due").on(table.state, table.deliverAfterMs),
  uniqueIndex("opencraft_parent_notification_batches_parent_thread_id_child_thread_id_child_root_turn_id_outcome_kind_unique").on(table.parentThreadId, table.childThreadId, table.childRootTurnId, table.outcomeKind),
]);

export const opencraftServerImports = sqliteTable("opencraft_server_imports", {
  source: text("source").notNull().primaryKey(),
  sourceDigest: text("source_digest").notNull(),
  migrationHistory: text("migration_history").notNull(),
  rowCounts: text("row_counts").notNull(),
  backupPath: text("backup_path").notNull(),
  importedAt: integer("imported_at").notNull(),
}, table => [
]);

export const opencraftServerInstallation = sqliteTable("opencraft_server_installation", {
  singleton: integer("singleton").primaryKey(),
  productVersion: text("product_version").notNull(),
  contractHash: text("contract_hash").notNull(),
  completedAt: integer("completed_at").notNull(),
}, table => [
  check("opencraft_server_installation_check_1", sql.raw("singleton=1")),
]);

export const opencraftSpawnPreparations = sqliteTable("opencraft_spawn_preparations", {
  operationId: text("operation_id").notNull().primaryKey(),
  settingsJson: text("settings_json").notNull(),
}, table => [
  foreignKey({ columns: [table.operationId], foreignColumns: [opencraftOrchestrationOperations.operationId] }),
]);

export const opencraftThreadAuthorities = sqliteTable("opencraft_thread_authorities", {
  threadId: text("thread_id").notNull().primaryKey(),
  authorityId: text("authority_id").notNull(),
}, table => [
  foreignKey({ columns: [table.authorityId], foreignColumns: [conversationAuthorities.id] }),
]);

export const opencraftThreadRelations = sqliteTable("opencraft_thread_relations", {
  threadId: text("thread_id").notNull().primaryKey(),
  serverId: text("server_id").notNull(),
  driverKind: text("driver_kind").notNull(),
  engineHostGeneration: text("engine_host_generation"),
  nativeSessionId: text("native_session_id"),
  ownerActorId: text("owner_actor_id").notNull(),
  parentThreadId: text("parent_thread_id"),
  lifecycleOwnerThreadId: text("lifecycle_owner_thread_id"),
  forkedFromId: text("forked_from_id"),
  visibility: text("visibility").notNull(),
  runtimeStatus: text("runtime_status").notNull(),
  rootTurnId: text("root_turn_id"),
  turnId: text("turn_id"),
  delegationRevision: integer("delegation_revision").notNull().default(sql.raw("0")),
  autoExchangeDepth: integer("auto_exchange_depth").notNull().default(sql.raw("0")),
  hasDirectUserInput: integer("has_direct_user_input").notNull().default(sql.raw("0")),
  userInputExcerpt: text("user_input_excerpt"),
  updatedAtMs: integer("updated_at_ms").notNull(),
}, table => [
  index("opencraft_thread_parents").on(table.parentThreadId),
  check("opencraft_thread_relations_check_1", sql.raw("visibility IN ('visible','hidden')")),
]);

export const opencraftWaitTickets = sqliteTable("opencraft_wait_tickets", {
  waitTicketId: text("wait_ticket_id").notNull().primaryKey(),
  callerThreadId: text("caller_thread_id").notNull(),
  callerTurnId: text("caller_turn_id").notNull(),
  targetThreadIdsJson: text("target_thread_ids_json").notNull(),
  waitFor: text("wait_for").notNull(),
  state: text("state").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, table => [
  index("opencraft_wait_pending").on(table.state, table.expiresAtMs),
  check("opencraft_wait_tickets_check_1", sql.raw("wait_for IN ('all_settled','any_settled')")),
  check("opencraft_wait_tickets_check_2", sql.raw("state IN ('active','satisfied','expired','cancelled')")),
]);

export const executionCapabilityBindings = sqliteTable("execution_capability_bindings", {
  id: text("id").notNull().primaryKey(),
  serverId: text("server_id").notNull(),
  threadId: text("thread_id").notNull(),
  sessionJson: text("session_json"),
}, table => [uniqueIndex("execution_capability_bindings_server_id_thread_id_unique").on(table.serverId, table.threadId)]);

export const actorChannelIdentity = sqliteTable("actor_channel_identity", {
  epoch: text("epoch").notNull(),
});

export const actorChannels = sqliteTable("actor_channels", {
  id: text("id").notNull().primaryKey(),
  ownerId: text("owner_id").notNull(),
  peerId: text("peer_id"),
  title: text("title"),
  createKey: text("create_key"),
  createFingerprint: text("create_fingerprint"),
}, table => [
  uniqueIndex("actor_channels_owner_id_create_key_unique").on(table.ownerId, table.createKey),
  index("actor_channels_peer").on(table.peerId),
]);

// Native group lifecycle, explicit departure fences, and personal list visibility
// are separate facts. Provider bindings never own any of these states.
export const actorChannelLifecycles = sqliteTable("actor_channel_lifecycles", {
  channelId: text("channel_id").notNull().primaryKey().references(() => actorChannels.id),
  revision: integer("revision").notNull().default(1),
  dissolvedAt: integer("dissolved_at"),
  dissolvedBy: text("dissolved_by"),
}, table => [check("actor_channel_lifecycles_revision", sql`${table.revision} >= 1`)]);
export const actorChannelListStates = sqliteTable("actor_channel_list_states", {
  channelId: text("channel_id").notNull().references(() => actorChannels.id),
  actorId: text("actor_id").notNull(),
  hidden: integer("hidden").notNull().default(0),
}, table => [primaryKey({columns:[table.channelId,table.actorId]}), check("actor_channel_list_hidden",sql`${table.hidden} IN (0,1)`)]);
export const actorChannelDepartures = sqliteTable("actor_channel_departures", {
  channelId: text("channel_id").notNull().references(() => actorChannels.id),
  actorId: text("actor_id").notNull(),
  memberEpoch: text("member_epoch").notNull(),
  leftAt: integer("left_at").notNull(),
}, table => [primaryKey({columns:[table.channelId,table.actorId]})]);

export const actorChannelMembers = sqliteTable("actor_channel_members", {
  channelId: text("channel_id").notNull().references(() => actorChannels.id),
  actorId: text("actor_id").notNull(),
  epoch: text("epoch").notNull(),
}, table => [
  primaryKey({ columns: [table.channelId, table.actorId] }),
  index("actor_channel_members_actor").on(table.actorId, table.channelId),
]);

export const actorChannelExecutionMembership = sqliteTable("actor_channel_execution_membership", {
  requestId: text("request_id").notNull().references(() => actorExecutionRequests.id),
  channelId: text("channel_id").notNull().references(() => actorChannels.id),
  requesterEpoch: text("requester_epoch").notNull(),
  targetEpoch: text("target_epoch").notNull(),
}, table => [
  primaryKey({ columns: [table.requestId, table.channelId] }),
]);

export const actorChannelChanges = sqliteTable("actor_channel_changes", {
  revision: integer("revision").primaryKey({ autoIncrement: true }),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull().references(() => actorMessages.id),
}, table => [
  uniqueIndex("actor_channel_changes_message_id_unique").on(table.messageId),
  index("actor_channel_changes_by_channel").on(table.channelId, table.revision),
]);

export const actorInboxClock = sqliteTable("actor_inbox_clock", {
  id: integer("id").primaryKey(), epoch: text("epoch").notNull(), revision: integer("revision").notNull(),
}, table => [check("actor_inbox_clock_singleton", sql`id = 1`)]);
export const actorInboxRows = sqliteTable("actor_inbox_rows", {
  actorId: text("actor_id").notNull(), channelId: text("channel_id").notNull(),
  revision: integer("revision").notNull(), payload: text("payload"),
}, table => [primaryKey({ columns: [table.actorId, table.channelId] }),
  index("actor_inbox_changes").on(table.actorId, table.revision)]);


export const actorChannelReads = sqliteTable('actor_channel_reads', {
 channelId: text('channel_id').notNull(), actorId:text('actor_id').notNull(), epoch:text('epoch').notNull(),
 joinedSeq:integer('joined_seq').notNull(), readSeq:integer('read_seq').notNull(),
},table=>[primaryKey({columns:[table.channelId,table.actorId]})]);

// External transports keep synchronization metadata, never a second timeline.
export const actorChannelSources = sqliteTable("actor_channel_sources", {
  source: text("source").primaryKey(),
  channelId: text("channel_id").notNull().references(() => actorChannels.id),
  epoch: text("epoch").notNull(), incarnation: text("incarnation").notNull(),
  active: integer("active").notNull(), images: integer("images").notNull(),
}, table => [uniqueIndex("actor_channel_sources_channel").on(table.channelId)]);
// Stable installation connection identity is distinct from each running incarnation.
export const actorChannelConnections = sqliteTable("actor_channel_connections", {
  id: text("id").primaryKey(), incarnation: text("incarnation").notNull(), active: integer("active").notNull(),
});
export const actorChannelSourceOwners = sqliteTable("actor_channel_source_owners", {
  source: text("source").primaryKey().references(() => actorChannelSources.source, { onDelete: "cascade" }),
  connectionId: text("connection_id").notNull().references(() => actorChannelConnections.id),
});
export const actorChannelExternalMessages = sqliteTable("actor_channel_external_messages", {
  messageId: text("message_id").primaryKey().references(() => actorMessages.id),
  source: text("source").notNull(), externalId: text("external_id").notNull(),
  senderId: text("sender_id").notNull(), fingerprint: text("fingerprint").notNull(),
}, table => [uniqueIndex("actor_channel_external_identity").on(table.source, table.externalId)]);
export const actorChannelAttachments = sqliteTable("actor_channel_attachments", {
  messageId: text("message_id").primaryKey().references(() => actorMessages.id),
  name: text("name").notNull(), mime: text("mime").notNull(), bytes: blob("bytes", { mode: "buffer" }).notNull(),
});
export const actorChannelImages = sqliteTable("actor_channel_images", {
  messageId: text("message_id").primaryKey().references(() => actorMessages.id),
  source: text("source"), mediaId: text("media_id"), mime: text("mime"), bytes: blob("bytes", { mode: "buffer" }),
  state: text("state").notNull(), attribution: text("attribution"),
});
export const actorChannelOutbox = sqliteTable("actor_channel_outbox", {
  messageId: text("message_id").primaryKey().references(() => actorMessages.id),
  source: text("source").notNull(), sourceEpoch: text("source_epoch").notNull(),
  actorGeneration: integer("actor_generation").notNull(), memberEpoch: text("member_epoch").notNull(),
  credentialId: text("credential_id"), actorExpiresAt: integer("actor_expires_at").notNull(),
  state: text("state").notNull(), attemptId: text("attempt_id"),
}, table => [index("actor_channel_outbox_pending").on(table.state,table.source)]);

/** Existing Bot assignments; exactly one default personal assistant per Human. */
export const personalAssistants = sqliteTable("personal_assistants", {
  botId: text("bot_id").notNull().primaryKey(),
  actorId: text("actor_id").notNull(),
  ownerHumanId: text("owner_human_id").notNull(),
  ownerGeneration: integer("owner_generation").notNull(),
  assignmentId: text("assignment_id").notNull(),
  epoch: text("epoch").notNull(),
  state: text("state").notNull(),
  createdAt: integer("created_at").notNull(),
  credentialId: text("credential_id"),
  isDefault: integer("is_default").notNull().default(1),
  duties: text("duties").notNull().default(""),
  environment: text("environment_json").notNull().default('{"kind":"local"}'),
  configRevision: integer("config_revision").notNull().default(0),
  paused: integer("paused").notNull().default(0),
  createKey: text("create_key"),
  createFingerprint: text("create_fingerprint"),
  modelSelection: text("model_selection"),
  modelRevision: integer("model_revision").notNull().default(0),
}, table => [
  uniqueIndex("personal_assistants_default_owner_unique").on(table.ownerHumanId).where(sql`${table.isDefault}=1`),
  uniqueIndex("personal_assistants_create_key").on(table.ownerHumanId,table.createKey),
  check("personal_assistants_default_boolean", sql.raw("is_default IN (0,1)")),
  check("personal_assistants_paused_boolean", sql.raw("paused IN (0,1)")),
  uniqueIndex("personal_assistants_actor_unique").on(table.actorId),
  foreignKey({ columns: [table.actorId], foreignColumns: [actors.id] }),
  foreignKey({ columns: [table.ownerHumanId], foreignColumns: [actors.id] }),
  check("personal_assistants_state", sql.raw("state IN ('claimed','revoked')")),
]);
export const threadAccess = sqliteTable("thread_access", {
  serverId: text("server_id").notNull(), threadId: text("thread_id").notNull(),
  creatorActorId: text("creator_actor_id"), accessMode: text("access_mode").notNull(),
  revision: integer("revision").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [
  primaryKey({ columns: [table.serverId, table.threadId] }),
  check("thread_access_mode", sql.raw("access_mode IN ('shared','private')")),
  check("thread_access_revision", sql.raw("revision>=1")),
  check("thread_access_creator", sql.raw("access_mode!='private' OR creator_actor_id IS NOT NULL")),
]);
export const threadAccessAudit = sqliteTable("thread_access_audit", {
  id: integer("id").primaryKey(), serverId: text("server_id").notNull(), threadId: text("thread_id").notNull(),
  actorId: text("actor_id").notNull(), accessMode: text("access_mode").notNull(),
  revision: integer("revision").notNull(), at: integer("at").notNull(),
});
export const threadNotes = sqliteTable("thread_notes", {
  serverId: text("server_id").notNull(), threadId: text("thread_id").notNull(),
  state: blob("state", { mode: "buffer" }).notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.serverId, table.threadId] })]);

export const automationGrants = sqliteTable("automation_grants", {
  id: text("id").primaryKey(), serverId: text("server_id").notNull(), projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(), generation: integer("generation").notNull(),
  scopeJson: text("scope_json").notNull(), revokedAt: integer("revoked_at"), createdAt: integer("created_at").notNull(),
});
export const projectAutomations = sqliteTable("project_automations", {
  id: text("id").primaryKey(), grantId: text("grant_id").notNull(), projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(), revision: integer("revision").notNull(), enabled: integer("enabled").notNull(),
  deleted: integer("deleted").notNull().default(0), failures: integer("failures").notNull().default(0), value: text("value").notNull(),
}, table=>[index("project_automations_project").on(table.projectId,table.id)]);
export const automationRuns = sqliteTable("automation_runs", {
  key: text("key").primaryKey(), automationId: text("automation_id").notNull(), revision: integer("revision").notNull(),
  occurrenceId: text("occurrence_id").notNull(), state: text("state").notNull(), at: integer("at").notNull(),
  value: text("value").notNull(),
}, table=>[index("automation_runs_owner").on(table.automationId,table.at),index("automation_runs_state").on(table.state),
  check("automation_run_state",sql.raw("state IN ('planned','admitted','running','completed','failed','unknown','skipped')"))]);
export const automationMutations = sqliteTable("automation_mutations", {
  actorId: text("actor_id").notNull(), key: text("key").notNull(), digest: text("digest").notNull(), result: text("result").notNull(),
},table=>[primaryKey({columns:[table.actorId,table.key]})]);
export const automationDelegations = sqliteTable("automation_delegations", {
  authorityId: text("authority_id").primaryKey(), runKey: text("run_key").notNull(), grantId: text("grant_id").notNull(),
},table=>[index("automation_delegations_run").on(table.runKey)]);

/** Explicit Human grant. The saved native settings are a snapshot, never model input. */
export const assistantThreadProfiles = sqliteTable("assistant_thread_profiles", {
  botId: text("bot_id").notNull().references(() => personalAssistants.botId),
  id: text("id").notNull(), epoch: text("epoch").notNull(), revision: integer("revision").notNull(),
  source: text("source").notNull(), settings: text("settings").notNull(), enabled: integer("enabled").notNull(),
}, t => [primaryKey({columns:[t.botId,t.id]})]);
/** Command receipts; native engine creation and the existing input queue own execution. */
export const assistantThreadOperations = sqliteTable("assistant_thread_operations", {
  id:text("id").primaryKey(),botId:text("bot_id").notNull().references(()=>personalAssistants.botId),
  epoch:text("epoch").notNull(),requestKey:text("request_key").notNull(),fingerprint:text("fingerprint").notNull(),
  command:text("command").notNull(),args:text("args").notNull(),workId:text("work_id"),
  profileId:text("profile_id").notNull(),profileRevision:integer("profile_revision").notNull(),
  state:text("state").notNull(),reference:text("reference"),result:text("result"),createdAt:integer("created_at").notNull(),
},t=>[uniqueIndex("assistant_thread_operation_key").on(t.botId,t.epoch,t.requestKey),index("assistant_thread_owned_page").on(t.botId,t.epoch,t.command,t.id),index("assistant_thread_target").on(t.botId,t.epoch,t.reference,t.command)]);

export const actorHumanReservations = sqliteTable("actor_human_reservations", {
  binding: text("binding").primaryKey().notNull(),
  actorId: text("actor_id").notNull().references(() => actors.id),
  loginProvider: text("login_provider").notNull(),
  alias: text("alias").notNull(),
  createdAt: integer("created_at").notNull(),
  state: text("state").notNull(),
}, table => [index("actor_human_reservations_alias").on(table.loginProvider, table.alias, table.state),
  check("actor_human_reservations_state", sql`state IN ('pending','claimed','revoked')`)]);

export const collaborationSpaces = sqliteTable("collaboration_spaces", {
  id: text("id").primaryKey(), name: text("name").notNull(), ownerActorId: text("owner_actor_id").notNull(),
  createdAt: integer("created_at").notNull(),
  // 1: Humans in this space may message any other member without a per-target grant.
  // Existing rows (including the historical default space) keep the per-grant rule.
  // Written only by ServerSpacesLedger as 0 or 1; a plain column keeps the upgrade an in-place ADD COLUMN.
  openContact: integer("open_contact").notNull().default(0),
});
export const collaborationSpaceMembers = sqliteTable("collaboration_space_members", {
  spaceId: text("space_id").notNull(), actorId: text("actor_id").notNull(), role: text("role").notNull(),
  joinedAt: integer("joined_at").notNull(),
}, table => [primaryKey({columns:[table.spaceId, table.actorId]}),
  foreignKey({columns:[table.spaceId],foreignColumns:[collaborationSpaces.id]}),
  check("collaboration_space_role", sql.raw("role IN ('owner','member')"))]);
export const collaborationSpaceInvitations = sqliteTable("collaboration_space_invitations", {
  digest: text("digest").primaryKey(), spaceId: text("space_id").notNull(), createdBy: text("created_by").notNull(),
  expiresAt: integer("expires_at").notNull(), usedBy: text("used_by"),
}, table => [foreignKey({columns:[table.spaceId],foreignColumns:[collaborationSpaces.id]})]);
export const collaborationSpaceThreads = sqliteTable("collaboration_space_threads", {
  engineServerId: text("engine_server_id").notNull(), threadId: text("thread_id").notNull(), spaceId: text("space_id").notNull(),
}, table => [primaryKey({columns:[table.engineServerId,table.threadId]}),
  foreignKey({columns:[table.spaceId],foreignColumns:[collaborationSpaces.id]})]);
/**
 * One piece of crew work: who it is assigned to, who handed it over, the work it was split from,
 * and its root. Written only by Collaboration's crew work ledger. A root carries the Bot-to-Bot
 * dispatch count for its whole tree. `origin` is 'member' for a member's request, 'bot' for a
 * Bot's dispatch and 'routine' for work a Bot started on its own.
 */
export const crewWork = sqliteTable("crew_work", {
  id: text("id").primaryKey(), spaceId: text("space_id").notNull(), assigneeId: text("assignee_id").notNull(),
  requesterId: text("requester_id").notNull(), parentId: text("parent_id"), rootId: text("root_id").notNull(),
  origin: text("origin").notNull(), messageId: text("message_id"), state: text("state").notNull(),
  dispatches: integer("dispatches").notNull().default(0), createdAt: integer("created_at").notNull(), closedAt: integer("closed_at"),
}, table => [index("crew_work_assignee").on(table.assigneeId, table.state), index("crew_work_root").on(table.rootId),
  check("crew_work_origin", sql.raw("origin IN ('member','bot','routine')")), check("crew_work_state", sql.raw("state IN ('open','closed')"))]);

/** Messages exchanged inside crew work that reach a Bot. A reply is not a new dispatch: it is filed
 * against the recipient's own work, so its runtime can return it to the conversation handling that work. */
export const crewMessages = sqliteTable("crew_messages", {
  seq: integer("seq").primaryKey({ autoIncrement: true }), messageId: text("message_id").notNull().unique(),
  recipientId: text("recipient_id").notNull(), workId: text("work_id").notNull(), fromWorkId: text("from_work_id").notNull(),
  createdAt: integer("created_at").notNull(),
  // 1 when the sender asked the recipient something; 0 for reports and notices. Written only by CrewWork.
  asks: integer("asks").notNull().default(0),
  // The question this message answers; an answer closes it instead of opening new work.
  answers: text("answers"),
}, table => [index("crew_messages_recipient").on(table.recipientId, table.seq)]);

export const conversationCreationReceipts = sqliteTable("conversation_creation_receipts", {
  actorId: text("actor_id").notNull(),
  operationKey: text("operation_key").notNull(),
  serverId: text("server_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  state: text("state").notNull(),
  threadId: text("thread_id"),
  rejectionStatus: integer("rejection_status"),
  rejectionCode: text("rejection_code"),
}, table => [
  primaryKey({ columns: [table.actorId, table.operationKey] }),
  check("creation_receipt_state", sql.raw(`(
    (state = 'claimed' AND thread_id IS NULL) OR
    (state IN ('created', 'submitted', 'first_rejected') AND thread_id IS NOT NULL) OR
    (state = 'rejected' AND thread_id IS NULL)
  ) AND (
    (state = 'rejected' AND rejection_status IS NOT NULL AND rejection_code IS NOT NULL) OR
    (state <> 'rejected' AND rejection_status IS NULL AND rejection_code IS NULL)
  )`)),
]);
