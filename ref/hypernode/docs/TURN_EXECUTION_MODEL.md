# Turn execution model

HyperNode separates durable conversation state from the process that executes a
single turn.

## Invariants

1. A public `threadId` is stable. Changing model, provider, account, or agent
   harness never changes the public thread identity.
2. Every accepted `turn/start` captures one immutable `ExecutionProfile`.
3. A runtime may execute the turn only when its profile fingerprint matches the
   captured profile. A stale runtime is fenced by the turn epoch.
4. `turn/steer` always targets the active turn and therefore its already-bound
   runtime. Settings changed while a turn is active apply only to the next turn.
5. Provider/account/model changes are committed only at a turn boundary and
   only inside the Thread's bound engine. Crossing `codex <-> dsh` requires an
   explicit migration; ordinary `turn/start` never translates history.
6. A runtime is disposable. Codex rollout or DSH SessionEvent history is the
   engine recovery authority. Durable AppServer Thread/Turn/Item data is a
   rebuildable read model, not an engine resume input.

## State machine

```text
idle
  | turn/start captures ExecutionProfile + epoch
  v
claimed -> opening/switching -> running
   ^                            |  turn/steer stays here
   |                            |
   +------ retry is deduped ----+
                                |
                     turn/completed or failure
                                v
                              idle
```

`thread/settings/update` while `running` writes `nextProviderId`, `nextModel`,
and `nextThreadSettings`; it never mutates the active profile. The next
`turn/start` resolves those desired settings, captures a new profile, and
reuses or replaces a compatible runtime inside the bound engine. An engine
change returns `engineMigrationRequired` until an explicit migration commits.

## Execution profile

Runtime identity is the fingerprint of:

- engine/harness kind;
- provider;
- credential/account identity;
- actor identity;
- model.

Permissions, sandbox policy, reasoning effort, service tier, collaboration
mode, and workspace roots are frozen in `turnConfig`. They are turn-local
contract data rather than process-pool identity, but cannot change underneath
an active turn.

## Adapter boundary

Codex app-server is one execution engine and the Desktop protocol facade. Other
engines, including DeepSeek Harness, implement the same internal turn event
contract through an adapter. The projection layer owns public Thread/Turn/Item
identity and ordering; an engine adapter may not manufacture a second public
thread or reorder steer input.

Codex accepts only native ChatGPT/Codex subscription profiles. Public models
and user-defined endpoint/API-key profiles are always `engineKind=dsh`; they
must never be expressed as Codex `model_providers`, injected into a Codex
environment, or executed by the Codex compatibility runtime.

## Recovery

After a HyperNode restart, persisted `inProgress` state is evidence, not proof
that a process is alive. Recovery must either reattach to a runtime with the
same fingerprint and epoch or deterministically abort the orphaned turn before
accepting another `turn/start`.
