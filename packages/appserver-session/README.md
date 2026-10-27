# @opencraft/appserver-session

Cordis-governed AppServer Resume semantics with a V3 compatibility adapter.
This package owns mounted Thread Views and hydration orchestration; it does not
own the physical transport or the future Replica journal.

Public services:

- `threadViews`: immutable `getSnapshot / subscribe / update` View store.
- `threadResume`: Resume, retry, reconnect, older-page and background-drain
  coordinator.
- `threadHistoryStrategies`: pluggable Legacy, Tail, Paginated and Durable
  history loaders.
- `resumeNotificationBuffer`: wire-level notification and server-request
  buffering until View commit.
- `threadStreamOwnership`: owner/follower role state.
- `threadResumeProjectors`: response-to-View projection extensions.
- `threadNotificationProjectors`: ordered live-notification reducers.

Every plugin declares Cordis `inject` dependencies. Identity and history-policy
fields remain Coordinator-owned, so an extension cannot change `threadId` or
silently disable Tail hydration through `requestOverrides`.

Recovery checkpoints are hints validated against the current response before
hydration. An explicit null checkpoint suppresses a stale initial checkpoint.
When a provider confirms unchanged history, recovery preserves the current
immutable transcript and pagination rather than loading that history again.
