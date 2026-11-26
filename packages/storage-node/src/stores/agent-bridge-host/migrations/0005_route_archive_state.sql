ALTER TABLE `routes` ADD `archive_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
CREATE INDEX `commands_pending_archive` ON `commands` (`route`) WHERE method IN ('session/archive','session/unarchive') AND state IN ('registered','dispatching');--> statement-breakpoint
WITH latest_archive AS (
  SELECT route, method, state, row_number() OVER (PARTITION BY route ORDER BY rowid DESC) AS position
  FROM commands
  WHERE method IN ('session/archive','session/unarchive')
    AND state IN ('accepted','unknown','dispatching')
)
UPDATE routes
SET archive_state=COALESCE((
  SELECT CASE
    WHEN state != 'accepted' THEN 'unconfirmed'
    WHEN method = 'session/archive' THEN 'archived'
    ELSE 'active'
  END
  FROM latest_archive WHERE latest_archive.route=routes.route AND position=1
), 'active');
