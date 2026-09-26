# OpenCraft AppHost connection diagnostics

## goal

Make a second-browser conversation restore failure attributable to a specific `/apphost` connection stage without exposing conversation content.

## non_goals

- Do not infer a single-client limit from the generic browser WebSocket error.
- Do not change AppHost/Thread ownership, retry policy, production service, or release state in this task.

## requirement_ids / requirement_refs / requirement_excerpt

- User report, 2026-09-26: another person opens the same conversation at the same address and time and sees “Could not restore this conversation / AppServer transport closed: App Host connection failed”; request to continue investigation.

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`: browser WebSocket failure projection.
- `opencraft/scripts/serve-workbench-web.mjs`: same-origin `/apphost` WebSocket and diagnostic HTTP endpoint.
- Diagnostic attempt ID is per physical connection, not a Thread, credential, or stable Client identity. Only allowlisted event/stage/code/duration/count fields may be logged.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md` (headless Web Host and reconnect), `opencraft/docs/execution-ownership.md` (Client/Hub/Server ownership), `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: existing AppHost lease renewal and heartbeat were implemented before this report; two simultaneous local `/apphost` handshakes and `host/connect` calls succeeded against the running service, so single-client rejection is not established.
- `superseded_refs`: none.

## acceptance

- Browser failure and server upgrade/hello/Host-connect/close events share one per-attempt ID.
- A failure before WebSocket upgrade can be reported over HTTP with a stage and readyState; extra payload fields are rejected and never logged.
- Tests cover two simultaneous sockets, a pre-upgrade browser error, and a stalled handshake.

## affected_paths

- `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`
- `opencraft/scripts/serve-workbench-web.mjs`
- `opencraft/tests/websocket-app-host.test.ts`
- `opencraft/tests/headless-server.test.mjs`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` and `opencraft/AGENTS.md` | Scope and approval boundary | No implicit production replacement |
| `docs/context/domains/agent-gateway-runtime.md` | Runtime route | Keep Host versus gateway evidence distinct |
| `docs/context/domains/site-environment-routing.md` | Public route context | Do not infer proxy behavior from local probe |
| `docs/context/project/upstream-subtrees.md` | Source ownership | mono2 remains source |
| `docs/context/project/services/opencraft.md` | Service checks | Run OpenCraft validation |
| `opencraft/docs/platform-architecture.md` | Current Web Host design | Preserve reconnect ownership |
| `opencraft/docs/execution-ownership.md` | Client/Hub/Server boundary | Attempt ID does not become Thread identity |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | Maintenance verification | Separate mocked tests from live-client proof |

## evidence

- Before change: screenshot error originates in browser `error` event; local simultaneous WebSocket hello and Host connect probes both succeeded; running headless service did not log WebSocket stages.
- Focused diagnostics tests: 13/13 passed (`node --import tsx --test tests/websocket-app-host.test.ts tests/headless-server.test.mjs`).
- Headless-server suite: 19/19 passed. AppServer suite: 232/232 passed. Web TypeScript, platform boundaries, Web build, documentation validation and explicit change-impact check passed. `git diff --check` passed.

## risks

- A reverse proxy can reject WebSocket before the request reaches the headless server; the browser HTTP diagnostic is the only in-process clue if that happens.
- Browser `error` events do not expose an HTTP upgrade status. Diagnostic stage and server log correlation narrow the layer, but do not by themselves prove root cause.
- Public headless mode remains unauthenticated single-user mode; the diagnostic endpoint does not add user authorization.

## validation

- Focused WebSocket and headless tests, OpenCraft typecheck/boundaries/build, change-impact/doc checks, then a real two-client reproduction after an explicitly authorized cutover.

## decisions

- Use a per-connection random ID in `/apphost?attempt=...`; server generates an ID for legacy clients. Avoid URL, IP, origin, raw exception, Thread ID, request frames, and close reason in diagnostics.
- Use a separate allowlisted diagnostic endpoint rather than the existing general runtime-error report, which includes page URL and error stack.

## scan_scope

- `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`, `opencraft/scripts/serve-workbench-web.mjs`, adjacent tests and Web Host design.

## scan_output

- Bounded `rg`/file inspection only; no generated scan artifact.

## handoff

- Source instrumentation is implemented and tests/build pass. It is not live; actual second-client failure still needs an authorized update and correlated reproduction. No commit, push, release or service replacement was performed.
