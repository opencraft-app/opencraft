# src

Pure debug helpers and type definitions.

Keep this package independent from React and Next so browser automation can rely on a stable contract.

Conversation runtime diagnostics belong here only as compact serializable
snapshots. Do not import renderer hooks; pass the small debug objects in from
the app shell.

`conversation.scroll.routeResumeStatus` is a diagnostic signal for route/session
scroll restoration. Keep it compact and serializable; the actual DOM and storage
logic stays in `vela-chat-web`.
