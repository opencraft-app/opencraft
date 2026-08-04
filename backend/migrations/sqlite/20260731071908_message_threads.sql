-- Create "message_thread_reads" table
CREATE TABLE `message_thread_reads` (`id` text NOT NULL, `server_id` text NOT NULL, `thread_id` text NOT NULL, `member_id` text NOT NULL, `last_read_ref_id` text NOT NULL, `last_read_sequence` integer NOT NULL, `last_read_at` datetime NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "messagethreadread_server_id_thread_id_member_id" to table: "message_thread_reads"
CREATE UNIQUE INDEX `messagethreadread_server_id_thread_id_member_id` ON `message_thread_reads` (`server_id`, `thread_id`, `member_id`);
-- Create index "messagethreadread_server_id_member_id_updated_at_id" to table: "message_thread_reads"
CREATE INDEX `messagethreadread_server_id_member_id_updated_at_id` ON `message_thread_reads` (`server_id`, `member_id`, `updated_at`, `id`);
-- Create "message_thread_refs" table
CREATE TABLE `message_thread_refs` (`id` text NOT NULL, `server_id` text NOT NULL, `channel_id` text NOT NULL, `thread_id` text NOT NULL, `role` text NOT NULL, `message_kind` text NOT NULL, `message_id` text NOT NULL, `group_id` text NULL, `topic_id` text NULL, `sender_user_id` text NULL, `message_sequence` integer NOT NULL, `message_timestamp` integer NOT NULL, `created_by_member_id` text NOT NULL, `reply_count` integer NOT NULL, `last_reply_at` datetime NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "messagethreadref_server_id_channel_id_message_id" to table: "message_thread_refs"
CREATE UNIQUE INDEX `messagethreadref_server_id_channel_id_message_id` ON `message_thread_refs` (`server_id`, `channel_id`, `message_id`);
-- Create index "messagethreadref_server_id_thread_id_role_message_sequence_id" to table: "message_thread_refs"
CREATE INDEX `messagethreadref_server_id_thread_id_role_message_sequence_id` ON `message_thread_refs` (`server_id`, `thread_id`, `role`, `message_sequence`, `id`);
-- Create index "messagethreadref_server_id_channel_id_role_last_reply_at_id" to table: "message_thread_refs"
CREATE INDEX `messagethreadref_server_id_channel_id_role_last_reply_at_id` ON `message_thread_refs` (`server_id`, `channel_id`, `role`, `last_reply_at`, `id`);
