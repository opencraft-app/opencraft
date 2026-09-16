# HyperNode Workspace Runtime v2

## Outcome

Workspace is an engine-neutral durable resource. A Thread references a
`WorkspaceRef`; Codex and DSH receive an attachment capability over SSH after
`AttachWorkspace`. AppServer paths, Btrfs subvolume names, runc bundle IDs and
host user directories are not part of the public namespace.

## Invariants

1. `WorkspaceRef { id, driver }` is the only durable identity above a driver.
2. Every durable ordinary workspace conversation owns exactly one
   `WorkspaceRef`.
3. The node-wide `管理员` conversation is the only root conversation.
   `RootThreadService` persists its stable UUID under `node:root`; the workspace
   catalog binds that exact UUID to the root `WorkspaceRef`.
4. The root conversation remains the management surface for Turns, titles and
   collaboration. Its workspace is also the template seen by newly-created
   workspaces. It cannot be archived or replaced implicitly.
5. A new ordinary conversation is an O(1) snapshot of the root workspace. An
   explicit fork snapshots the selected source conversation instead. Both
   SystemView and DataView are captured by the driver.
6. Side chats are ephemeral and share their parent's attachment; they do not
   allocate or delete a workspace.
7. Archiving a non-root durable conversation deletes its workspace. Archiving
   the root is rejected before any Thread projection changes.
8. Runtime and UI projections may be rebuilt. The workspace catalog is
   resource truth and is never reconstructed from Desktop projections.
9. An attachment exposes the current principal's Codex directory through the
   stable `/workspace/.codex` alias so Codex never advertises a private host
   path to the Agent. The same principal home remains available at its exact
   `/run/hypernode-users/<opaque-user>` mount for HOME compatibility; the
   UsersRoot directory itself is never mounted or listable.
10. Root identity is node-wide, not SSH-user-scoped. Every user connected to
    the same HyperNode observes the same management root and derives workspaces
    from the same durable template.

## Local driver

The `local-runc-btrfs` driver stores all subvolumes in one explicitly mounted
Btrfs image:

```text
.workspaces/
  catalog.json
  templates/ubuntu-24.04
  systems/<workspace-id>
  data/<workspace-id>
```

Each workspace has two persistent snapshots:

- `SystemView`: the writable Ubuntu 24.04 rootfs, including packages installed
  by the agent.
- `DataView`: mounted at `/workspace`, including projects and workspace state.

runc composes those views at attachment time. OCI bundles and runtime logs live
under `/run/hypernode-workspaces/<attachment-id>`. The mapped container root is
granted a POSIX ACL containing traverse-only (`--x`) access on the exact private
catalog ancestors needed during `pivot_root`; it receives neither directory
listing nor file-read permission. The catalog namespace is absent after the
pivot, while the selected SystemView and DataView become `/` and `/workspace`.
`/run` is ephemeral so stale PID, socket and agent SQLite files cannot survive
a new runtime attachment.

The provider-neutral control surface is:

```text
CreateWorkspace(spec)
ForkWorkspace(sourceRef, options)
AttachWorkspace(workspaceRef, principal, mode)
DetachWorkspace(attachmentId)
DeleteWorkspace(workspaceRef)
```

Future E2B and external-SSH drivers implement the same interface. They do not
change Thread, Turn or AppServer semantics.

## Administration

Server startup never formats or mounts storage. Preparation is explicit:

```bash
hypernode workspace prepare-v2 --image /data/data.img \
  --mount /data/hypernode/.runtime/workspace --build
```

Historical main-sharing Threads are not all snapshotted during process startup.
On their first engine attachment, `hostWorkspaces.ensureThread(threadId)`
atomically creates an independent O(1) fork from the established management
root. This keeps recovery proportional to active runtimes instead of total
Thread history. Newly-created Threads allocate their fork transactionally in
the Thread creation lifecycle, and an allocation failure rolls back the new
Thread projection.

Production 9988 enables this catalog with `--workspace-runtime runc`. The
preparation unit runs `workspace prepare-v2`; there is no fallback runtime or
old-layout import command.

Status is read-only:

```bash
hypernode workspace status-v2 --image /data/data.img \
  --mount /data/hypernode/.runtime/workspace
```

Start the server with `--workspace-runtime runc`.

## Failure semantics

- Workspace allocation is part of Thread creation. A failed snapshot rolls the
  new Thread projection back.
- Root archive rejection occurs before projection or resource mutation.
- Runtime detach is idempotent.
- Fork quiesces active attachments, snapshots SystemView and DataView, then
  resumes the source.
- Production 9988 is not restarted by prepare or status commands.
