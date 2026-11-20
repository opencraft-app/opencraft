CREATE TABLE push_keys (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL) STRICT;
CREATE TABLE push_devices (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, binding_id TEXT NOT NULL, authorization TEXT NOT NULL, subscription TEXT NOT NULL, origin TEXT NOT NULL, base_path TEXT NOT NULL, locale TEXT NOT NULL, messages TEXT NOT NULL) STRICT;
CREATE INDEX push_devices_actor ON push_devices(actor_id);
CREATE TABLE push_watches (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, server_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, input_id TEXT NOT NULL, turn_id TEXT, created_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX push_watches_pending ON push_watches(done,created_at);
CREATE TABLE push_deliveries (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, binding_id TEXT NOT NULL, host_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending') STRICT;
CREATE INDEX push_deliveries_due ON push_deliveries(state,next_at);
