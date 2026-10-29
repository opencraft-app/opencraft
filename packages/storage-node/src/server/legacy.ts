import type { Migration } from "@opencraft/sqlite-node";
import { createMissingLegacyObjects } from "@opencraft/sqlite-node";

// Published owner SQL is immutable, including whitespace and historical names.

const ACTORS_SCHEMA = `
CREATE TABLE actor_authority (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL) STRICT;
CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','session')),
 display_name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL, created_by TEXT) STRICT;
CREATE TABLE actor_bindings (binding TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id)) STRICT;
CREATE TABLE actor_credentials (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES actors(id),
 digest TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE actor_grants (actor_id TEXT NOT NULL REFERENCES actors(id), resource TEXT NOT NULL,
 action TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(actor_id,resource,action)) STRICT;
CREATE TABLE actor_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL,
 actor_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT) STRICT;
`;

const MEMBERSHIPS_BASELINE = `CREATE TABLE members (binding TEXT PRIMARY KEY NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
CREATE TABLE access_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, operator TEXT NOT NULL, binding TEXT NOT NULL, action TEXT NOT NULL) STRICT;
CREATE TABLE access_imports (source TEXT PRIMARY KEY NOT NULL) STRICT;`;

const MEMBERSHIPS_ACTOR_MEMBERSHIPS = `CREATE TABLE actor_members (actor_id TEXT PRIMARY KEY NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;`;

const HUMAN_LOGINS_SCHEMA = `
CREATE TABLE local_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 salt TEXT NOT NULL, password_digest TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), version INTEGER NOT NULL) STRICT;
CREATE TABLE human_logins (digest TEXT PRIMARY KEY, principal TEXT NOT NULL, actor_id TEXT NOT NULL,
 generation INTEGER NOT NULL, account_version INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX human_logins_expiry ON human_logins(expires_at);
CREATE TABLE human_identity_labels (binding TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;
`;

const ACCOUNT_ONBOARDING_SCHEMA = `CREATE TABLE account_setup (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL,
 mode TEXT, username TEXT, subject TEXT, owner_actor TEXT) STRICT;
CREATE TABLE account_invitations (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
 username TEXT, subject TEXT NOT NULL, actor_id TEXT, created_by TEXT NOT NULL) STRICT;`;

const ACTOR_COLLABORATION_SCHEMA = `
CREATE TABLE actor_run_bindings(actor_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE, epoch INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE actor_messages(id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, target_id TEXT NOT NULL, content TEXT NOT NULL, reply_to TEXT, created_at INTEGER NOT NULL) STRICT;
CREATE INDEX actor_messages_channel ON actor_messages(channel_id,seq);
CREATE TABLE actor_deliveries(message_id TEXT NOT NULL REFERENCES actor_messages(id), receiver_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('received','read')), received_at INTEGER NOT NULL, read_at INTEGER, PRIMARY KEY(message_id,receiver_id)) STRICT;
CREATE TABLE actor_execution_requests(id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, requester_generation INTEGER NOT NULL, target_id TEXT NOT NULL, target_generation INTEGER NOT NULL, binding_epoch INTEGER NOT NULL, thread_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('queue','steer')), expected_turn_id TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','transferring','queued','submitted','injected','rejected','cancelled','unknown')), queue_id TEXT, turn_id TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE actor_collaboration_audit(id TEXT PRIMARY KEY, action TEXT NOT NULL, actor_id TEXT NOT NULL, resource_id TEXT NOT NULL, detail TEXT NOT NULL, happened_at INTEGER NOT NULL) STRICT;
CREATE INDEX actor_execution_pending ON actor_execution_requests(state,created_at);
CREATE TABLE actor_execution_inputs(request_id TEXT NOT NULL REFERENCES actor_execution_requests(id), message_id TEXT NOT NULL REFERENCES actor_messages(id), position INTEGER NOT NULL, PRIMARY KEY(request_id,message_id), UNIQUE(request_id,position)) STRICT;
CREATE TABLE actor_send_keys(actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, message_id TEXT, request_id TEXT, PRIMARY KEY(actor_id,idempotency_key)) STRICT;
`;

