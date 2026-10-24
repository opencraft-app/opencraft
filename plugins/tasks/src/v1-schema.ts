/** Additive schema shared by the compatibility release and the V1 writer.
 * Freeze this SQL once deployed: the migration ledger hashes its exact bytes. */
export const tasksV1Schema = `
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'unclassified';
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '';
CREATE TABLE task_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 event_id TEXT NOT NULL UNIQUE,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 type TEXT NOT NULL CHECK(type IN ('created','updated','status_changed','linked','unlinked','deleted','restored','progress')),
 task_revision INTEGER NOT NULL CHECK(task_revision>0),
 actor TEXT,
 channel TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX task_events_by_task ON task_events(task_id,seq DESC);
CREATE INDEX task_progress_by_task ON task_events(task_id,seq DESC) WHERE type='progress';
`;
export const tasksV1Migration = { version: 4, name: "task-kinds-acceptance-and-events", sql: tasksV1Schema };
