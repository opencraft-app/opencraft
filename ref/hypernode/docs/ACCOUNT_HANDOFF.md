# Transparent Thread account handoff

A transparent HyperNode thread is a logical conversation. It is not owned by
the Codex process that happened to create its first rollout.

The implementation keeps four independent state machines:

1. **Thread identity** — the durable binding contains the public/inner IDs,
   workspace realm/view, and rollout path. It contains no owner.
2. **Turn authority** — `ThreadExecutionService` grants one active execution
   epoch and binds that epoch to an account and runtime at dispatch time. Every
   turn notification is fenced by epoch and runtime, so a delayed backend
   cannot complete or mutate a successor's turn.
3. **Runtime residency** — the persisted `lastRuntimeHint` only accelerates
   reopening. Each active outer thread has one disposable, dedicated app-server
   process; control-plane requests may still use a pooled per-user runtime.
4. **Rollout artifacts** — `CodexRolloutArtifactStoreService` stores immutable
   generations beneath `/workspace/.hypernode/threads`. The first generation
   is imported from a user's private `CODEX_HOME`; later generations use Btrfs
   reflinks when possible and byte-copy fallback otherwise.

## Handoff protocol

When another ChatGPT account starts a turn:

1. acquire a new authority epoch;
2. terminate and reap the previous thread's dedicated process group, which is
   the lifetime of Codex's rollout writer lock;
3. snapshot the completed rollout into a new working generation while keeping
   the same inner thread ID;
4. start a new dedicated app-server under the target account;
5. call `thread/resume` with the generation path and unchanged inner ID;
6. publish the new runtime hint and bind the active execution to that runtime;
7. forward the original `turn/start` under the same epoch;
8. fence every notification from older authority epochs.

The public outer ID and normal backend inner ID never change. Codex keeps an
unsubscribed thread loaded for its idle-unload window (currently 30 minutes),
so HyperNode does not use `thread/unsubscribe` as a writer-release primitive.
It closes the dedicated runtime, waits for actual exit, and only then resumes
the rollout. Container runtimes use a stable, outer-thread-derived PID file;
startup reaps a process left behind by a daemon restart before opening a new
writer.

Rollout reidentification remains a fail-closed compatibility fallback. If an
unmanaged or legacy pooled Codex runtime still owns the old writer lock,
`thread/resume` returns `already has an active writer`; HyperNode then rewrites
only canonical `session_meta.id` into a fresh generation and retries. This is
not the normal account-switch path.

The target runtime hint is published only after `thread/resume` succeeds. On a
snapshot or resume failure, HyperNode removes the new working generation,
releases the authority claim, and retains the preceding committed artifact.

Subscriptions are orthogonal: any number of frontends may observe one logical
thread before, during, and after an account switch. Steering, approvals, tool
responses, and completion remain routed to the runtime bound to the active
execution epoch.

All Codex authentication remains private to each SSH user. Rollout generation
paths contain only the public outer thread id and never expose a username or
account token.
