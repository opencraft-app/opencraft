## goal
Restore a headless Codex browser session after its `/apphost` WebSocket drops, without reloading the page, and allow the existing HTTPS reverse-proxy entrance to reach the public-mode listener.

## non_goals
- Change the Server-owned Codex process, account pool, or public HTTP policy.
- Add a proxy, TLS, or authentication to this single-user preview.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-09-24: after a short time the deployed Codex session shows `AppServer transport is not open`; automatic retries fail in 7–10 ms with `App Host connection closed`.
- User follow-up, 2026-09-24: remove the public-mode Origin check after the HTTPS proxy returns OpenCraft's `Matching origin required` error.

## interface_refs / data_structure_refs
- `apps/workbench-web/src/runtime/websocket-app-host.ts`: browser WebSocket-to-AppHost transport.
- `scripts/serve-workbench-web.mjs`: loopback-only versus public request admission.
- `packages/app-host-client/src/index.ts`: lease and connection generation semantics.
- `packages/workbench-runtime/src/appserver-runtime.ts`: automatic reconnect calls `client.connect` on its existing transport.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, headless `/apphost` lease contract.
- `relevant_evolution`: initial WebSocket test verifies only that a *new* transport can be created after close, not that the existing Workbench transport can reconnect.
- `superseded_refs`: none.

## acceptance
- A transport object already held by AppServerClient reconnects after its WebSocket closes, with a fresh AppHost lease and working frame send/receive.
- Existing listeners receive the new generation, and closing the transport prevents reconnection.
- The HTTPS proxy Origin is accepted for public HTTP and both WebSocket paths; loopback-only mode still enforces matching Origin.
- Focused tests, Web typecheck, and a fresh browser/runtime smoke pass.

## affected_paths
- `opencraft/apps/workbench-web/src/runtime/websocket-app-host.ts`
- `opencraft/tests/websocket-app-host.test.ts`
- `opencraft/scripts/serve-workbench-web.mjs`
- `opencraft/scripts/headless-server.mjs`
- `opencraft/tests/headless-server.test.mjs`

## required_context
- Router returned no matching pack; OpenCraft local Agent entry and architecture apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Local OpenCraft constraints | Scope and verification |
| `opencraft/docs/platform-architecture.md@working-tree` | AppHost and headless ownership | Preserve the Server-owned lease model |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | Mapped formal design | Record public admission and lease recovery semantics |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack contract | Structure this task |

## evidence
- Deployed service `ActiveState=active`, `NRestarts=0`; Mac-origin `/apphost` handshake returned `ready` and stayed open for 10 seconds.
- Existing reconnect path reuses a failed transport after the browser port closes.
- 2026-09-24: `npm run test:headless-server` passed 14/14, `npm run test:appserver` passed 205/205, Web typecheck and `check:boundaries` passed.
- Linux x64 tar SHA-256 `6ee49d0996855fda6d813e0283e6d6f37d2d01521ab3527810a118fc2e1e27ca`, build ID `20260924071840-bd4608375a9f`; archive smoke passed. The server's `/opt/opencraft-server/current` points to this artifact and systemd reports `ActiveState=active`, `NRestarts=0`.
- Mac-origin HTTPS proxy health with HTTPS Origin returned 200; current index JS returned 200; proxied `/apphost` WebSocket returned `ready`; Codex AppHost initialize/account-list smoke passed; old Codex Thread history was visible in the proxied browser without resubmitting a turn.
- The earlier browser transport-recovery build was observed to log `succeeded` after an intentional systemd restart; no paid model inference was used to validate this change.

## risks
- Replacing a lease must not duplicate listeners or revive a closed transport; test both.
- Public-network WebSocket drops may still occur through the observed forwarding layer; recovery must be verified separately from transport stability.
- Public mode has no authentication or Origin gate by user choice; other sites may initiate browser requests to this server.

## validation
- Focused AppHost test, Web typecheck, relevant package test and a deployed browser smoke check.

## decisions
- Keep one stable Workbench transport object while replacing its failed WebSocket-backed lease; do not recreate Server-owned Codex state from the Renderer.
- Remove public-mode same-origin enforcement; preserve loopback-only enforcement.

## scan_scope
- `opencraft/apps/workbench-web/src/runtime`, `opencraft/packages/app-host-client`, `opencraft/packages/workbench-runtime`, `opencraft/tests`.

## scan_output
- Bounded exact source searches and the targeted test file.

## handoff
- Source, Linux artifact and test-server deployment complete. Current proxy/browser smoke passed. Long-duration HTTPS-proxy idle stability and future credential rotation remain operational follow-ups; no commit or push was made.
