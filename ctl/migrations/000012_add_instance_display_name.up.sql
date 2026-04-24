ALTER TABLE `instances`
    ADD COLUMN `display_name` VARCHAR(255) NOT NULL DEFAULT '' AFTER `user_id`;
