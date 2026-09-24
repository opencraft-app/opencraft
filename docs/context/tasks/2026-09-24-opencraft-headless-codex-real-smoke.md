## goal
Verify the private headless OpenCraft WebUI can complete a real Codex turn using the user's explicitly authorized local OpenCraft account pool, and repair a discovered proxy-path defect.

## non_goals
- No public listener, multi-tenant account sharing, or production release.
- No copying the Mac's Codex `installation_id` or replacing its original account pool.
- No commit, push, or published Linux artifact without a separate request.

## requirement_ids / requirement_refs / requirement_excerpt
- User: “跑下”; then “codex的”, “你直接从本机拿”, and “有4个之多”. The later request explicitly superseded the previous task's no-credential-transfer/no-paid-smoke boundary for this private test server.
- User: “install_id 问题？这个可能对于可以执行有影响就是了” — evaluate this as a hypothesis, not a proven cause.

## interface_refs / data_structure_refs
- `opencraft/packages/account-pool-host/src/store.ts`: SQLite account metadata and separate 0600 credential files.
- `opencraft/packages/account-pool-host/src/codex-proxy.ts`: synthetic `/v1/*` provider to ChatGPT Codex HTTP routing.
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`: one physical Codex AppServer and account-pool owner.
- The bundled Codex runtime has its own `CODEX_HOME/installation_id`; the proxy preserves the request body and Codex metadata.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md#host-side-provider-account-pooling` and `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: `2026-09-24-opencraft-headless-web-codex.md` implemented the private Web Host but intentionally stopped before real authentication and paid inference.
- `superseded_refs`: that prior no-auth/no-paid-smoke restriction was expressly expanded by the user for this runtime verification.

## acceptance
- Server WebUI lists all four imported accounts without exposing credentials.
- A Codex Host thread receives a model response to a harmless, read-only prompt.
- Focused account-pool tests, typecheck, real Codex AppServer fixture smoke, and OpenCraft gate pass.
- Temporary credential-transfer copies are removed; the private preview remains healthy.

## affected_paths
- `opencraft/packages/account-pool-host/src/codex-proxy.ts`.
- `opencraft/tests/account-pool-host.test.ts`, `opencraft/scripts/smoke-codex-account-pool.ts`.
- `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.

## required_context
- Root Context Router initially matched no pack for the runtime smoke; a later OAuth-specific route selected `identity-access`, whose LightVela scope is unrelated to this OpenAI credential pool.
- OpenCraft local Agent entry and maintenance skill governed private runtime and real-UI verification.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | authorization, secrets, Task Pack, gates | keep transfer private and avoid release claims |
| `opencraft/AGENTS.md@working-tree` | Host ownership and preview rules | preserve separate server and renderer authority |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | runtime acceptance | verify real WebUI and turn |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | relevant gate selection | distinguish mock from paid inference |
| `docs/context/domains/identity-access.md@working-tree` | Context Router result | establish that LightVela auth pack does not own Codex OAuth |
| `opencraft/docs/platform-architecture.md@working-tree` | account-pool contract | keep credentials Host-private |
| `opencraft/packages/account-pool-host/src/codex-proxy.ts@working-tree` | observed 401/429 path | correct exact upstream route |
| `opencraft/tests/account-pool-host.test.ts@working-tree` | regression contract | assert ChatGPT paths and query preservation |

## evidence
- Local OpenCraft pool had four account rows and four corresponding 0600 credential files; the server initially had zero. A restricted SQLite snapshot and matching credential files were copied over an authenticated SSH channel into the server-only data root. WebUI then displayed four accounts. The original local pool was not modified.
- Initial real turns with GPT-6-Astra and GPT-5.6-Luna failed with `429 Too Many Requests`; account state became `authorization-rejected` after requests to the wrong ChatGPT route.
- Source inspection showed the proxy forwarded `/v1/responses` to `/backend-api/codex/v1/responses`; OpenAI's provider base URL and request path require `/backend-api/codex/responses`. The route now removes the synthetic `/v1` and retains query parameters.
- Focused account-pool tests, package typecheck, and a real Codex AppServer fixture smoke passed. A separate server-side bundle preview was started, retaining the old install for rollback.
- After reconnect, a real GPT-5.6-Luna turn returned `OPENCRAFT_CODEX_OK` without tool or file access; the pool recorded one accepted account use. The server's own `installation_id` file exists; none was copied from the Mac.
- Temporary local and remote credential snapshots were removed. The original local pool and the four server-owned accounts remain.

## risks
- Copying OAuth refresh credentials to another machine creates a second credential authority; later refresh rotation could affect one copy. This is a one-time, single-user test import, not a supported sync protocol.
- The running preview combines the previous Linux package's Web/native assets with a newly bundled server entry; the earlier tar is not a newly built release artifact.
- Existing browser tabs may retain a stale AppHost connection after a service restart and require reload; this was observed during verification but not changed here.

## validation
- `npx tsx --test tests/account-pool-host.test.ts`: passed.
- `npm run typecheck --workspace @opencraft/account-pool-host`: passed.
- `npm run smoke:codex-account-pool`: passed using a local synthetic upstream, no external model request.
- Real WebUI account-list and model-turn smoke: passed after the route correction.
- `npm run gate`: passed, including OpenCraft lint/boundary, type, test, Web and Expo build checks.

## decisions
- Correct the explicit ChatGPT upstream path rather than cloning a machine installation ID or treating every 429 as quota exhaustion.
- Keep the remote Codex runtime's own installation identity; account credentials alone were transferred under the user's explicit instruction.

## scan_scope
- `opencraft/packages/account-pool-host`, `opencraft/apps/opencraft-daemon`, `opencraft/tests/account-pool-host.test.ts`, `opencraft/scripts/smoke-codex-account-pool.ts`, and official OpenAI Codex source.

## scan_output
- Bounded searches and sanitized live account counts/status; no tokens, emails, codes, or raw logs included.

## handoff
- Private test server runs the corrected separate preview bundle on the existing loopback tunnel. Four server-side Codex accounts are visible; one real read-only turn completed.
- The original packaged Linux tar is unchanged; a native Linux rebuild is still needed for a distributable artifact. No commit, push, or release occurred.
