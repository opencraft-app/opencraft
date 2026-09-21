-- Create "computer_setup_codes" table
CREATE TABLE `computer_setup_codes` (`id` text NOT NULL, `code_hash` text NOT NULL, `server_id` text NOT NULL, `computer_id` text NOT NULL, `generation` integer NOT NULL, `expires_at` datetime NOT NULL, `created_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "computersetupcode_code_hash" to table: "computer_setup_codes"
CREATE UNIQUE INDEX `computersetupcode_code_hash` ON `computer_setup_codes` (`code_hash`);
-- Create index "computersetupcode_code_hash_expires_at_id" to table: "computer_setup_codes"
CREATE INDEX `computersetupcode_code_hash_expires_at_id` ON `computer_setup_codes` (`code_hash`, `expires_at`, `id`);
