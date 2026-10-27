/** Additive migration. Never edit already deployed migration SQL. */
export const tasksArchiveSchema = `
ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
CREATE INDEX tasks_archive_page ON tasks(archived_at DESC,id DESC) WHERE archived_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX tasks_active_order ON tasks(status,sort_order,id) WHERE archived_at IS NULL AND deleted_at IS NULL;
`;
export const tasksArchiveMigration = { version: 5, name: "task-archive", sql: tasksArchiveSchema };
