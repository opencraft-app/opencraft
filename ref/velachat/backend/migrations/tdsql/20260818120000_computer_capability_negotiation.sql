-- Persist the latest assignment/capability protocol explicitly advertised by
-- the installed Computer daemon. Legacy heartbeats resolve to v1 / NULL.
ALTER TABLE `computers`
  ADD COLUMN `assignment_protocol_version` bigint NOT NULL DEFAULT 1 AFTER `daemon_build_id`,
  ADD COLUMN `profile_capability_version` bigint NULL AFTER `assignment_protocol_version`;
