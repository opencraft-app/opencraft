-- Persist the immutable multi-target release snapshot until first target binding.
ALTER TABLE `computers` ADD COLUMN `enrollment_release_set_json` text NULL;
