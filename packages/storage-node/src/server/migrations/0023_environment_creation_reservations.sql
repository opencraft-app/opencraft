CREATE TABLE `environment_creation_reservations` (
	`host_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_generation` integer NOT NULL,
	`membership_revision` integer NOT NULL,
	`source` text,
	`incarnation` text NOT NULL,
	`project` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`host_id`, `operation_id`),
	CONSTRAINT "environment_creation_reservation_state" CHECK(state IN ('pending', 'launched', 'abandoned')),
	CONSTRAINT "environment_creation_reservation_epoch" CHECK(actor_generation > 0 AND membership_revision >= 0)
) STRICT;
