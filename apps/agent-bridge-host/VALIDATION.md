# P1b local validation — 2026-11-11

Source base: P1a `e30c210952`. No existing engine selection, installed service,
production provider, gateway deployment, or client build was changed.

| Command / probe | Result |
| --- | --- |
| `npm run typecheck --workspace @opencraft/agent-bridge-host` | passed |
| `tsc -p packages/agent-bridge-protocol/tsconfig.json --noEmit` | passed |
| `tsc -p packages/agent-bridge-assembler/tsconfig.json --noEmit` | passed |
| `npm run test:agent-bridge` | 57 passed, including 17 Host/Peer cases |
| `npm run test:sandbox` | 21 passed |
| `npm run test:sqlite-node` | 38 passed |
| `npm run check:boundaries` | passed |
| staged diff piped to `gitleaks detect --pipe --redact --no-banner` | no leaks found |

The process tests use separate gateway, Host and fake bridge processes. Gateway
SIGKILL/restart preserves Host PID, bridge PID and canonical Turn identity; the
remaining ordered events are committed once, and another pull adds no events.
Host SIGKILL after a real native execution leaves the original command unknown
on reopening; retransmitting it does not append a second native execution.
Storage lock waits preserve HTTP heartbeats and 10-ms main-thread timers. A live
Worker-loss test confirms that the bridge is reclaimed and admission is fenced.
Runtime main-thread guards reject SQLite construction and synchronous filesystem
calls through actual Host startup, generation activation, commands and close.

The explicit Linux sandbox smoke initially returned systemd `200/CHDIR` because
this machine's `/tmp` is mode 0700 and the synthetic UID 65534 cannot enter it.
An otherwise identical temporary copy changed only payload cwd from `/tmp` to
`/` and passed with PTY enabled. Observed kernel values: CPU `400000 100000`,
memory 8589934592 bytes, tasks 4096, FD soft/hard 65536, UID 65534; fork cgroup
inheritance, repeated commands, PTY, whole descendant cleanup and capacity reuse
all passed. Synthetic units/slices were cleaned; shared directory permissions
and existing services were not changed.

## Implementation decisions

- Each Host and Server inbox has its own managed SQLite file and dedicated
  Worker. Native session identity remains durable after outbox acknowledgement.
- 64 MiB is the default spool admission threshold, not an active-output truncation
  limit. Stop, close and interaction replies remain admissible while full.
- Bridge code is a self-contained SHA-256-pinned bundle in an immutable generation.
  Terminal release keeps a Thread identity tombstone; idle suspension is not
  represented as terminal release.
- After Host crash, generations with retained Thread bindings stay fenced until
  a provider can prove native recovery. P1b never starts a replacement native
  writer for those bindings or replays an uncertain mutation.

Native provider-specific proof reconciliation, production provider smoke and
existing client consumption belong to subsequent opt-in integration phases.
This foundation does not claim those paths are implemented or deployed.

## Independent review

The first independent review found three issues: EOF could poison the callback
queue; storage failure did not stop execution; draining omitted streams/queued
input facets. All three were accepted and fixed with regression cases. Storage close also
seals new calls synchronously while draining previously accepted messages; its
regression verifies writer release and safe reopen. Incremental
review passed with no new P0/P1 findings; the reviewer independently reran all
57 agent-bridge tests and the Host typecheck on the final staged source.
