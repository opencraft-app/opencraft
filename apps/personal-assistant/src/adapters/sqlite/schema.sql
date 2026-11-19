CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS input(id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT NOT NULL, received_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL, routine_id TEXT, routine_revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS execution(id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work(id), revision INTEGER NOT NULL,
        input_id TEXT NOT NULL, status TEXT NOT NULL, submission_id TEXT, conversation_id TEXT, context_json TEXT, UNIQUE(work_id, revision));
      CREATE TABLE IF NOT EXISTS result(id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, work_id TEXT NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS delivery(id TEXT PRIMARY KEY, result_id TEXT NOT NULL, work_id TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT, accepted_at INTEGER);
      CREATE TABLE IF NOT EXISTS memory(key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, input_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS routine(id TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
        interval_ms INTEGER NOT NULL, next_at INTEGER NOT NULL, expires_at INTEGER, max_runs INTEGER, created_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS occurrence(id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, routine_revision INTEGER NOT NULL,
        scheduled_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, work_id TEXT NOT NULL UNIQUE, UNIQUE(routine_id, routine_revision, scheduled_at));
      CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, work_id TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_pending ON work(status, created_at);
      CREATE INDEX IF NOT EXISTS delivery_pending ON delivery(status, next_at);
