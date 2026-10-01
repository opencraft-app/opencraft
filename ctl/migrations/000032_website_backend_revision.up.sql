-- Apply before code selecting these columns. Existing static rows remain static.
ALTER TABLE website_sites
 ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'static',
 ADD COLUMN active_release_id VARCHAR(64) NOT NULL DEFAULT '',
 ADD COLUMN backend_sha256 VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE website_releases
 ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'static',
 ADD COLUMN backend_sha256 VARCHAR(64) NOT NULL DEFAULT '';
