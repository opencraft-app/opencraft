// Exact deployed SQL, frozen before migration registry adoption. Never derive
// upgrade fixtures from the latest generated schema or rewrite these bytes.
export const publishedPushHistory=[
  {
    "version": 1,
    "name": "web-push-subscriptions-and-outbox",
    "sql": "CREATE TABLE push_keys (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;\nCREATE TABLE push_devices (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, binding_id TEXT NOT NULL, authorization TEXT NOT NULL, subscription TEXT NOT NULL, origin TEXT NOT NULL, base_path TEXT NOT NULL, locale TEXT NOT NULL, messages TEXT NOT NULL) STRICT;\nCREATE INDEX push_devices_actor ON push_devices(actor_id);\nCREATE TABLE push_watches (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, server_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0) STRICT;\nCREATE INDEX push_watches_pending ON push_watches(done,created_at);\nCREATE TABLE push_deliveries (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending') STRICT;\nCREATE INDEX push_deliveries_due ON push_deliveries(state,next_at);"
  },
  {
    "version": 2,
    "name": "notification-destinations",
    "sql": "ALTER TABLE push_devices ADD COLUMN target TEXT;\nALTER TABLE push_devices ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;\nCREATE TABLE push_preferences (actor_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL) STRICT;"
  },
  {
    "version": 3,
    "name": "notification-default-decisions",
    "sql": "ALTER TABLE push_preferences ADD COLUMN defaults_blocked INTEGER NOT NULL DEFAULT 0;\nUPDATE push_preferences SET defaults_blocked=1 WHERE enabled=0;\nCREATE TABLE push_default_decisions (actor_id TEXT NOT NULL, policy_id TEXT NOT NULL, PRIMARY KEY(actor_id,policy_id)) STRICT;\nCREATE TABLE push_target_opt_outs (actor_id TEXT NOT NULL, target_key TEXT NOT NULL, PRIMARY KEY(actor_id,target_key)) STRICT;"
  }
] as const;
