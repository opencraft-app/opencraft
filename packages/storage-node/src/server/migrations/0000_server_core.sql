CREATE TABLE `access_audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL,
	`binding` text NOT NULL,
	`action` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `access_imports` (
	`source` text PRIMARY KEY NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `account_invitations` (
	`digest` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`username` text,
	`subject` text NOT NULL,
	`actor_id` text,
	`created_by` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `account_setup` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`mode` text,
	`username` text,
	`subject` text,
	`owner_actor` text,
	CONSTRAINT "account_setup_check_1" CHECK(id=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`operator` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_authority` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	CONSTRAINT "actor_authority_check_1" CHECK(singleton=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_bindings` (
	`binding` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_collaboration_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`detail` text NOT NULL,
	`happened_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`digest` text NOT NULL,
	`generation` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`enabled` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_credentials_check_1" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_deliveries` (
	`message_id` text NOT NULL,
	`receiver_id` text NOT NULL,
	`state` text NOT NULL,
	`received_at` integer NOT NULL,
	`read_at` integer,
	PRIMARY KEY(`message_id`, `receiver_id`),
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_deliveries_check_1" CHECK(state IN ('received','read'))
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_execution_inputs` (
	`request_id` text NOT NULL,
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`request_id`, `message_id`),
	FOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_execution_inputs_request_id_position_unique` ON `actor_execution_inputs` (`request_id`,`position`);--> statement-breakpoint
CREATE TABLE `actor_execution_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`requester_id` text NOT NULL,
	`requester_generation` integer NOT NULL,
	`target_id` text NOT NULL,
	`target_generation` integer NOT NULL,
	`binding_epoch` integer NOT NULL,
	`thread_id` text NOT NULL,
	`mode` text NOT NULL,
	`expected_turn_id` text,
	`state` text NOT NULL,
	`queue_id` text,
	`turn_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`target_kind` text DEFAULT 'actor' NOT NULL,
	`host_id` text DEFAULT 'local-codex',
	`server_id` text,
	`credential_id` text,
	`expires_at` integer,
	CONSTRAINT "actor_execution_requests_check_1" CHECK(mode IN ('queue','steer')),
	CONSTRAINT "actor_execution_requests_check_2" CHECK(state IN ('accepted','transferring','queued','submitted','injected','rejected','cancelled','unknown'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_execution_pending` ON `actor_execution_requests` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `actor_grants` (
	`actor_id` text NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`actor_id`, `resource`, `action`),
	FOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "actor_grants_check_1" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_members` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT "actor_members_check_1" CHECK(role IN ('admin','member')),
	CONSTRAINT "actor_members_check_2" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `actor_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`channel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`target_id` text NOT NULL,
	`content` text NOT NULL,
	`reply_to` text,
	`created_at` integer NOT NULL,
	`target_kind` text DEFAULT 'actor' NOT NULL,
	`server_id` text,
	`source_ref` text,
	`delegation_id` text
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_messages_channel` ON `actor_messages` (`channel_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `actor_messages_seq_unique` ON `actor_messages` (`seq`);--> statement-breakpoint
CREATE TABLE `actor_run_bindings` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`host_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_run_bindings_thread_id_unique` ON `actor_run_bindings` (`thread_id`);--> statement-breakpoint
CREATE TABLE `actor_send_keys` (
	`actor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`message_id` text,
	`request_id` text,
	PRIMARY KEY(`actor_id`, `idempotency_key`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`enabled` integer NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text,
	CONSTRAINT "actors_check_1" CHECK(kind IN ('human','session')),
	CONSTRAINT "actors_check_2" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `capability_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`created_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `capability_bindings_server_id_thread_id_unique` ON `capability_bindings` (`server_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `conversation_authorities` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`input_id` text,
	`actor_id` text NOT NULL,
	`generation` integer NOT NULL,
	`credential_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_authorities_thread_id_input_id_unique` ON `conversation_authorities` (`thread_id`,`input_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_authorities_thread_id_turn_id_unique` ON `conversation_authorities` (`thread_id`,`turn_id`);--> statement-breakpoint
CREATE TABLE `conversation_tool_budget` (
	`authority_id` text PRIMARY KEY NOT NULL,
	`sent` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `conversation_turn_authorities` (
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`authority_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `turn_id`),
	FOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `human_identity_labels` (
	`binding` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `human_logins` (
	`digest` text PRIMARY KEY NOT NULL,
	`principal` text NOT NULL,
	`actor_id` text NOT NULL,
	`generation` integer NOT NULL,
	`account_version` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `human_logins_expiry` ON `human_logins` (`expires_at`);--> statement-breakpoint
CREATE TABLE `local_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`salt` text NOT NULL,
	`password_digest` text NOT NULL,
	`enabled` integer NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "local_accounts_check_1" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `local_accounts_username_unique` ON `local_accounts` (`username`);--> statement-breakpoint
CREATE TABLE `members` (
	`binding` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`enabled` integer NOT NULL,
	CONSTRAINT "members_check_1" CHECK(role IN ('admin','member')),
	CONSTRAINT "members_check_2" CHECK(enabled IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_delegation_roots` (
	`authority_id` text PRIMARY KEY NOT NULL,
	`root_authority_id` text NOT NULL,
	FOREIGN KEY (`root_authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_input_authorities` (
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`authority_id` text NOT NULL,
	PRIMARY KEY(`thread_id`, `input_id`),
	FOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_input_origins` (
	`thread_id` text NOT NULL,
	`input_id` text NOT NULL,
	`origin_json` text NOT NULL,
	PRIMARY KEY(`thread_id`, `input_id`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_notification_authorities` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`authority_id` text NOT NULL,
	FOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `opencraft_parent_notification_batches`(`batch_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_orchestration_acks` (
	`operation_id` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_orchestration_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`tool_call_key` text NOT NULL,
	`idempotency_key` text,
	`fingerprint` text NOT NULL,
	`arguments_json` text NOT NULL,
	`delegation_id` text NOT NULL,
	`issuer_actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`sender_thread_id` text NOT NULL,
	`target_thread_id` text,
	`client_message_id` text,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`waiting_on` text,
	`result_json` text,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`quota_reserved` integer DEFAULT 0 NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_orchestration_pending` ON `opencraft_orchestration_operations` (`state`,`created_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `opencraft_orchestration_operations_client_message_id_unique` ON `opencraft_orchestration_operations` (`client_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `opencraft_orchestration_operations_idempotency_key_unique` ON `opencraft_orchestration_operations` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `opencraft_orchestration_operations_tool_call_key_unique` ON `opencraft_orchestration_operations` (`tool_call_key`);--> statement-breakpoint
CREATE TABLE `opencraft_orchestration_runtime_views` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`root_turn_id` text,
	`turn_id` text,
	`state` text NOT NULL,
	`updated_at_ms` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_orchestration_tool_calls` (
	`tool_call_key` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_parent_notification_batches` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`parent_thread_id` text NOT NULL,
	`child_thread_id` text NOT NULL,
	`child_root_turn_id` text NOT NULL,
	`outcome_kind` text NOT NULL,
	`has_direct_user_input` integer DEFAULT 0 NOT NULL,
	`user_input_excerpt` text,
	`summary_json` text NOT NULL,
	`first_queued_at_ms` integer NOT NULL,
	`deliver_after_ms` integer NOT NULL,
	`max_deadline_ms` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`client_message_id` text
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_parent_notification_due` ON `opencraft_parent_notification_batches` (`state`,`deliver_after_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `opencraft_parent_notification_batches_parent_thread_id_child_thread_id_child_root_turn_id_outcome_kind_unique` ON `opencraft_parent_notification_batches` (`parent_thread_id`,`child_thread_id`,`child_root_turn_id`,`outcome_kind`);--> statement-breakpoint
CREATE TABLE `opencraft_server_imports` (
	`source` text PRIMARY KEY NOT NULL,
	`source_digest` text NOT NULL,
	`migration_history` text NOT NULL,
	`row_counts` text NOT NULL,
	`backup_path` text NOT NULL,
	`imported_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_server_installation` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`product_version` text NOT NULL,
	`contract_hash` text NOT NULL,
	`completed_at` integer NOT NULL,
	CONSTRAINT "opencraft_server_installation_check_1" CHECK(singleton=1)
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_spawn_preparations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`settings_json` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_thread_authorities` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`authority_id` text NOT NULL,
	FOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `opencraft_thread_relations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`driver_kind` text NOT NULL,
	`engine_host_generation` text,
	`native_session_id` text,
	`owner_actor_id` text NOT NULL,
	`parent_thread_id` text,
	`lifecycle_owner_thread_id` text,
	`forked_from_id` text,
	`visibility` text NOT NULL,
	`runtime_status` text NOT NULL,
	`root_turn_id` text,
	`turn_id` text,
	`delegation_revision` integer DEFAULT 0 NOT NULL,
	`auto_exchange_depth` integer DEFAULT 0 NOT NULL,
	`has_direct_user_input` integer DEFAULT 0 NOT NULL,
	`user_input_excerpt` text,
	`updated_at_ms` integer NOT NULL,
	CONSTRAINT "opencraft_thread_relations_check_1" CHECK(visibility IN ('visible','hidden'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_thread_parents` ON `opencraft_thread_relations` (`parent_thread_id`);--> statement-breakpoint
CREATE TABLE `opencraft_wait_tickets` (
	`wait_ticket_id` text PRIMARY KEY NOT NULL,
	`caller_thread_id` text NOT NULL,
	`caller_turn_id` text NOT NULL,
	`target_thread_ids_json` text NOT NULL,
	`wait_for` text NOT NULL,
	`state` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	CONSTRAINT "opencraft_wait_tickets_check_1" CHECK(wait_for IN ('all_settled','any_settled')),
	CONSTRAINT "opencraft_wait_tickets_check_2" CHECK(state IN ('active','satisfied','expired','cancelled'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `opencraft_wait_pending` ON `opencraft_wait_tickets` (`state`,`expires_at_ms`);