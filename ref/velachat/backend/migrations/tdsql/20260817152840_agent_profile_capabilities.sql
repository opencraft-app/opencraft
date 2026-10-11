-- Store the current Profile capability Operation pointer and the latest
-- versioned capability observation on the Agent authority row.
ALTER TABLE `agents`
  ADD COLUMN `profile_capability_refresh_id` varchar(64) NULL AFTER `runtime_model`,
  ADD COLUMN `profile_capabilities_json` longtext NULL AFTER `profile_capability_refresh_id`;
