// Generated from reviewed SQL. Run npm run generate:storage.
export const SERVER_MIGRATIONS = [
  {
    "version": 1,
    "name": "0000_server_core",
    "sql": "CREATE TABLE `access_audit` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`at` integer NOT NULL,\n\t`operator` text NOT NULL,\n\t`binding` text NOT NULL,\n\t`action` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `access_imports` (\n\t`source` text PRIMARY KEY NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `account_invitations` (\n\t`digest` text PRIMARY KEY NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`state` text NOT NULL,\n\t`username` text,\n\t`subject` text NOT NULL,\n\t`actor_id` text,\n\t`created_by` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `account_setup` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`state` text NOT NULL,\n\t`mode` text,\n\t`username` text,\n\t`subject` text,\n\t`owner_actor` text,\n\tCONSTRAINT \"account_setup_check_1\" CHECK(id=1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_audit` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`at` integer NOT NULL,\n\t`operator` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`action` text NOT NULL,\n\t`resource` text\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_authority` (\n\t`singleton` integer PRIMARY KEY NOT NULL,\n\t`id` text NOT NULL,\n\tCONSTRAINT \"actor_authority_check_1\" CHECK(singleton=1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_bindings` (\n\t`binding` text PRIMARY KEY NOT NULL,\n\t`actor_id` text NOT NULL,\n\tFOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_collaboration_audit` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`action` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`resource_id` text NOT NULL,\n\t`detail` text NOT NULL,\n\t`happened_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_credentials` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`digest` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`enabled` integer NOT NULL,\n\tFOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_credentials_check_1\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_deliveries` (\n\t`message_id` text NOT NULL,\n\t`receiver_id` text NOT NULL,\n\t`state` text NOT NULL,\n\t`received_at` integer NOT NULL,\n\t`read_at` integer,\n\tPRIMARY KEY(`message_id`, `receiver_id`),\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_deliveries_check_1\" CHECK(state IN ('received','read'))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_execution_inputs` (\n\t`request_id` text NOT NULL,\n\t`message_id` text NOT NULL,\n\t`position` integer NOT NULL,\n\tPRIMARY KEY(`request_id`, `message_id`),\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_execution_inputs_request_id_position_unique` ON `actor_execution_inputs` (`request_id`,`position`);--> statement-breakpoint\nCREATE TABLE `actor_execution_requests` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`requester_id` text NOT NULL,\n\t`requester_generation` integer NOT NULL,\n\t`target_id` text NOT NULL,\n\t`target_generation` integer NOT NULL,\n\t`binding_epoch` integer NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`mode` text NOT NULL,\n\t`expected_turn_id` text,\n\t`state` text NOT NULL,\n\t`queue_id` text,\n\t`turn_id` text,\n\t`reason` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`target_kind` text DEFAULT 'actor' NOT NULL,\n\t`host_id` text DEFAULT 'local-codex',\n\t`server_id` text,\n\t`credential_id` text,\n\t`expires_at` integer,\n\tCONSTRAINT \"actor_execution_requests_check_1\" CHECK(mode IN ('queue','steer')),\n\tCONSTRAINT \"actor_execution_requests_check_2\" CHECK(state IN ('accepted','transferring','queued','submitted','injected','rejected','cancelled','unknown'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_execution_pending` ON `actor_execution_requests` (`state`,`created_at`);--> statement-breakpoint\nCREATE TABLE `actor_grants` (\n\t`actor_id` text NOT NULL,\n\t`resource` text NOT NULL,\n\t`action` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\tPRIMARY KEY(`actor_id`, `resource`, `action`),\n\tFOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_grants_check_1\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_members` (\n\t`actor_id` text PRIMARY KEY NOT NULL,\n\t`role` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\tCONSTRAINT \"actor_members_check_1\" CHECK(role IN ('admin','member')),\n\tCONSTRAINT \"actor_members_check_2\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`seq` integer NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`author_id` text NOT NULL,\n\t`target_id` text NOT NULL,\n\t`content` text NOT NULL,\n\t`reply_to` text,\n\t`created_at` integer NOT NULL,\n\t`target_kind` text DEFAULT 'actor' NOT NULL,\n\t`server_id` text,\n\t`source_ref` text,\n\t`delegation_id` text\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_messages_channel` ON `actor_messages` (`channel_id`,`seq`);--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_messages_seq_unique` ON `actor_messages` (`seq`);--> statement-breakpoint\nCREATE TABLE `actor_run_bindings` (\n\t`actor_id` text PRIMARY KEY NOT NULL,\n\t`host_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`epoch` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_run_bindings_thread_id_unique` ON `actor_run_bindings` (`thread_id`);--> statement-breakpoint\nCREATE TABLE `actor_send_keys` (\n\t`actor_id` text NOT NULL,\n\t`idempotency_key` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`message_id` text,\n\t`request_id` text,\n\tPRIMARY KEY(`actor_id`, `idempotency_key`)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actors` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`kind` text NOT NULL,\n\t`display_name` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\t`generation` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`created_by` text,\n\tCONSTRAINT \"actors_check_1\" CHECK(kind IN ('human','session')),\n\tCONSTRAINT \"actors_check_2\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `capability_bindings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`created_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `capability_bindings_server_id_thread_id_unique` ON `capability_bindings` (`server_id`,`thread_id`);--> statement-breakpoint\nCREATE TABLE `conversation_authorities` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`turn_id` text,\n\t`input_id` text,\n\t`actor_id` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`credential_id` text,\n\t`expires_at` integer NOT NULL,\n\t`created_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `conversation_authorities_thread_id_input_id_unique` ON `conversation_authorities` (`thread_id`,`input_id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `conversation_authorities_thread_id_turn_id_unique` ON `conversation_authorities` (`thread_id`,`turn_id`);--> statement-breakpoint\nCREATE TABLE `conversation_tool_budget` (\n\t`authority_id` text PRIMARY KEY NOT NULL,\n\t`sent` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `conversation_turn_authorities` (\n\t`thread_id` text NOT NULL,\n\t`turn_id` text NOT NULL,\n\t`authority_id` text NOT NULL,\n\tPRIMARY KEY(`thread_id`, `turn_id`),\n\tFOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `human_identity_labels` (\n\t`binding` text PRIMARY KEY NOT NULL,\n\t`label` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `human_logins` (\n\t`digest` text PRIMARY KEY NOT NULL,\n\t`principal` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`account_version` integer,\n\t`created_at` integer NOT NULL,\n\t`expires_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `human_logins_expiry` ON `human_logins` (`expires_at`);--> statement-breakpoint\nCREATE TABLE `local_accounts` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`username` text NOT NULL,\n\t`display_name` text NOT NULL,\n\t`salt` text NOT NULL,\n\t`password_digest` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\t`version` integer NOT NULL,\n\tCONSTRAINT \"local_accounts_check_1\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `local_accounts_username_unique` ON `local_accounts` (`username`);--> statement-breakpoint\nCREATE TABLE `members` (\n\t`binding` text PRIMARY KEY NOT NULL,\n\t`role` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\tCONSTRAINT \"members_check_1\" CHECK(role IN ('admin','member')),\n\tCONSTRAINT \"members_check_2\" CHECK(enabled IN (0,1))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_delegation_roots` (\n\t`authority_id` text PRIMARY KEY NOT NULL,\n\t`root_authority_id` text NOT NULL,\n\tFOREIGN KEY (`root_authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_input_authorities` (\n\t`thread_id` text NOT NULL,\n\t`input_id` text NOT NULL,\n\t`authority_id` text NOT NULL,\n\tPRIMARY KEY(`thread_id`, `input_id`),\n\tFOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_input_origins` (\n\t`thread_id` text NOT NULL,\n\t`input_id` text NOT NULL,\n\t`origin_json` text NOT NULL,\n\tPRIMARY KEY(`thread_id`, `input_id`)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_notification_authorities` (\n\t`batch_id` text PRIMARY KEY NOT NULL,\n\t`authority_id` text NOT NULL,\n\tFOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`batch_id`) REFERENCES `opencraft_parent_notification_batches`(`batch_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_orchestration_acks` (\n\t`operation_id` text PRIMARY KEY NOT NULL,\n\tFOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_orchestration_operations` (\n\t`operation_id` text PRIMARY KEY NOT NULL,\n\t`tool_call_key` text NOT NULL,\n\t`idempotency_key` text,\n\t`fingerprint` text NOT NULL,\n\t`arguments_json` text NOT NULL,\n\t`delegation_id` text NOT NULL,\n\t`issuer_actor_id` text NOT NULL,\n\t`kind` text NOT NULL,\n\t`sender_thread_id` text NOT NULL,\n\t`target_thread_id` text,\n\t`client_message_id` text,\n\t`mode` text NOT NULL,\n\t`state` text NOT NULL,\n\t`waiting_on` text,\n\t`result_json` text,\n\t`created_at_ms` integer NOT NULL,\n\t`updated_at_ms` integer NOT NULL,\n\t`quota_reserved` integer DEFAULT 0 NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `opencraft_orchestration_pending` ON `opencraft_orchestration_operations` (`state`,`created_at_ms`);--> statement-breakpoint\nCREATE UNIQUE INDEX `opencraft_orchestration_operations_client_message_id_unique` ON `opencraft_orchestration_operations` (`client_message_id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `opencraft_orchestration_operations_idempotency_key_unique` ON `opencraft_orchestration_operations` (`idempotency_key`);--> statement-breakpoint\nCREATE UNIQUE INDEX `opencraft_orchestration_operations_tool_call_key_unique` ON `opencraft_orchestration_operations` (`tool_call_key`);--> statement-breakpoint\nCREATE TABLE `opencraft_orchestration_runtime_views` (\n\t`thread_id` text PRIMARY KEY NOT NULL,\n\t`root_turn_id` text,\n\t`turn_id` text,\n\t`state` text NOT NULL,\n\t`updated_at_ms` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_orchestration_tool_calls` (\n\t`tool_call_key` text PRIMARY KEY NOT NULL,\n\t`operation_id` text NOT NULL,\n\tFOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_parent_notification_batches` (\n\t`batch_id` text PRIMARY KEY NOT NULL,\n\t`parent_thread_id` text NOT NULL,\n\t`child_thread_id` text NOT NULL,\n\t`child_root_turn_id` text NOT NULL,\n\t`outcome_kind` text NOT NULL,\n\t`has_direct_user_input` integer DEFAULT 0 NOT NULL,\n\t`user_input_excerpt` text,\n\t`summary_json` text NOT NULL,\n\t`first_queued_at_ms` integer NOT NULL,\n\t`deliver_after_ms` integer NOT NULL,\n\t`max_deadline_ms` integer NOT NULL,\n\t`state` text DEFAULT 'pending' NOT NULL,\n\t`client_message_id` text\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `opencraft_parent_notification_due` ON `opencraft_parent_notification_batches` (`state`,`deliver_after_ms`);--> statement-breakpoint\nCREATE UNIQUE INDEX `opencraft_parent_notification_batches_parent_thread_id_child_thread_id_child_root_turn_id_outcome_kind_unique` ON `opencraft_parent_notification_batches` (`parent_thread_id`,`child_thread_id`,`child_root_turn_id`,`outcome_kind`);--> statement-breakpoint\nCREATE TABLE `opencraft_server_imports` (\n\t`source` text PRIMARY KEY NOT NULL,\n\t`source_digest` text NOT NULL,\n\t`migration_history` text NOT NULL,\n\t`row_counts` text NOT NULL,\n\t`backup_path` text NOT NULL,\n\t`imported_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_server_installation` (\n\t`singleton` integer PRIMARY KEY NOT NULL,\n\t`product_version` text NOT NULL,\n\t`contract_hash` text NOT NULL,\n\t`completed_at` integer NOT NULL,\n\tCONSTRAINT \"opencraft_server_installation_check_1\" CHECK(singleton=1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_spawn_preparations` (\n\t`operation_id` text PRIMARY KEY NOT NULL,\n\t`settings_json` text NOT NULL,\n\tFOREIGN KEY (`operation_id`) REFERENCES `opencraft_orchestration_operations`(`operation_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_thread_authorities` (\n\t`thread_id` text PRIMARY KEY NOT NULL,\n\t`authority_id` text NOT NULL,\n\tFOREIGN KEY (`authority_id`) REFERENCES `conversation_authorities`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `opencraft_thread_relations` (\n\t`thread_id` text PRIMARY KEY NOT NULL,\n\t`server_id` text NOT NULL,\n\t`driver_kind` text NOT NULL,\n\t`engine_host_generation` text,\n\t`native_session_id` text,\n\t`owner_actor_id` text NOT NULL,\n\t`parent_thread_id` text,\n\t`lifecycle_owner_thread_id` text,\n\t`forked_from_id` text,\n\t`visibility` text NOT NULL,\n\t`runtime_status` text NOT NULL,\n\t`root_turn_id` text,\n\t`turn_id` text,\n\t`delegation_revision` integer DEFAULT 0 NOT NULL,\n\t`auto_exchange_depth` integer DEFAULT 0 NOT NULL,\n\t`has_direct_user_input` integer DEFAULT 0 NOT NULL,\n\t`user_input_excerpt` text,\n\t`updated_at_ms` integer NOT NULL,\n\tCONSTRAINT \"opencraft_thread_relations_check_1\" CHECK(visibility IN ('visible','hidden'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `opencraft_thread_parents` ON `opencraft_thread_relations` (`parent_thread_id`);--> statement-breakpoint\nCREATE TABLE `opencraft_wait_tickets` (\n\t`wait_ticket_id` text PRIMARY KEY NOT NULL,\n\t`caller_thread_id` text NOT NULL,\n\t`caller_turn_id` text NOT NULL,\n\t`target_thread_ids_json` text NOT NULL,\n\t`wait_for` text NOT NULL,\n\t`state` text NOT NULL,\n\t`created_at_ms` integer NOT NULL,\n\t`expires_at_ms` integer NOT NULL,\n\tCONSTRAINT \"opencraft_wait_tickets_check_1\" CHECK(wait_for IN ('all_settled','any_settled')),\n\tCONSTRAINT \"opencraft_wait_tickets_check_2\" CHECK(state IN ('active','satisfied','expired','cancelled'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `opencraft_wait_pending` ON `opencraft_wait_tickets` (`state`,`expires_at_ms`);"
  },
  {
    "version": 2,
    "name": "0001_execution_capability_bindings",
    "sql": "CREATE TABLE `execution_capability_bindings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`session_json` text\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `execution_capability_bindings_server_id_thread_id_unique` ON `execution_capability_bindings` (`server_id`,`thread_id`);"
  },
  {
    "version": 3,
    "name": "0002_thread_access_and_notes",
    "sql": "CREATE TABLE `thread_access` (\n\t`server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`creator_actor_id` text,\n\t`access_mode` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tPRIMARY KEY(`server_id`, `thread_id`),\n\tCONSTRAINT \"thread_access_mode\" CHECK(access_mode IN ('shared','private')),\n\tCONSTRAINT \"thread_access_revision\" CHECK(revision>=1),\n\tCONSTRAINT \"thread_access_creator\" CHECK(access_mode!='private' OR creator_actor_id IS NOT NULL)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `thread_access_audit` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`access_mode` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `thread_notes` (\n\t`server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`state` blob NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tPRIMARY KEY(`server_id`, `thread_id`)\n) STRICT;\n"
  },
  {
    "version": 4,
    "name": "0003_project_automations",
    "sql": "CREATE TABLE `automation_delegations` (\n\t`authority_id` text PRIMARY KEY NOT NULL,\n\t`run_key` text NOT NULL,\n\t`grant_id` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `automation_delegations_run` ON `automation_delegations` (`run_key`);--> statement-breakpoint\nCREATE TABLE `automation_grants` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`server_id` text NOT NULL,\n\t`project_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`scope_json` text NOT NULL,\n\t`revoked_at` integer,\n\t`created_at` integer NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `automation_mutations` (\n\t`actor_id` text NOT NULL,\n\t`key` text NOT NULL,\n\t`digest` text NOT NULL,\n\t`result` text NOT NULL,\n\tPRIMARY KEY(`actor_id`, `key`)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `automation_runs` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`automation_id` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`occurrence_id` text NOT NULL,\n\t`state` text NOT NULL,\n\t`at` integer NOT NULL,\n\t`value` text NOT NULL,\n\tCONSTRAINT \"automation_run_state\" CHECK(state IN ('planned','admitted','running','completed','failed','unknown','skipped'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `automation_runs_owner` ON `automation_runs` (`automation_id`,`at`);--> statement-breakpoint\nCREATE INDEX `automation_runs_state` ON `automation_runs` (`state`);--> statement-breakpoint\nCREATE TABLE `project_automations` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`grant_id` text NOT NULL,\n\t`project_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`enabled` integer NOT NULL,\n\t`deleted` integer DEFAULT 0 NOT NULL,\n\t`failures` integer DEFAULT 0 NOT NULL,\n\t`value` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `project_automations_project` ON `project_automations` (`project_id`,`id`);"
  },
  {
    "version": 5,
    "name": "0004_magenta_aqueduct",
    "sql": "CREATE TABLE `collaboration_space_invitations` (\n\t`digest` text PRIMARY KEY NOT NULL,\n\t`space_id` text NOT NULL,\n\t`created_by` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`used_by` text,\n\tFOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `collaboration_space_members` (\n\t`space_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`role` text NOT NULL,\n\t`joined_at` integer NOT NULL,\n\tPRIMARY KEY(`space_id`, `actor_id`),\n\tFOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"collaboration_space_role\" CHECK(role IN ('owner','member'))\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `collaboration_space_threads` (\n\t`engine_server_id` text NOT NULL,\n\t`thread_id` text NOT NULL,\n\t`space_id` text NOT NULL,\n\tPRIMARY KEY(`engine_server_id`, `thread_id`),\n\tFOREIGN KEY (`space_id`) REFERENCES `collaboration_spaces`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `collaboration_spaces` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`owner_actor_id` text NOT NULL,\n\t`created_at` integer NOT NULL\n) STRICT;\n"
  },
  {
    "version": 6,
    "name": "0005_native_channels",
    "sql": "CREATE TABLE `actor_channel_changes` (\n\t`revision` integer PRIMARY KEY AUTOINCREMENT NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`message_id` text NOT NULL,\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_channel_changes_message_id_unique` ON `actor_channel_changes` (`message_id`);--> statement-breakpoint\nCREATE INDEX `actor_channel_changes_by_channel` ON `actor_channel_changes` (`channel_id`,`revision`);--> statement-breakpoint\nCREATE TABLE `actor_channel_execution_membership` (\n\t`request_id` text NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`requester_epoch` text NOT NULL,\n\t`target_epoch` text NOT NULL,\n\tPRIMARY KEY(`request_id`, `channel_id`),\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_channel_identity` (\n\t`epoch` text NOT NULL\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_channel_members` (\n\t`channel_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\tPRIMARY KEY(`channel_id`, `actor_id`),\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_channel_members_actor` ON `actor_channel_members` (`actor_id`,`channel_id`);--> statement-breakpoint\nCREATE TABLE `actor_channels` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`owner_id` text NOT NULL,\n\t`peer_id` text,\n\t`title` text,\n\t`create_key` text,\n\t`create_fingerprint` text\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_channels_owner_id_create_key_unique` ON `actor_channels` (`owner_id`,`create_key`);--> statement-breakpoint\nCREATE INDEX `actor_channels_peer` ON `actor_channels` (`peer_id`);--> statement-breakpoint\nALTER TABLE `actor_messages` ADD `author_display_name` text;\n--> statement-breakpoint\nINSERT INTO actor_channel_identity VALUES(lower(hex(randomblob(16))));\n--> statement-breakpoint\nINSERT INTO actor_channels(id,owner_id,peer_id)\n  SELECT DISTINCT channel_id,min(author_id,target_id),max(author_id,target_id)\n  FROM actor_messages WHERE target_kind='actor';\n--> statement-breakpoint\nINSERT INTO actor_channel_changes(channel_id,message_id)\n  SELECT channel_id,id FROM actor_messages WHERE target_kind='actor' ORDER BY seq;\nCREATE TRIGGER actor_channel_message_inserted AFTER INSERT ON actor_messages\n  WHEN new.target_kind IN ('actor','channel') BEGIN\n    INSERT INTO actor_channel_changes(channel_id,message_id) VALUES(new.channel_id,new.id);\nEND;\nCREATE TRIGGER actor_channel_request_linked AFTER INSERT ON actor_execution_inputs BEGIN\n    INSERT OR REPLACE INTO actor_channel_changes(channel_id,message_id)\n      SELECT channel_id,id FROM actor_messages WHERE id=new.message_id AND target_kind IN ('actor','channel');\nEND;\n"
  },
  {
    "version": 7,
    "name": "0006_actor_inbox",
    "sql": "CREATE TABLE `actor_channel_reads` (\n\t`channel_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`joined_seq` integer NOT NULL,\n\t`read_seq` integer NOT NULL,\n\tPRIMARY KEY(`channel_id`, `actor_id`)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_inbox_clock` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`epoch` text NOT NULL,\n\t`revision` integer NOT NULL,\n\tCONSTRAINT \"actor_inbox_clock_singleton\" CHECK(id = 1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_inbox_rows` (\n\t`actor_id` text NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`payload` text,\n\tPRIMARY KEY(`actor_id`, `channel_id`)\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_inbox_changes` ON `actor_inbox_rows` (`actor_id`,`revision`);"
  },
  {
    "version": 8,
    "name": "0007_native_channel_sync",
    "sql": "CREATE TABLE `actor_channel_external_messages` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`source` text NOT NULL,\n\t`external_id` text NOT NULL,\n\t`sender_id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_channel_external_identity` ON `actor_channel_external_messages` (`source`,`external_id`);--> statement-breakpoint\nCREATE TABLE `actor_channel_images` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`source` text,\n\t`media_id` text,\n\t`mime` text,\n\t`bytes` blob,\n\t`state` text NOT NULL,\n\t`attribution` text,\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_channel_outbox` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`source` text NOT NULL,\n\t`source_epoch` text NOT NULL,\n\t`actor_generation` integer NOT NULL,\n\t`member_epoch` text NOT NULL,\n\t`credential_id` text,\n\t`actor_expires_at` integer NOT NULL,\n\t`state` text NOT NULL,\n\t`attempt_id` text,\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_channel_outbox_pending` ON `actor_channel_outbox` (`state`,`source`);--> statement-breakpoint\nCREATE TABLE `actor_channel_sources` (\n\t`source` text PRIMARY KEY NOT NULL,\n\t`channel_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`incarnation` text NOT NULL,\n\t`active` integer NOT NULL,\n\t`images` integer NOT NULL,\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_channel_sources_channel` ON `actor_channel_sources` (`channel_id`);"
  },
  {
    "version": 9,
    "name": "0008_personal_assistants",
    "sql": "CREATE TABLE `personal_assistants` (\n\t`bot_id` text PRIMARY KEY NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`owner_human_id` text NOT NULL,\n\t`owner_generation` integer NOT NULL,\n\t`assignment_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`state` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`actor_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`owner_human_id`) REFERENCES `actors`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"personal_assistants_state\" CHECK(state IN ('claimed','revoked'))\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `personal_assistants_owner_unique` ON `personal_assistants` (`owner_human_id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `personal_assistants_actor_unique` ON `personal_assistants` (`actor_id`);"
  },
  {
    "version": 10,
    "name": "0009_personal_assistant_credentials",
    "sql": "ALTER TABLE `personal_assistants` ADD `credential_id` text;"
  },
  {
    "version": 11,
    "name": "0010_assistant_model_selection",
    "sql": "ALTER TABLE `personal_assistants` ADD `model_selection` text;--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `model_revision` integer DEFAULT 0 NOT NULL;"
  },
  {
    "version": 12,
    "name": "0011_eminent_mathemanic",
    "sql": "CREATE TABLE `assistant_thread_operations` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`bot_id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`request_key` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`command` text NOT NULL,\n\t`args` text NOT NULL,\n\t`work_id` text,\n\t`profile_id` text NOT NULL,\n\t`profile_revision` integer NOT NULL,\n\t`state` text NOT NULL,\n\t`reference` text,\n\t`result` text,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `assistant_thread_operation_key` ON `assistant_thread_operations` (`bot_id`,`epoch`,`request_key`);--> statement-breakpoint\nCREATE TABLE `assistant_thread_profiles` (\n\t`bot_id` text NOT NULL,\n\t`id` text NOT NULL,\n\t`epoch` text NOT NULL,\n\t`revision` integer NOT NULL,\n\t`source` text NOT NULL,\n\t`settings` text NOT NULL,\n\t`enabled` integer NOT NULL,\n\tPRIMARY KEY(`bot_id`, `id`),\n\tFOREIGN KEY (`bot_id`) REFERENCES `personal_assistants`(`bot_id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n"
  },
  {
    "version": 13,
    "name": "0012_dear_wild_pack",
    "sql": "CREATE INDEX `assistant_thread_owned_page` ON `assistant_thread_operations` (`bot_id`,`epoch`,`command`,`id`);--> statement-breakpoint\nCREATE INDEX `assistant_thread_target` ON `assistant_thread_operations` (`bot_id`,`epoch`,`reference`,`command`);"
  },
  {
    "version": 14,
    "name": "0013_channel_attachments",
    "sql": "CREATE TABLE `actor_channel_attachments` (\n\t`message_id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`mime` text NOT NULL,\n\t`bytes` blob NOT NULL,\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n"
  },
  {
    "version": 15,
    "name": "0014_native_channel_mentions",
    "sql": "CREATE TABLE `actor_channel_mentions` (\n\t`message_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`start` integer NOT NULL,\n\t`end` integer NOT NULL,\n\t`display_name` text NOT NULL,\n\t`actor_kind` text NOT NULL,\n\tPRIMARY KEY(`message_id`, `start`),\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_channel_mentions_range\" CHECK(start >= 0 AND end > start),\n\tCONSTRAINT \"actor_channel_mentions_kind\" CHECK(actor_kind IN ('human','session'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_channel_mentions_receiver` ON `actor_channel_mentions` (`actor_id`,`message_id`);"
  },
  {
    "version": 16,
    "name": "0015_visible_mention_reads",
    "sql": "CREATE TABLE `actor_channel_mention_reads` (\n\t`message_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\tPRIMARY KEY(`message_id`, `actor_id`),\n\tFOREIGN KEY (`message_id`) REFERENCES `actor_messages`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\n-- Preserve the previously published read state without resurrecting historical alerts.\nINSERT OR IGNORE INTO actor_channel_mention_reads(message_id,actor_id)\nSELECT DISTINCT n.message_id,n.actor_id FROM actor_channel_mentions n\nJOIN actor_messages m ON m.id=n.message_id\nJOIN actor_channel_members cm ON cm.channel_id=m.channel_id AND cm.actor_id=n.actor_id\nJOIN actor_channel_reads r ON r.channel_id=cm.channel_id AND r.actor_id=cm.actor_id AND r.epoch=cm.epoch\nWHERE m.seq<=r.read_seq;\n"
  },
  {
    "version": 17,
    "name": "0016_human_reservations",
    "sql": "CREATE TABLE `actor_human_reservations` (\n  `binding` text PRIMARY KEY NOT NULL,\n  `actor_id` text NOT NULL REFERENCES actors(id),\n  `login_provider` text NOT NULL,\n  `alias` text NOT NULL,\n  `created_at` integer NOT NULL,\n  `state` text NOT NULL,\n  CONSTRAINT actor_human_reservations_state CHECK(state IN ('pending','claimed','revoked'))\n) STRICT;\n--> statement-breakpoint\nCREATE INDEX `actor_human_reservations_alias` ON actor_human_reservations(login_provider,alias,state);\n"
  },
  {
    "version": 18,
    "name": "0017_multi_bot_assignments",
    "sql": "ALTER TABLE `personal_assistants` ADD `is_default` integer DEFAULT 1 NOT NULL CHECK(is_default IN (0,1));--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `duties` text DEFAULT '' NOT NULL;--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `environment_json` text DEFAULT '{\"kind\":\"local\"}' NOT NULL;--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `config_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `paused` integer DEFAULT 0 NOT NULL CHECK(paused IN (0,1));--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `create_key` text;--> statement-breakpoint\nALTER TABLE `personal_assistants` ADD `create_fingerprint` text;--> statement-breakpoint\nDROP INDEX `personal_assistants_owner_unique`;--> statement-breakpoint\nCREATE UNIQUE INDEX `personal_assistants_default_owner_unique` ON `personal_assistants` (`owner_human_id`) WHERE is_default=1;--> statement-breakpoint\nCREATE UNIQUE INDEX `personal_assistants_create_key` ON `personal_assistants` (`owner_human_id`,`create_key`);\n"
  },
  {
    "version": 19,
    "name": "0018_native_group_lifecycle",
    "sql": "CREATE TABLE `actor_channel_departures` (\n\t`channel_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`member_epoch` text NOT NULL,\n\t`left_at` integer NOT NULL,\n\tPRIMARY KEY(`channel_id`, `actor_id`),\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_channel_lifecycles` (\n\t`channel_id` text PRIMARY KEY NOT NULL,\n\t`revision` integer DEFAULT 1 NOT NULL,\n\t`dissolved_at` integer,\n\t`dissolved_by` text,\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_channel_lifecycles_revision\" CHECK(\"actor_channel_lifecycles\".\"revision\" >= 1)\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `actor_channel_list_states` (\n\t`channel_id` text NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`hidden` integer DEFAULT 0 NOT NULL,\n\tPRIMARY KEY(`channel_id`, `actor_id`),\n\tFOREIGN KEY (`channel_id`) REFERENCES `actor_channels`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"actor_channel_list_hidden\" CHECK(\"actor_channel_list_states\".\"hidden\" IN (0,1))\n) STRICT;\n"
  },
  {
    "version": 20,
    "name": "0019_space_open_contact",
    "sql": "ALTER TABLE `collaboration_spaces` ADD `open_contact` integer DEFAULT 0 NOT NULL;"
  }
] as const;
export const SERVER_ALTERNATE_MIGRATIONS = [
  {
    "id": "generic-legacy-v13",
    "migrations": [
      {
        "version": 1,
        "name": "0000_server_core",
        "sql": SERVER_MIGRATIONS[0].sql
      },
      {
        "version": 2,
        "name": "0001_execution_capability_bindings",
        "sql": SERVER_MIGRATIONS[1].sql
      },
      {
        "version": 3,
        "name": "0002_native_channels",
        "sql": SERVER_MIGRATIONS[5].sql
      },
      {
        "version": 4,
        "name": "0003_actor_inbox",
        "sql": SERVER_MIGRATIONS[6].sql
      },
      {
        "version": 5,
        "name": "0004_native_channel_sync",
        "sql": SERVER_MIGRATIONS[7].sql
      },
      {
        "version": 6,
        "name": "0005_personal_assistants",
        "sql": SERVER_MIGRATIONS[8].sql
      },
      {
        "version": 7,
        "name": "0006_personal_assistant_credentials",
        "sql": SERVER_MIGRATIONS[9].sql
      },
      {
        "version": 8,
        "name": "0007_assistant_model_selection",
        "sql": SERVER_MIGRATIONS[10].sql
      },
      {
        "version": 9,
        "name": "0008_thread_access_and_notes",
        "sql": SERVER_MIGRATIONS[2].sql
      },
      {
        "version": 10,
        "name": "0009_project_automations",
        "sql": SERVER_MIGRATIONS[3].sql
      },
      {
        "version": 11,
        "name": "0010_eminent_mathemanic",
        "sql": SERVER_MIGRATIONS[11].sql
      },
      {
        "version": 12,
        "name": "0011_dear_wild_pack",
        "sql": SERVER_MIGRATIONS[12].sql
      },
      {
        "version": 13,
        "name": "0012_channel_attachments",
        "sql": SERVER_MIGRATIONS[13].sql
      },
      {
        "version": 14,
        "name": "converge_0004_magenta_aqueduct",
        "sql": SERVER_MIGRATIONS[4].sql
      },
      {
        "version": 15,
        "name": "converge_0014_native_channel_mentions",
        "sql": SERVER_MIGRATIONS[14].sql
      },
      {
        "version": 16,
        "name": "converge_0015_visible_mention_reads",
        "sql": SERVER_MIGRATIONS[15].sql
      },
      {
        "version": 17,
        "name": "converge_0016_human_reservations",
        "sql": SERVER_MIGRATIONS[16].sql
      },
      {
        "version": 18,
        "name": "converge_0017_multi_bot_assignments",
        "sql": SERVER_MIGRATIONS[17].sql
      },
      {
        "version": 19,
        "name": "converge_0018_native_group_lifecycle",
        "sql": SERVER_MIGRATIONS[18].sql
      },
      {
        "version": 20,
        "name": "converge_0019_space_open_contact",
        "sql": SERVER_MIGRATIONS[19].sql
      }
    ]
  }
] as const;
export const SERVER_MIGRATION_CONTRACT_HASH = "5ed24e8ebd277de2b5a77bf3755306c1f7fe4d6f397703ec6609de1d64b4d333" as const;
export const OPENCRAFT_VERSION = "0.1.0" as const;
