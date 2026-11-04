CREATE TABLE `execution_goal_grants` (
	`thread_id` text NOT NULL,
	`authorization_id` text PRIMARY KEY NOT NULL,
	`principal_json` text NOT NULL,
	`state` text NOT NULL,
	`round` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `execution_goal_rounds` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`authorization_id` text NOT NULL,
	`round` integer NOT NULL
);
