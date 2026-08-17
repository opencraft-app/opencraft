-- Persist the latest assignment/capability protocol explicitly advertised by
-- the installed Computer daemon. Legacy heartbeats resolve to v1 / NULL.
ALTER TABLE `computers` ADD COLUMN `assignment_protocol_version` integer NOT NULL DEFAULT 1;
ALTER TABLE `computers` ADD COLUMN `profile_capability_version` integer NULL;
