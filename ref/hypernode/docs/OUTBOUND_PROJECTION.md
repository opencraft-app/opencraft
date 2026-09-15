# Outbound protocol projection

HyperNode stores and routes canonical protocol state. Tenant-relative values
such as `我`, another user's display name, execution badges, and virtual paths
must never be written back into that canonical state.

`AppServerVService` therefore exposes a Cordis extension point:

```js
ctx.appServer.projectOutbound((message, connection) => projectedMessage)
```

Every locally handled response, queued notification, and broadcast passes
through the ordered projector chain immediately before it is written to a
connection. Projectors must return a new object when changing a message and
must not mutate the canonical input.

`ThreadPresentationService` is the first projector. It decorates thread objects
inside catalog/read/resume responses and rewrites `thread/name/updated` for the
receiving SSH identity:

- the active actor sees `🔒 我 · title`;
- another tenant sees `🔒 alice · title`;
- after completion the recent actor is shown with `✅`;
- canonical thread names remain unchanged in storage.

Response projection is required in addition to notifications. Codex Desktop
may refresh `thread/list` immediately after a name notification; returning an
undecorated catalog row would otherwise erase the broadcast and the server's
connection cache would incorrectly suppress a second notification.

Transparent Codex fanout uses the same `appServer.send()` boundary, so backend
responses and notifications cannot bypass tenant projection during an account
handoff.
