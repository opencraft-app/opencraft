# Thread write leases

Thread subscriptions are multi-reader and are never leases. HyperNode separates
two kinds of serialization:

- transparent Codex threads use `ThreadExecutionService`, which grants one
  active turn epoch and account/runtime authority at dispatch time;
- mock/system threads and shared workspace mutations use this resource write
  lease so two connections cannot concurrently mutate the same physical view.

Neither mechanism makes a user or Codex account the durable owner of a thread.

## Lifecycle

- `hypernode/threadWriteLease/acquire` creates a 20 second `editing` lease.
- `hypernode/threadWriteLease/heartbeat` renews the editing deadline.
- `turn/start` on mock/system threads atomically acquires the lease or promotes
  the calling connection's editing lease to `running`. Transparent turns use
  execution epochs instead.
- A running lease remains valid until the turn completes or fails. It does not
  expire merely because the model is quiet for 20 seconds.
- `hypernode/threadWriteLease/release` releases an editing lease explicitly.
- A disconnected holder enters a 20 second recovery window and is then swept.

Lease changes are broadcast as `hypernode/threadWriteLease/changed`. A rejected
writer receives JSON-RPC error `-32061` with `data.kind` set to
`threadWriteLeaseHeld`, including the holder username and expiry when applicable.

The latest editor is stored separately in SQLite table `do_thread_last_edits`.
It is metadata, not a turn or thread-history item. When another SSH identity
reads or resumes the thread, HyperNode sends the official app-server
`warning { threadId, message }` notification. Online readers also receive the
warning when another connection acquires the write lease. Repeated reads are
deduplicated for 30 seconds. The originating writer connection is excluded, but
the same SSH user still sees the last-editor warning after refreshing, resuming,
or opening the thread from another device.

## Protected operations

An execution or resource mutation is exclusive; reading and subscribing are
not. While another connection owns a resource lease, HyperNode also rejects
`turn/interrupt`, `thread/archive`, `thread/unarchive`,
`thread/metadata/update`, and `thread/name/set`. Read and list operations remain
available.

The current Renderer does not need to change for turn-level exclusion or the
last-editor notice: `warning` is part of the official app-server protocol.
