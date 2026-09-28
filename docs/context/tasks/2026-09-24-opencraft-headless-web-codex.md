## goal
Make the headless OpenCraft Web Workbench expose and run the existing Codex Host alongside DSH, including its account/model UI, and ship both in the Linux amd64 server tar.

## non_goals
- No public unauthenticated listener or multi-tenant account sharing.
- No automatic login, copying a user's Codex auth cache, or paid model request.
- No change to Electron's trusted Main/Preload channel.

## requirement_ids / requirement_refs / requirement_excerpt
- User 2026-09-24: “web版也需要支持codex，是需要的。”
- Previous headless task: `docs/context/tasks/2026-09-23-opencraft-headless-server.md` delivered DSH-only server; this requirement supersedes its Codex exclusion.

## interface_refs / data_structure_refs
- `apps/opencraft-daemon/src/codex-engine-adapter.ts`: existing stdio Codex AppServer and account-pool owner.
- `packages/app-host-server/src/index.ts`, `packages/app-host-client/src/index.ts`, `packages/app-host-protocol/src/index.ts`: lease/generation and logical-client routing.
- `scripts/serve-workbench-web.mjs`: same-origin WebSocket ingress.
- `plugins/builtin-agents/src/index.ts`: existing Codex account Settings view and Host profile.
- Official OpenAI Codex App Server and authentication documentation: device-code login for headless clients; direct Codex WebSocket transport is experimental, so keep Codex stdio behind OpenCraft's private Host boundary.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/build-matrix.md`, `opencraft/docs/execution-ownership.md`.
- `relevant_evolution`: headless tar currently exposes DSH through `/appserver`; Electron uses AppHostServer to reach `local-codex` and its account pool.
- `superseded_refs`: DSH-only first archive contract is no longer sufficient.

## acceptance
- WebUI offers distinct DSH and Codex execution Hosts; selecting Codex reaches an actual Codex AppServer without using the DSH endpoint.
- Web Codex account page can read account state and present a user-initiated device-code flow without exposing credentials to the browser.
- Browser AppHost ingress is loopback-only with same-origin checks and per-client leases; disconnect/reconnect does not create duplicate execution owners.
- Linux tar contains a pinned Linux amd64 Codex CLI and passes archive, real Codex initialize/account-list, browser and restart smoke on the test host.
- Existing desktop and DSH behavior remain intact; no paid inference or real login is performed automatically.

## affected_paths
- `opencraft/scripts/headless-server.mjs`, `serve-workbench-web.mjs`, `package-headless-linux.mjs`, `smoke-headless-package.mjs`.
- `opencraft/apps/workbench-web/src/runtime/`, `opencraft/plugins/builtin-agents/src/`, `opencraft/runtime/codex/`, `opencraft/package.json`, `.gitignore`, docs and tests.

## required_context
- Root Context Router selected `agent-gateway-runtime` for Codex AppServer/model/runtime. One bounded exact search in OpenCraft Daemon, Web runtime, AppHost packages and built-in extension followed reading the Pack.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | root mutation and release boundaries | preserve unrelated dirty state |
| `opencraft/AGENTS.md@working-tree` | Host/Web ownership and verification | maintain platform separation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | mandatory project workflow | state and real-UI acceptance |
| `docs/context/domains/agent-gateway-runtime.md@working-tree` | routed context Pack | runtime/identity authority |
| `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts@working-tree` | Codex Host implementation | reuse stdio and account pool |
| `opencraft/packages/app-host-server/src/index.ts@working-tree` | connection/lease owner | avoid ad hoc multi-client routing |
| `opencraft/packages/app-host-client/src/index.ts@working-tree` | browser client transport seam | reuse AppHost contract |
| `opencraft/docs/build-matrix.md@working-tree` | tar target | keep artifact contract honest |

## evidence
- Official OpenAI App Server docs describe device-code login and mark direct Codex WebSocket mode experimental; existing OpenCraft adapter uses stdio.
- Current local Codex CLI is 0.155.1; npm registry confirms an exact `@openai/codex@0.155.1` with Linux amd64 optional binary.
- Existing headless Web bundle has no Codex Host profile or account page; DSH-only preview is active on the test host.
- Implemented a loopback-only `/apphost` WebSocket bridge to `AppHostServer`, a reconnectable browser port, server-owned `CodexEngineAdapter`, Web Codex Host and account page, and a separately locked exact-version CLI runtime inside the tar.
- Local focused AppHost/Codex tests, source DSH+Codex smoke, and complete `npm run gate` pass. A Linux amd64 build and extracted-package smoke initialized both DSH and Codex and read an empty Codex account list without authentication or model execution.
- Real browser on the remote preview showed both execution nodes, Codex Connected, Codex model selector, and Server Codex Accounts page with device-code-only Add Account action. The first browser test showed a connection error because a restricted WebSocket wrapper lacks static ready-state constants; numeric-state handling and a regression test fixed it.
- Final tar build ID `20260923174956-460956f5efc4`, SHA-256 `8d208ffce554daebe3849da23f80643cbf947f51415861b521d37b2b6e9d473a`; copied local artifact matches remote SHA. The final transient systemd preview is active on loopback port 10000, reusing the prior private data directory. No real login or paid Turn was executed.

## risks
- A WebSocket AppHost bridge must validate Origin/Host and release claims on close; never serialize tokens into browser config or health.
- Model/account UI must bind to the server Codex Host, not the browser device.
- Native CLI package and protocol version may drift; use an exact runtime lock and native Linux smoke.

## validation
- Focused AppHost bridge and Web profile tests; Codex adapter tests; source DSH smoke; Linux archive smoke; browser UI; OpenCraft gate; documentation and change-impact checks.

## decisions
- Reuse OpenCraft AppHostServer and CodexEngineAdapter behind the headless Web gateway rather than exposing Codex's experimental unauthenticated direct WebSocket listener.
- Pin `@openai/codex@0.155.1` to match the currently tested local desktop executable, subject to Linux runtime smoke.

## scan_scope
- `opencraft/apps/opencraft-daemon`, `opencraft/packages/app-host-*`, `opencraft/apps/workbench-web/src/runtime`, `opencraft/plugins/builtin-agents`, `opencraft/scripts`.

## scan_output
- Bounded `rg` findings in `evidence`; no broad reference-tree scan.

## handoff
- Completed for private single-user Web Codex discovery, account UI and transport. No commit, push, public release or production rollout was performed.
- The currently running remote preview has an ephemeral local SSH tunnel at `http://127.0.0.1:10000`. Direct public access and multi-tenant isolation remain out of scope.
- A real user must opt into and complete Codex device-code authentication before paid inference can be verified; this turn intentionally did not do that.
