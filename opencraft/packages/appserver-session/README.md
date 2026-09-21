# @opencraft/appserver-session

Cordis-governed Codex Desktop Resume semantics. This package owns mounted
Thread Views and hydration orchestration; it does not own the physical
transport or the future Replica journal.

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
