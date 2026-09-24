## goal
Keep OpenCraft's Codex Account Pool process alive when a streaming HTTP client disconnects.

## non_goals
- Replay an indeterminate model request or rerun the user's Git clone.
- Change WebUI access policy, Git credentials, or service privileges.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-09-24: Web Codex tasks repeatedly stop after brief execution.

## interface_refs / data_structure_refs
- `opencraft/packages/account-pool-host/src/server.ts`: loopback HTTP response stream and abort lifecycle.
- `opencraft/packages/account-pool-host/src/codex-proxy.ts`: upstream fetch and account affinity.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` Host-side account pooling.
- `relevant_evolution`: persistent Linux headless Host uses the same Account Pool stream bridge.
- `superseded_refs`: none.

## acceptance
- A disconnected streaming client aborts the upstream stream without an uncaught Node `Readable` error.
- The same Account Pool listener answers the next request; no replay occurs.
- Account Pool typecheck, AppServer tests and boundary checks pass; test-server deployment is reported separately from source merge.

## affected_paths
- `opencraft/packages/account-pool-host/src/server.ts`
- `opencraft/tests/account-pool-host.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- No matching context Pack; OpenCraft local Agent entry and maintenance skill apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Service ownership and gates | Scope source and verification |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Runtime-truth workflow | Verify log/Turn evidence before editing |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack contract | Record durable task state |

## evidence
- In the authorized headless test server, two `opencraft-server.service` exits at 19:50:06 and 19:50:31 CST coincided with two interrupted Turns. Both crashes were uncaught `Readable` errors labeled `Account Pool client disconnected`.
- The old `Readable.fromWeb(...).pipe(outgoing)` returned before asynchronous stream failure; the focused regression reproduced that error before the fix and passed afterward.
- The fixed stream is awaited through `pipeline`, and disconnect/error cleanup does not attempt to write to a closed response.
- `test:appserver` passed 206/206, `test:headless-server` 15/15, Account Pool typecheck and boundaries passed. A native Linux archive smoke passed; authorized test-server deployment used build `20260924121018-a05f8ee3eaa8`, then HTTP and Codex AppHost smoke passed with zero recorded restarts. These checks do not prove an unobserved future real-model turn.

## risks
- Streaming outcomes remain indeterminate after disconnect and must not be replayed.
- Logs and tests must not print account credentials or user prompt contents.

## validation
- Focused regression, AppServer suite, Account Pool typecheck, boundaries, headless suite, Linux archive smoke, live health and AppHost smoke.

## decisions
- Fix the server's actual process crash, not the agent's unverified claim that a browser-state message interrupts the task.

## scan_scope
- Account Pool server/proxy, exact interrupted Thread and service journal window.

## scan_output
- Sanitized event types and crash stack only; no decrypted payloads.

## handoff
- Source changes ready for isolated master-branch commit; real sustained Web task behavior awaits user-side retry.
