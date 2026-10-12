-- LightVela Bot 的独立 IM 身份，归属开通它的 LightVela 账号。
CREATE TABLE `bot_agents` (
  `id` varchar(64) NOT NULL,
  `account_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `instance_id` varchar(128) NOT NULL,
  `bot_id` varchar(128) NOT NULL,
  `display_name` varchar(64) NOT NULL,
  `im_user_id` varchar(32) NOT NULL,
  `state` varchar(32) NOT NULL,
  `last_error_code` varchar(64) NULL,
  `command_policy` varchar(32) NOT NULL,
  `credential_version` bigint NOT NULL,
  `credential_digest` binary(32) NULL,
  `revision` bigint NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`account_id`, `id`),
  UNIQUE INDEX `botagent_account_id_instance_id_bot_id` (`account_id`, `instance_id`, `bot_id`),
  INDEX `botagent_account_id_state_id` (`account_id`, `state`, `id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`account_id`;

-- 平台群；tencent_group_id 由 id 派生，回调反解后按 id 点查。
CREATE TABLE `im_groups` (
  `id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `tencent_group_id` varchar(48) NOT NULL,
  `owner_account_id` varchar(64) NOT NULL,
  `created_by_im_user_id` varchar(32) NOT NULL,
  `name` varchar(100) NOT NULL,
  `reply_mode` varchar(32) NOT NULL,
  `state` varchar(32) NOT NULL,
  `revision` bigint NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`id`;

-- 平台群成员的权威事实，与所属群同分片。
CREATE TABLE `im_group_members` (
  `id` varchar(64) NOT NULL,
  `group_id` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `im_user_id` varchar(32) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `role` varchar(16) NOT NULL,
  `state` varchar(32) NOT NULL,
  `added_by_im_user_id` varchar(32) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`group_id`, `id`),
  UNIQUE INDEX `imgroupmember_group_id_im_user_id` (`group_id`, `im_user_id`),
  INDEX `imgroupmember_group_id_state_id` (`group_id`, `state`, `id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`group_id`;

-- 腾讯 IM UserID 到账号或 Bot 的路由，同时承载封禁标记。
CREATE TABLE `im_identity_routes` (
  `id` varchar(64) NOT NULL,
  `im_user_id` varchar(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `kind` varchar(16) NOT NULL,
  `account_id` varchar(64) NOT NULL,
  `bot_agent_id` varchar(64) NULL,
  `restricted_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`im_user_id`, `id`),
  UNIQUE INDEX `imidentityroute_im_user_id` (`im_user_id`)
) CHARSET utf8mb4 COLLATE utf8mb4_bin shardkey=`im_user_id`;
