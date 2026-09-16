-- Add column "landing_channel_id" to table: "server_invites"
ALTER TABLE `server_invites` ADD COLUMN `landing_channel_id` text NULL;
-- Create "direct_conversations" table
CREATE TABLE `direct_conversations` (`id` text NOT NULL, `server_id` text NOT NULL, `member_a_id` text NOT NULL, `member_b_id` text NOT NULL, `im_group_id` text NOT NULL, `status` text NOT NULL, `im_state` text NOT NULL, `revision` integer NOT NULL, `created_at` datetime NOT NULL, `updated_at` datetime NOT NULL, PRIMARY KEY (`id`));
-- Create index "directconversation_server_id_member_a_id_member_b_id" to table: "direct_conversations"
CREATE UNIQUE INDEX `directconversation_server_id_member_a_id_member_b_id` ON `direct_conversations` (`server_id`, `member_a_id`, `member_b_id`);
-- Create index "directconversation_server_id_im_group_id" to table: "direct_conversations"
CREATE UNIQUE INDEX `directconversation_server_id_im_group_id` ON `direct_conversations` (`server_id`, `im_group_id`);
-- Create index "directconversation_server_id_member_a_id_updated_at_id" to table: "direct_conversations"
CREATE INDEX `directconversation_server_id_member_a_id_updated_at_id` ON `direct_conversations` (`server_id`, `member_a_id`, `updated_at`, `id`);
-- Create index "directconversation_server_id_member_b_id_updated_at_id" to table: "direct_conversations"
CREATE INDEX `directconversation_server_id_member_b_id_updated_at_id` ON `direct_conversations` (`server_id`, `member_b_id`, `updated_at`, `id`);
-- Create index "directconversation_server_id_im_state_id" to table: "direct_conversations"
CREATE INDEX `directconversation_server_id_im_state_id` ON `direct_conversations` (`server_id`, `im_state`, `id`);
