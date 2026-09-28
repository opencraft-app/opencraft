## goal
Ship an independent, single-user Linux amd64 OpenCraft server tar that starts a local Agent Host and serves a functional browser Workbench without Electron.

## non_goals
- No public unauthenticated listener, multi-tenant Hub, cloud deployment, or production rollout.
- No promise of Codex desktop-only controls in the first DSH-backed server slice.
- No change to the existing Electron packaging contract.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation 2026-09-23: “先做独立的服务器启动器和 tar 包”; the intended Linux headless mode must provide a Web UI.

## interface_refs / data_structure_refs
- `apps/local-agent-host/src/main.ts`: `startLocalAgentHost` owns DSH and the loopback AppServer endpoint.
- `scripts/serve-workbench-web.mjs`: static Web + `/appserver` gateway.
- `apps/workbench-web/src/runtime/appserver-runtime-context.tsx`: Web Host bootstrap.
- `config/build-matrix.json`: named artifact contract.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/build-matrix.md`, `opencraft/docs/execution-ownership.md`.
- `relevant_evolution`: existing desktop packages carry a Daemon/DSH/native runtime; Web currently carries only a client and development/debug gateway.
- `superseded_refs`: BB server packaging remains a reference, not an OpenCraft runtime authority.

## acceptance
- A headless command starts without Electron, listens on loopback, serves Workbench assets and reaches the owned DSH AppServer.
- The browser Settings page can configure the actual Server Host's model services without inventing a browser-only model store.
- The Linux amd64 tar contains a launcher, matching runtime and Web assets, and verifies its contents; it cannot be cross-packaged with macOS native modules.
- WebSocket rejects foreign browser origins; public diagnostics do not reveal upstream credentials.
- Focused tests and OpenCraft type/boundary/build checks pass; native Linux smoke is reported separately from macOS-only checks.

## affected_paths
- `opencraft/apps/headless-server/`, `opencraft/scripts/`, `opencraft/apps/workbench-web/`, `opencraft/config/build-matrix.json`, `opencraft/package.json`, `opencraft/docs/`, `opencraft/tests/`, `.github/workflows/` if artifact CI is added.

## required_context
- Context router query `opencraft headless Linux amd64 server tar WebUI DSH Host packaging` matched no Pack; bounded exact search: `headless-linux|server.*tar|serve:web:static|package:electron:linux` in OpenCraft package, matrix, scripts and build docs.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | root boundaries and Task Pack | mutation/release scope |
| `opencraft/AGENTS.md@working-tree` | local platform and verification boundaries | implementation ownership |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | mandatory architecture maintenance guidance | state and runtime acceptance |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | platform verification | focused checks |
| `opencraft/docs/platform-architecture.md@working-tree` | Client/Hub/Server and renderer boundaries | avoid a second authority |
| `opencraft/docs/build-matrix.md@working-tree` | existing delivery targets | add an explicit tar contract |
| `opencraft/apps/local-agent-host/src/main.ts@working-tree` | existing Host owner | reuse local DSH |
| `opencraft/scripts/serve-workbench-web.mjs@working-tree` | static and WebSocket gateway | ingress hardening |
| `opencraft/.github/workflows/build-matrix.yml@working-tree` | downstream artifact CI | native Linux build/smoke job |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | formal domain design | keep source and delivery ownership aligned |

## evidence
- Pre-change Git worktree is dirty with unrelated user changes; preserve every existing edit.
- Current matrix has no headless tar; Electron Linux package contains DSH and daemon resources but its Main always creates a window.
- Current implementation adds a loopback-only Node launcher, same-origin Web Host profile, reused Model Services Web page, Linux tar builder and a CI artifact job. No Electron Main or Preload is bundled into the tar.
- Local `npm run gate` exited 0; focused `test:headless-server`, `test:web-release`, `test:host-connection`, Model Services tests and source DSH smoke exited 0.
- On an isolated Linux x86_64 host, `npm ci`, native tar build and tar-extraction smoke passed. Build ID `20260923164715-3bf74fcee6f2`; local and remote tar SHA-256 matched: `6217fbaf8910708dddb60a324a64d07ed9eef93c50d20ec2efbe0cbd80f6bb33`.
- Extracted archive started under a transient DynamicUser systemd unit with `ProtectSystem=strict`; local-only health, actual DSH initialize/thread list, server restart, browser Chat and Model Services read-only page were verified. No paid inference or real credentials were used.
- An earlier bundle exposed an imported CLI auto-start and two deployment attempts failed on missing HOME/sibling lock path. Those causes were fixed and covered; the unintended test listener was stopped immediately. The two failed preview directories and temporary remote build tree were removed; current successful preview and one earlier successful rollback remain.

## risks
- Native `node-pty` and DSH module ABI require a real Linux amd64 build/smoke.
- Existing gateway exposes upstream target in diagnostics and has no browser Origin check; protect a loopback-only first release.
- Web Host profile and transport identity must not imply the browser device owns the Linux filesystem.

## validation
- Focused launcher/gateway/packager tests, Web Host profile tests, OpenCraft typecheck, boundary check, Web build, build-matrix check, package verification, and Linux runtime smoke when a Linux host is available.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` before handoff if changes are staged.

## decisions
- Single-user DSH-first server archive, loopback by default, no Electron Main dependency. A later desktop `--headless` may invoke this same runtime.

## scan_scope
- `opencraft/apps/local-agent-host`, `opencraft/apps/opencraft-daemon`, `opencraft/apps/workbench-web`, `opencraft/scripts`, `opencraft/config`.

## scan_output
- Bounded `rg` findings summarized in `evidence`; no raw scan artifact.

## handoff
- Source and local ignored tar artifact exist; no commit, push, release or production deployment was performed.
- Active preview is a single-user, loopback-only server accessed through a temporary local SSH tunnel; tunnel lifetime is not a product access solution.
- Real model/provider credentials, paid turn execution, Codex Host parity and public multi-user access remain explicitly unverified/out of scope.
