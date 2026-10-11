-- Persist the immutable multi-target release snapshot until first target binding.
ALTER TABLE `computers`
  ADD COLUMN `enrollment_release_set_json` longtext NULL AFTER `enrollment_release_version`;
