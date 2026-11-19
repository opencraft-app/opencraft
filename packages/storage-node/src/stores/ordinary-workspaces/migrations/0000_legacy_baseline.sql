CREATE TABLE `workspace_journal_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);

CREATE TABLE `ordinary_workspace_selections` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`selection_json` text NOT NULL
);

CREATE TABLE `ordinary_workspace_thread_starts` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`phase` text NOT NULL,
	CONSTRAINT "ordinary_workspace_thread_starts_phase" CHECK(phase IN ('dispatched','confirmed'))
);

CREATE TABLE `ordinary_workspaces` (
	`authority_key` text NOT NULL,
	`principal_id` text NOT NULL,
	`host_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`selection_digest` text NOT NULL,
	`thread_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`phase` text DEFAULT 'idle' NOT NULL,
	`instance_id` text,
	`private_volume_id` text,
	PRIMARY KEY(`authority_key`, `intent_id`),
	CONSTRAINT "ordinary_workspaces_phase" CHECK(phase IN ('idle','creating','live','releasing','uncertain'))
);

CREATE UNIQUE INDEX `ordinary_workspaces_workspace_id_unique` ON `ordinary_workspaces` (`workspace_id`);
CREATE UNIQUE INDEX `ordinary_workspaces_host_id_thread_id_unique` ON `ordinary_workspaces` (`host_id`,`thread_id`);