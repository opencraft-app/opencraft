# Thread titles

HyperNode treats a task title as shared domain state, not as a formatted UI
string. The durable `ThreadTitleService` record is:

```text
threadId
text
revision
updatedBy
updatedByUsername
updatedAtMs
source
sourceThreadId
```

`text` is the user-controlled title visible to every tenant. `revision` is a
monotonic per-task compare-and-set token. The actor fields provide audit
metadata without entering the title shown by Codex Desktop. Existing catalog
titles migrate automatically on startup; repeated legacy decorations are
removed at the domain boundary.

The cloud badge and execution state are presentation projections:

```text
stored:       Locate project details
idle:         ☁️ Locate project details
writer sees:  🔒 我 · Locate project details
peer sees:    🔒 alice · Locate project details
completed:    ✅ alice · Locate project details
```

They are never accepted as canonical text. This prevents a Desktop echo, a
fork, or a second connection from turning presentation state into names such as
`✅ 我 · ✅ 我 · ...`.

## Mutation and fanout

The official `thread/name/set` request remains unchanged. HyperNode forwards a
canonical title to the owning Codex backend, commits it only after a successful
response, and broadcasts the official `thread/name/updated` notification to
every initialized frontend. Each connection receives its own `我` or username
projection from `ThreadPresentationService`.

The backend may publish `thread/name/updated` before completing the request.
That ordering creates one text revision; the later successful response adds the
initiating HyperNode user attribution without creating a duplicate revision.
Internal callers may supply `expectedRevision` and receive deterministic error
`-32072` with `data.kind = threadTitleRevisionConflict` on stale writes.

Durable forks inherit the source title text into revision 1 of a new independent
history and retain `sourceThreadId` as lineage. Ephemeral side chats may use the
same in-memory model but are excluded from title persistence. Archiving keeps a
title; deleting a task removes its title record.

No Renderer modification or protocol-only title prefix is required.
