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
}, table => [
  index("actor_messages_channel").on(table.channelId, table.seq),
  uniqueIndex("actor_messages_seq_unique").on(table.seq),
]);

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
