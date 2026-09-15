# Project projection

Codex projects and threads are separate durable entities. A thread's canonical
membership is `thread.projectId`; cwd-based grouping and Electron persisted atoms
are compatibility inputs, not the source of truth.

Hypernode keeps three identities distinct:

- the desktop-visible outer thread ID;
- the per-user Codex app-server inner thread ID;
- the project ID shared by every projection of that thread.

`ProjectCatalogService` implements the experimental upstream `project/*`
contract and owns project roots, metadata, ordering, and idempotent creation.
`ThreadProjectBindingService` owns outer-thread membership, while
`ProjectProjectionService` emits connection-safe project and membership deltas.
`TransparentCodexThreadService` may replace or reconnect an inner thread
without changing the outer thread's project assignment.

## Node authority

`/workspace/projects/<name>` is the canonical project anchor. HyperNode assigns
a stable `project-hypernode-*` identity to the first path segment below that
anchor. Main and fork storage paths therefore project to the same logical
project. The workspace root itself remains projectless so the management and
All threads do not become accidental projects.

Desktop may explicitly supply a project ID. HyperNode preserves it and learns
its roots. When Desktop supplies no project, or sends `projectId: null` during a
new thread start, the node authority infers the project from the canonical cwd.
Explicit `thread/metadata/update(projectId: null)` still clears membership.

At startup, old active and archived threads are migrated in one catalog write
without changing their recency. Reconnect uses a connection-scoped bootstrap:

1. no project notification is emitted during `initialize`, because Desktop may
   not have installed its project subscription graph yet;
2. the first root `thread/list` response is followed by `project/changed`
   invalidations;
3. a client that consumes the official API receives bindings only after the
   final `project/list` page has crossed the wire;
4. a legacy remote-project client that never calls `project/list` receives the
   same binding projection after a short transport-turn grace period.

The legacy path does not add private fields to the app-server protocol. It only
preserves ordering between the official project and binding notifications.
Up to 1,000 most-recent active bindings are replayed; normal paged `thread/list`
is the reconciliation checkpoint for the rest. There is no periodic full
broadcast.

## Compatibility migration

Older Hypernode builds hard-coded `projectId: null` and did not apply the
official cwd/project filters in `thread/list`. During a project-scoped list,
the service now records a supplied project ID and exact cwd roots, then migrates
matching outer threads and emits `thread/project/updated`.

Transparent thread creation used to bypass that capture path entirely. It now
passes through `ThreadProjectBindingService`, as do ordinary start/resume and
workspace forks.

An Electron project may retain a thread ID after Hypernode has deliberately
removed that thread. Resuming such an ID emits `thread/archived` so the desktop
can remove its dangling project row, then returns `thread not found`. It never
creates an unrelated conversation solely because a stale project row was
clicked.

## Required gates

The SSH protocol E2E covers:

- idempotent `project/create`;
- `thread/start.projectId` persistence;
- authoritative cwd inference when Desktop sends a null project ID;
- startup migration across logical main/fork aliases without recency changes;
- cold-client bootstrap ordering (root thread catalog, complete project catalog,
  then thread bindings);
- legacy remote-project replay after a project hydration grace turn;
- exact `thread/list.projectId` and cwd filtering;
- `thread/metadata/update.projectId` assignment and clearing;
- dangling project-thread self-healing notifications;
- both the Go rollback SSH stack and the Cordis-owned vSSH stack.
