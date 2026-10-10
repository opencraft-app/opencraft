---
id: task-opencraft-runtime-stall-hardening-20261009
type: task
scope: Bound Codex upstream stalls and browser AppHost reconnect pressure without replaying uncertain model requests.
triggers: ["OpenCraft stalled", "Codex thinking", "AppHost reconnect"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/account-pool-host/src/codex-proxy.ts
  - opencraft/packages/account-pool-host/src/server.ts
  - opencraft/packages/workbench-runtime/src/appserver-runtime.ts
status: completed
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.1
precedence: task
derived: false
---

## goal

Keep one slow Codex upstream request or one unreachable AppHost from indefinitely
blocking other conversations, while preserving the no-replay contract for
transport outcomes that may already have reached the provider.

## non_goals

- Retrying an uncertain inference request on another account.
- Changing account affinity, quota, authentication, Thread or Turn ownership.
- Treating a process restart as proof that the underlying upstream is healthy.
- Publishing a new preview package or changing GitOps/production resources.

## requirement_ids / requirement_refs / requirement_excerpt

- RUNTIME-STALL-01: the user reports repeated Web conversations stuck in
  “thinking” and asks for a durable fix.
- RUNTIME-STALL-02: the user explicitly authorizes commit, push and master merge.
- `opencraft/docs/platform-architecture.md`: transport failures and
  indeterminate streaming outcomes are never replayed.

## interface_refs / data_structure_refs

- `CodexAccountPoolProxy.handle(Request)` remains the single credential-routing
  boundary and retains provider Thread affinity.
- `startCodexAccountPoolServer()` owns the loopback response stream and admits a
  bounded number of upstream requests.
- `createAppServerWorkbenchRuntime()` remains the sole automatic reconnect owner.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md` and
  `opencraft/docs/chat-ui-architecture.md`.
- The previous default Undici header timeout was 300 seconds. A failing browser
  AppHost retried at a five-second ceiling, amplifying connection churn.
- A preview-only experiment retried a pre-header timeout on another account.
  That behavior is superseded here because delivery is uncertain.

## acceptance

- Up to sixteen non-pipelined HTTP/1.1 upstream connections can progress
  independently, with a matching server admission bound.
- Response-header wait is bounded to 60 seconds and idle response-body wait to
  180 seconds; failure is surfaced once and never replayed on another account.
- Queue delay, slow headers and transport failures emit content-free diagnostics.
- Automatic AppHost reconnect backs off through 0.5/1/2/5/15/30/60 seconds and
  remains capped at one minute.
- Focused typechecks/tests, boundary checks, documentation/change-impact checks
  and `git diff --check` pass before delivery.

## affected_paths

- `opencraft/packages/account-pool-host/src/codex-proxy.ts`
- `opencraft/packages/account-pool-host/src/server.ts`
- `opencraft/packages/account-pool-host/package.json`
- `opencraft/package-lock.json`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- focused tests, platform architecture and Agent streaming journey documentation

## required_context

- Root and OpenCraft `AGENTS.md`.
- OpenCraft maintenance and self-hosted-preview skills.
- Platform and Chat architecture.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@6e2b77732` | mono2 delivery authority and gates | isolate changes and require explicit push authorization |
| `opencraft/AGENTS.md@6e2b77732` | OpenCraft ownership and validation | choose package tests and runtime evidence |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@6e2b77732` | maintenance workflow | separate source, running preview and external behavior |
| `opencraft/.agents/skills/opencraft-self-hosted-preview/SKILL.md@6e2b77732` | current preview restart safety | preserve package/data and verify the actual unit |
| `opencraft/docs/platform-architecture.md@6e2b77732` | Account Pool/AppHost authority | prohibit uncertain request replay |
| `opencraft/docs/chat-ui-architecture.md@6e2b77732` | recovery semantics | preserve painted state and keep reconnect ownership in runtime |

## evidence

- 2026-10-08 logs showed two `/v1/responses` requests waiting about 300 seconds
  for headers before `UND_ERR_HEADERS_TIMEOUT`.
- 2026-10-09 logs showed an 87.5-second socket failure, repeated AppHost
  handshake/probe timeouts, and an active systemd unit whose HTTP health and root
  requests timed out. Restart restored HTTP 200 and the health response.
- Both affected package typechecks passed. The focused Account Pool suite passed
  24/24 tests; Workbench reconnect and WebSocket AppHost suites passed 13/13.
  Platform boundary, documentation inventory, change-impact and diff checks passed.

## risks

- A provider can still receive work before a transport failure. Mitigation:
  never replay automatically; expose failure to the owning Turn.
- Many independent browser tabs can still reconnect concurrently. Mitigation:
  each runtime backs off to one minute; server request concurrency is bounded.
- The exact synchronous event-loop stall is not proven from post-hoc logs.
  Content-free queue/transport diagnostics preserve stronger evidence for a
  future recurrence.

## validation

- Account Pool and Workbench Runtime package typechecks.
- `tests/account-pool-host.test.ts`.
- `tests/chat-workbench-reconnect-policy.test.ts` and
  `tests/websocket-app-host.test.ts`.
- `npm run check:boundaries`, documentation/change-impact checks and
  `git diff --check`.

## decisions

- Use HTTP/1.1 with sixteen non-pipelined connections instead of HTTP/2 stream
  multiplexing for this proxy.
- Bound waits and surface failure; do not fail over an uncertain inference.
- Keep reconnect policy in Workbench Runtime, not individual pages.

## scan_scope

- Account Pool proxy/server, Workbench reconnect runtime, focused tests and the
  corresponding platform architecture sections.

## scan_output

- Bounded exact searches recorded in this Task Pack; no repository-wide
  generated scan artifact.

## handoff

- Validated source delivery is isolated on `fix/opencraft-runtime-stall-20261009`.
- Running preview recovery and source merge are separate outcomes.
