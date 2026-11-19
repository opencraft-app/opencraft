# Native chat message search

The existing conversation search dialog combines execution conversation sources
with a native-channel source contributed by the IM plugin. The same source is
available without an execution Host. Web and Electron use the same AppServer
methods and native history; WeCom synchronization does not create a second search
store. Only synchronized messages are searchable, not arbitrary provider history.

`opencraft/channels/search` applies current actor admission and channel membership
inside the SQL query before pagination. It returns individual message matches,
their channel summaries, and an exclusive sequence cursor. Queries are literal,
case insensitive for ASCII, with at most 50 results per page. This is a bounded
page over existing history, not a full-text index or semantic search service.
The socket adapter rechecks returned channel scopes after the Worker boundary.

The plugin owns the query transport and registration lifetime. The Workbench
owns debounce, obsolete-query cancellation, merged results, keyboard/touch
selection and navigation. Search results carry a view destination; native
messages are not fabricated execution threads or turns. Excerpts are bounded
around the first match and rendered as text.

A message destination opens `opencraft-channel:<id>#message=<sequence>`.
`opencraft/channels/messages/around` loads at most 25 older messages plus the
selected message and up to 24 newer messages, after checking current membership.
The shared MessageTimeline handles virtualized reveal, measurement and scrolling.
The context view highlights the target, continues authorization observation,
and offers Latest messages. It is not an assertion of complete history and does
not mark the latest message read. Its messages/checkpoint do not replace the
normal live replica. Both views retain the same channel Composer draft.

Validation: `tests/extensions/channel-search-source.test.ts`, native sync and
AppServer tests, and `scripts/smoke/execution/smoke-channel-global-search.ts`.
The browser smoke exercises real Workbench, native SQLite and WebSocket routing
with synthetic identity and external-provider transport, not a real WeCom login.
