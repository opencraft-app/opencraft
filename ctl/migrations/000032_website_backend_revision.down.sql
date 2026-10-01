-- Operational gate: stop all fullstack publishing/invocation and roll sites back
-- to static before running this destructive schema rollback.
ALTER TABLE website_releases DROP COLUMN backend_sha256, DROP COLUMN kind;
ALTER TABLE website_sites DROP COLUMN backend_sha256, DROP COLUMN active_release_id, DROP COLUMN kind;
