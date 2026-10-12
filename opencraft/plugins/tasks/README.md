# Tasks

Built-in Web/Electron extension, opened from **任务** in the primary sidebar.
Tasks are business records; Board and List display the same rows. Six fixed
statuses follow the agreed BB Tasks abstraction. Drag a handle or choose a
status to move a task. The shared `SegmentedControl` switches views and selects
one status column when the container is 600px or narrower. The Radix editor
fills narrow containers and retains its draft across conversation navigation.

Associate existing conversations directly from enabled connections; a new task
is saved as part of linking. Choose **New conversation** to save the task and
open the native chat draft prefilled with its title/description. The user still
reviews the model/workspace and sends explicitly. A matching-Server project
sets native project/workspace placement; another Server uses its own roots.
A task can link multiple conversations across Servers, and a conversation can
belong to multiple tasks. Opening an association uses the application's normal
Server/Thread resolver and Router, including direct links on each card.
Business status can also change inside the editor without losing other edits.
Detaching/deleting a task never deletes its
conversations. Optional project references use existing project catalogs.
Board/List can filter by the stored project reference.

Conversation titles and activity come from read-only native `thread/read`.
Unknown or unavailable activity remains Unknown; it does not imply Idle or Done.
The task's business status changes only through Tasks mutations. This feature
does not automatically launch agents, create worktrees, schedule tasks or run workflows.
The native thread creation receipt triggers association even if the first Turn
fails. The application retains draft identities and confirmed receipts in
separate per-draft product/account-scoped client records; task data remains
SQLite rows. Failed association exposes Open/Retry actions and reconciles the
authority before retrying a link, never a thread or Turn. Separate browser tabs
cannot overwrite each other's placement records.

## Storage and lifecycle

The Workbench backend owns one `tasks.sqlite`, independently of the selected
chat Host: Headless Web uses `opencraft-server`, Electron `local-codex`.
The two business tables are `tasks` and `task_conversations`. The separate
`schema_migrations` ledger records the immutable version-1 baseline and its
checksum. Unknown or altered migration history refuses access. Subsequent
schema changes must add explicit backend-owned numbered migrations; the
baseline must never be edited to upgrade an existing database.

Local Agent Host and the local Codex adapter implement `opencraft/tasks/*`.
Client plugins receive typed operations, never SQLite handles, paths or SQL.
The Node storage entry is separate from the presentation bundle. Older or
unsupported backends report unavailable; no client-local storage fallback.
Old `kanban.sqlite` is neither read nor migrated nor deleted.

Task revisions guard edits, moves and association changes within transactions.
Moves advance every affected row's revision. Removal retains a tombstone and
never revives the ID. Association identities include Server and Thread; their
composite key permits many-to-many links. Identical creation and association
replays are idempotent. Limits are 1,000 live tasks, 64 conversations per task,
and 100 recent matching conversations in the picker.

Committed writes broadcast `opencraft/tasks/changed`; other windows refresh.
Visible Views also refresh every five seconds and on focus. Drafts survive
navigation during an activation, not a full reload. External revisions block
saving a stale draft and offer Load latest content. Missing acknowledgements
trigger an authority read, never an automatic write replay. Unmount removes
subscriptions; extension retirement clears drafts and fences late replies.

## Verification and preview

- `npm run test:tasks`: SQLite/CAS/restart, multi-Server identities, migration
  history rejection, request validation, controller races and real Host routes.
- `npm run smoke:tasks:workbench`: built actual Workbench, native Codex history,
  associations, shared Board/List, multiple-window conflicts, mobile layout,
  Router POP/reload, Host switching, task-to-native-draft prefill/reload/send,
  project placement, direct-card conversation entry and read-only database inspection. Fresh
  private data, no paid model accounts and a synthetic offline DSH provider; a native Codex first turn persists history and fails
  locally without paid inference.
- `npm run preview:tasks:workbench`: actual Workbench with independent data.
  First run `npm run prepare:dsh-runtime`, then build Web with
  `OPENCRAFT_HEADLESS_SERVER_BUILD=true` and `VITE_APPSERVER_HOSTS_JSON` set to
  `[{"hostId":"opencraft-server","label":"OpenCraft Server","kind":"durable","executionLocation":"This server","url":"/appserver","workspaceBrowseRoots":["/"]}]`.
  `OPENCRAFT_TASKS_WORKBENCH_DATA` retains a chosen independent data directory;
  `OPENCRAFT_CODEX_EXECUTABLE` supplies Codex outside PATH. Loopback only; this
  does not switch an existing Workbench.

Browser scripts accept `OPENCRAFT_PLAYWRIGHT_MODULE` and
`OPENCRAFT_CHROMIUM_EXECUTABLE`. Browser phone sizing is not physical-device
keyboard verification; Electron interactions require a packaged desktop check.
The domain contract and execution boundary are in [Tasks model](../../docs/tasks-model.md).
