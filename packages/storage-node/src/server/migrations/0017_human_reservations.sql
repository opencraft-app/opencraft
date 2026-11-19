CREATE TABLE `actor_human_reservations` (
  `binding` text PRIMARY KEY NOT NULL,
  `actor_id` text NOT NULL REFERENCES actors(id),
  `login_provider` text NOT NULL,
  `alias` text NOT NULL,
  `created_at` integer NOT NULL,
  `state` text NOT NULL,
  CONSTRAINT actor_human_reservations_state CHECK(state IN ('pending','claimed','revoked'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `actor_human_reservations_alias` ON actor_human_reservations(login_provider,alias,state);
