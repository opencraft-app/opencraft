const SQL = `
CREATE TABLE opencraft_cache_meta(thread_id TEXT PRIMARY KEY,projection_schema_version INTEGER NOT NULL,
 native_watermark TEXT NOT NULL,source_cursor INTEGER NOT NULL,source_identity TEXT NOT NULL,
 source_path TEXT NOT NULL,epoch TEXT NOT NULL,total_turns INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE opencraft_turn_offset_index(thread_id TEXT NOT NULL,turn_seq INTEGER NOT NULL,turn_id TEXT NOT NULL,
 byte_offset INTEGER NOT NULL,byte_length INTEGER NOT NULL,content_sha256 TEXT NOT NULL,status TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(thread_id,turn_seq),UNIQUE(thread_id,turn_id)) STRICT;
CREATE TABLE opencraft_cache_blobs(thread_id TEXT NOT NULL,turn_seq INTEGER NOT NULL,
 blob_sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_seq,blob_sha256)) STRICT;
`;
export const TRANSCRIPT_CACHE_MIGRATIONS = [{ version: 1, name: "disposable-transcript-projection", sql: SQL }];
