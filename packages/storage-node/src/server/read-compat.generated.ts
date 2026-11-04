// Generated from owner read-compat/contracts.json and exact reviewed SQL.
export const SERVER_READ_COMPATIBILITY = {
  "baseVersion": 5,
  "baseHash": "729e4e03a328d1d341b5c9b890ad0888d5161ddf3d1d45fe52c828612fdbc1bb",
  "targetHash": "2a9a0a2efbba087aa36255f2c4e2024e1d41a2b4d8031936d21682a77a43c771",
  "migration": {
    "version": 6,
    "name": "0005_mushy_karma",
    "sql": "CREATE TABLE `actor_conversation_creations` (\n\t`actor_id` text NOT NULL,\n\t`idempotency_key` text NOT NULL,\n\t`operation_id` text NOT NULL,\n\t`fingerprint` text NOT NULL,\n\t`server_id` text NOT NULL,\n\t`project_id` text NOT NULL,\n\t`cwd` text NOT NULL,\n\t`settings_json` text NOT NULL,\n\t`creation_state` text NOT NULL,\n\t`thread_id` text,\n\t`first_message_state` text NOT NULL,\n\t`request_id` text,\n\t`updated_at` integer NOT NULL,\n\tPRIMARY KEY(`actor_id`, `idempotency_key`)\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `actor_conversation_creation_operation` ON `actor_conversation_creations` (`operation_id`);"
  },
  "nextHash": "b5238d550289e111e1f94d0212f4273a34768ec26de6fc195ec3906258d539dd",
  "nextMigration": {
    "version": 7,
    "name": "0006_serious_stellaris",
    "sql": "CREATE TABLE `conversation_input_settings` (\n\t`request_id` text PRIMARY KEY NOT NULL,\n\t`model` text,\n\t`reasoning_effort` text,\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"conversation_input_settings_explicit\" CHECK(model IS NOT NULL OR reasoning_effort IS NOT NULL)\n) STRICT;\n"
  },
  "onceTierHash": "97c64637c06de25f823e48159ea2223932324c708b363443d5ea1ad767af3fd3",
  "onceTierMigration": {
    "version": 8,
    "name": "0007_harsh_marten_broadcloak",
    "sql": "CREATE TABLE `conversation_input_execution_options` (\n\t`request_id` text PRIMARY KEY NOT NULL,\n\t`service_tier_for_turn` text NOT NULL,\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n"
  },
  "attachmentHash": "249d8d23ecd441b2872c2e508c7413ec249f79cf7f3ddaaf9dfb05df4fcc295e",
  "attachmentMigration": {
    "version": 9,
    "name": "0008_cli_message_attachments",
    "sql": "CREATE TABLE `conversation_attachment_bindings` (\n\t`request_id` text NOT NULL,\n\t`ordinal` integer NOT NULL,\n\t`attachment_id` text NOT NULL,\n\t`descriptor_json` text NOT NULL,\n\tPRIMARY KEY(`request_id`, `ordinal`),\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,\n\tFOREIGN KEY (`attachment_id`) REFERENCES `conversation_attachment_uploads`(`id`) ON UPDATE no action ON DELETE no action\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `conversation_attachment_chunks` (\n\t`attachment_id` text NOT NULL,\n\t`offset` integer NOT NULL,\n\t`bytes` blob NOT NULL,\n\tPRIMARY KEY(`attachment_id`, `offset`),\n\tFOREIGN KEY (`attachment_id`) REFERENCES `conversation_attachment_uploads`(`id`) ON UPDATE no action ON DELETE cascade\n) STRICT;\n--> statement-breakpoint\nCREATE TABLE `conversation_attachment_uploads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`actor_id` text NOT NULL,\n\t`generation` integer NOT NULL,\n\t`server_id` text NOT NULL,\n\t`target_json` text NOT NULL,\n\t`operation_key` text NOT NULL,\n\t`ordinal` integer NOT NULL,\n\t`descriptor_json` text NOT NULL,\n\t`received` integer NOT NULL,\n\t`state` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`request_id` text,\n\t`creation_id` text,\n\tFOREIGN KEY (`request_id`) REFERENCES `actor_execution_requests`(`id`) ON UPDATE no action ON DELETE no action,\n\tCONSTRAINT \"conversation_attachment_state\" CHECK(state IN ('uploading','ready','bound','delivered'))\n) STRICT;\n--> statement-breakpoint\nCREATE UNIQUE INDEX `conversation_attachment_identity` ON `conversation_attachment_uploads` (`actor_id`,`generation`,`operation_key`,`ordinal`);--> statement-breakpoint\nCREATE INDEX `conversation_attachment_expiry` ON `conversation_attachment_uploads` (`state`,`expires_at`);"
  }
} as const;
