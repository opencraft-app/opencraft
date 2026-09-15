-- Add deterministic landing context to Server join links.
ALTER TABLE `server_invites`
  ADD COLUMN `landing_channel_id` varchar(64) NULL AFTER `used_count`;

-- Map one canonical Server-scoped member pair to one Tencent Work group.
CREATE TABLE `direct_conversations` (
  `id` varchar(64) NOT NULL,
  `server_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `member_a_id` varchar(64) NOT NULL,
  `member_b_id` varchar(64) NOT NULL,
  `im_group_id` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL,
  `im_state` varchar(32) NOT NULL,
  `revision` bigint NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`server_id`, `id`),
  UNIQUE INDEX `directconversation_server_id_member_a_id_member_b_id` (`server_id`, `member_a_id`, `member_b_id`),
  UNIQUE INDEX `directconversation_server_id_im_group_id` (`server_id`, `im_group_id`),
  INDEX `directconversation_server_id_member_a_id_updated_at_id` (`server_id`, `member_a_id`, `updated_at`, `id`),
  INDEX `directconversation_server_id_member_b_id_updated_at_id` (`server_id`, `member_b_id`, `updated_at`, `id`),
  INDEX `directconversation_server_id_im_state_id` (`server_id`, `im_state`, `id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`server_id`;