const ACTOR_COLLABORATION_V2 = `
ALTER TABLE actor_messages ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'actor';
ALTER TABLE actor_messages ADD COLUMN server_id TEXT;
ALTER TABLE actor_messages ADD COLUMN source_ref TEXT;
ALTER TABLE actor_messages ADD COLUMN delegation_id TEXT;
ALTER TABLE actor_execution_requests ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'actor';
ALTER TABLE actor_execution_requests ADD COLUMN host_id TEXT DEFAULT 'local-codex';
ALTER TABLE actor_execution_requests ADD COLUMN server_id TEXT;
ALTER TABLE actor_execution_requests ADD COLUMN credential_id TEXT;
ALTER TABLE actor_execution_requests ADD COLUMN expires_at INTEGER;
CREATE TABLE conversation_authorities(id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, input_id TEXT, actor_id TEXT NOT NULL, generation INTEGER NOT NULL, credential_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(thread_id,turn_id), UNIQUE(thread_id,input_id)) STRICT;
CREATE TABLE conversation_turn_authorities(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,authority_id TEXT NOT NULL REFERENCES conversation_authorities(id),PRIMARY KEY(thread_id,turn_id)) STRICT;
CREATE TABLE conversation_tool_budget(authority_id TEXT PRIMARY KEY, sent INTEGER NOT NULL) STRICT;
`;

const SESSION_CAPABILITIES_SCHEMA = `CREATE TABLE capability_bindings(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,thread_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(server_id,thread_id)) STRICT;`;

export const ORCHESTRATION_SCHEMA = `
CREATE TABLE opencraft_thread_relations (
 thread_id TEXT PRIMARY KEY, server_id TEXT NOT NULL, driver_kind TEXT NOT NULL,
 engine_host_generation TEXT, native_session_id TEXT, owner_actor_id TEXT NOT NULL,
 parent_thread_id TEXT, lifecycle_owner_thread_id TEXT, forked_from_id TEXT,
 visibility TEXT NOT NULL CHECK(visibility IN ('visible','hidden')),
 runtime_status TEXT NOT NULL, root_turn_id TEXT, turn_id TEXT,
 delegation_revision INTEGER NOT NULL DEFAULT 0, auto_exchange_depth INTEGER NOT NULL DEFAULT 0,
 has_direct_user_input INTEGER NOT NULL DEFAULT 0, user_input_excerpt TEXT,
 updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX opencraft_thread_parents ON opencraft_thread_relations(parent_thread_id);
CREATE TABLE opencraft_orchestration_operations (
 operation_id TEXT PRIMARY KEY, tool_call_key TEXT NOT NULL UNIQUE, idempotency_key TEXT UNIQUE,
 fingerprint TEXT NOT NULL, arguments_json TEXT NOT NULL, delegation_id TEXT NOT NULL,
 issuer_actor_id TEXT NOT NULL, kind TEXT NOT NULL, sender_thread_id TEXT NOT NULL,
 target_thread_id TEXT, client_message_id TEXT UNIQUE, mode TEXT NOT NULL,
 state TEXT NOT NULL, waiting_on TEXT, result_json TEXT,
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX opencraft_orchestration_pending ON opencraft_orchestration_operations(state,created_at_ms);
CREATE TABLE opencraft_orchestration_tool_calls (
 tool_call_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES opencraft_orchestration_operations(operation_id)
) STRICT;
CREATE TABLE opencraft_parent_notification_batches (
 batch_id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL,
 child_root_turn_id TEXT NOT NULL, outcome_kind TEXT NOT NULL,
 has_direct_user_input INTEGER NOT NULL DEFAULT 0, user_input_excerpt TEXT,
 summary_json TEXT NOT NULL, first_queued_at_ms INTEGER NOT NULL,
 deliver_after_ms INTEGER NOT NULL, max_deadline_ms INTEGER NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending', client_message_id TEXT,
 UNIQUE(parent_thread_id,child_thread_id,child_root_turn_id,outcome_kind)
) STRICT;
CREATE INDEX opencraft_parent_notification_due ON opencraft_parent_notification_batches(state,deliver_after_ms);
CREATE TABLE opencraft_wait_tickets (
 wait_ticket_id TEXT PRIMARY KEY, caller_thread_id TEXT NOT NULL, caller_turn_id TEXT NOT NULL,
 target_thread_ids_json TEXT NOT NULL, wait_for TEXT NOT NULL CHECK(wait_for IN ('all_settled','any_settled')),
 state TEXT NOT NULL CHECK(state IN ('active','satisfied','expired','cancelled')),
 created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX opencraft_wait_pending ON opencraft_wait_tickets(state,expires_at_ms);
`;

export const ORCHESTRATION_VIEW_SCHEMA = `
CREATE TABLE opencraft_orchestration_runtime_views (
 thread_id TEXT PRIMARY KEY, root_turn_id TEXT, turn_id TEXT, state TEXT NOT NULL,
 updated_at_ms INTEGER NOT NULL
) STRICT;
`;

export const ORCHESTRATION_AUTHORITY_SCHEMA = `
ALTER TABLE opencraft_orchestration_operations ADD COLUMN quota_reserved INTEGER NOT NULL DEFAULT 0;
CREATE TABLE opencraft_orchestration_acks (operation_id TEXT PRIMARY KEY REFERENCES opencraft_orchestration_operations(operation_id)) STRICT;
CREATE TABLE opencraft_notification_authorities (batch_id TEXT PRIMARY KEY REFERENCES opencraft_parent_notification_batches(batch_id),authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)) STRICT;
CREATE TABLE opencraft_spawn_preparations (operation_id TEXT PRIMARY KEY REFERENCES opencraft_orchestration_operations(operation_id), settings_json TEXT NOT NULL) STRICT;
CREATE TABLE opencraft_input_authorities (thread_id TEXT NOT NULL,input_id TEXT NOT NULL,authority_id TEXT NOT NULL REFERENCES conversation_authorities(id),PRIMARY KEY(thread_id,input_id)) STRICT;
CREATE TABLE opencraft_thread_authorities (
 thread_id TEXT PRIMARY KEY, authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)
) STRICT;
CREATE TABLE opencraft_delegation_roots (
 authority_id TEXT PRIMARY KEY REFERENCES conversation_authorities(id), root_authority_id TEXT NOT NULL REFERENCES conversation_authorities(id)
) STRICT;
CREATE TABLE opencraft_input_origins (
 thread_id TEXT NOT NULL, input_id TEXT NOT NULL, origin_json TEXT NOT NULL,
 PRIMARY KEY(thread_id,input_id)
) STRICT;
`;

const EXECUTION_CAPABILITIES_SCHEMA = `CREATE TABLE execution_capability_bindings (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL, thread_id TEXT NOT NULL,
 session_json TEXT, UNIQUE(server_id,thread_id)
) STRICT;`;

export const SERVER_LEGACY_MIGRATIONS = {

  "actors": [
    { version: 1, name: "actor-identities", sql: ACTORS_SCHEMA },
  ],

  "memberships": [
    { version: 1, name: "instance-memberships", sql: MEMBERSHIPS_BASELINE },
    { version: 2, name: "actor-memberships", sql: MEMBERSHIPS_ACTOR_MEMBERSHIPS },
  ],

  "human-logins": [
    { version: 1, name: "human-browser-logins", sql: HUMAN_LOGINS_SCHEMA },
  ],

  "account-onboarding": [
    { version: 1, name: "account-onboarding", sql: ACCOUNT_ONBOARDING_SCHEMA },
  ],

  "actor-collaboration": [
    { version: 1, name: "actor-collaboration", sql: ACTOR_COLLABORATION_SCHEMA },
    { version: 2, name: "conversation-resources", sql: ACTOR_COLLABORATION_V2 },
    { version: 3, name: "thread-orchestration", sql: ORCHESTRATION_SCHEMA },
    { version: 4, name: "thread-orchestration-authority", sql: ORCHESTRATION_AUTHORITY_SCHEMA },
    { version: 5, name: "thread-orchestration-views", sql: ORCHESTRATION_VIEW_SCHEMA },
  ],

  "session-capabilities": [
    { version: 1, name: "session-capability-bindings", sql: SESSION_CAPABILITIES_SCHEMA },
    { version: 2, name: "execution-capability-bindings", sql: EXECUTION_CAPABILITIES_SCHEMA },
  ],

} as const satisfies Record<string, readonly Migration[]>;
export type ServerStoreId = keyof typeof SERVER_LEGACY_MIGRATIONS;

export function serverLegacyOptions(store: ServerStoreId) {
  const migrations = SERVER_LEGACY_MIGRATIONS[store];
  return { migrations, legacyPolicy: store === "memberships" ? "reject-unknown" as const : "reject" as const,
    ...(store === "memberships" ? { legacyMigration: createMissingLegacyObjects(migrations.map(m => m.sql).join("\n")) } : {}) };
}
