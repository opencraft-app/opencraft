## goal
Add a repository-owned Linux installer script for the headless OpenCraft tar, deploy it persistently on the user-authorized Linux test host, and serve WebUI and WebSockets directly from `0.0.0.0:80`.

## non_goals
- Do not change the main headless runtime's private default or create a second Web/WS server.
- Do not create a second owner for the existing account data or alter unrelated host services.
- Do not add multi-user authorization, TLS, or an authenticated product gateway in this task; the user explicitly requested an unauthenticated all-address mode.
- No Git commit/push or production rollout.

## requirement_ids / requirement_refs / requirement_excerpt
- User: “你思考一下这个服务如何在这个服务器上常驻，并监听0.0.0.0？”
- User: “搞个安装脚本吧”, “不算主体程序”, “但是，在仓库的 script 文件夹”.
- User clarification: “全放开”, “不需要TLS/访问控制”, “不应该nginx套一层”, “直来直去，搞个8089端口”, “websocket和 webui 静态托管都是这个端口”.
- User continuation: “然后你部署一下，在这台linux上”, “下一步，是修改到80端口”, “好，先部署到80吧”.

## interface_refs / data_structure_refs
- `opencraft/scripts/headless-server.mjs` previously owned a hard-coded `127.0.0.1` listener; its explicit public mode now binds `0.0.0.0`.
- `opencraft/scripts/serve-workbench-web.mjs` keeps matching Host/Origin checks for both private and public modes.
- `opencraft/apps/workbench-web/src/runtime/web-crypto-compat.ts` supplies UUID v4 from `getRandomValues` on non-secure HTTP origins; it does not bypass other browser secure-context requirements.
- `opencraft/scripts/package-headless-linux.mjs` produces one `opencraft-server/` tar root with a file-integrity manifest.
- `opencraft/docs/build-matrix.md` describes the private server archive and loopback-only default.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md`, `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: the user-authorized preview first ran as a transient loopback unit, then as a static direct-8089 unit. The user verified an isolated temporary port-80 probe before requesting the final switch.
- `superseded_refs`: none; the archive's safe default remains loopback-only.

## acceptance
- Script lives in `opencraft/scripts/`, consumes a verified Linux tar, and writes a durable systemd unit that directly binds one `0.0.0.0:80` HTTP/WS server. The unit grants only `CAP_NET_BIND_SERVICE` for ports below 1024.
- It refuses public unauthenticated exposure without an explicit danger flag, occupied ports and existing unit/current-release targets, and leaves the source tar and server state intact.
- Render-only tests verify unit configuration and invalid options without root or server changes; headless runtime tests prove static content and WebSocket use one port with matching Origin.
- A real browser opened the isolated WebUI over a non-loopback HTTP origin and created a new draft without an execution Host.
- The installed service survives a targeted restart, retains four Codex accounts and an existing Thread, and responds through both WebSocket routes from outside the server.

## affected_paths
- `opencraft/scripts/install-headless-linux.sh`, `headless-server.mjs`, `serve-workbench-web.mjs`, `apps/workbench-web/src/runtime/web-crypto-compat.ts`, focused tests, `opencraft/docs/build-matrix.md`, and mapped formal design documentation.

## required_context
- Root Context Router found no Pack; bounded exact search covered the headless launcher, gateway and build matrix.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | authorization, deployment and secrets | no implicit live exposure |
| `opencraft/AGENTS.md@working-tree` | runtime ownership and verification | installer remains outside main code |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | project deployment discipline | distinguish source script from live service |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | platform acceptance | verify source and browser separately |
| `/Users/skipzhang/.codex/skills/research/SKILL.md@working-tree` | decision research | separate repo, external, and assumptions |
| `/Users/skipzhang/.codex/skills/agent-browser/SKILL.md@working-tree` | browser validation | use isolated test origin and clean up |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | task record | preserve explicit acceptance and risks |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md@working-tree` | handoff record | preserve verified/unverified split |
| `opencraft/scripts/headless-server.mjs@working-tree` | bind and data root | keep private default, add explicit public bind |
| `opencraft/scripts/serve-workbench-web.mjs@working-tree` | Host/Origin and WebSocket checks | require matching Origin on one direct public port |
| `opencraft/docs/build-matrix.md@working-tree` | archive contract | installer consumes tar, not desktop package |

## evidence
- The prior launcher bound `127.0.0.1`; public mode now explicitly opens the existing HTTP server on `0.0.0.0`, with static files and both WebSocket routes on the same listener. A direct public WebSocket still requires an Origin matching the incoming Host.
- MDN documents `crypto.randomUUID` as secure-context-only and `crypto.getRandomValues` as available on ordinary HTTP. A non-loopback HTTP browser smoke reached the full WebUI and created a draft through the fallback.
- Official systemd documentation supports `DynamicUser=`, `StateDirectory=` and `ProtectSystem=strict` together. Nginx research was superseded when the user rejected a proxy layer.
- A native Linux amd64 tar (build ID `20260923211700-891f42ec7ba5`, SHA-256 `20a198db5041a5ffabffa440dad3aa26e7956038192f415a1753c3412df024a6`) passed archive/DSH/Codex smoke before installation.
- The static unit was switched from 8089 to 80 after a separate 80-port probe and unit backup. External HTTP health, static HTML, DSH `/appserver` initialize, Codex `/apphost` initialize/account list, and browser restoration of an existing Codex reply all passed. Four account rows remained after restart; only `0.0.0.0:80` was listening for OpenCraft.

## risks
- An unauthenticated `0.0.0.0` listener grants any reachable client the single user's Codex credentials and Host execution capabilities. The danger flag is an acknowledgement, not a security control. Do not deploy to a public network by default.
- The old 8089 unit is backed up under root-only `/var/backups/opencraft`; rollback requires a deliberate unit restore. The four-account data archive was backed up before the initial installation.
- Microphone, modern clipboard and Service Worker features remain restricted by browser secure-context policy on remote HTTP; the UUID fallback does not make the origin secure.

## validation
- `bash -n scripts/install-headless-linux.sh`: passed.
- `npm run test:headless-server`: 14 focused tests passed, including privileged-port capability rendering, direct public Host/Origin, shared WebUI/WS port, installer refusal, and HTTP UUID fallback.
- `npm run typecheck --workspace @opencraft/workbench-web`: passed.
- `npm run build:web:release` and complete `npm run gate`: passed.
- Isolated real browser loaded the built WebUI from a non-loopback HTTP origin and created a new draft; its Host endpoints were disabled, so this was not a real remote-execution test.
- Documentation validation and explicit change-impact mapping: passed.
- Linux native archive smoke, live systemd enable/active/listener checks, external HTTP/WS checks, four-account persistence and browser Thread restore: passed. Full-machine reboot not performed.

## decisions
- Keep the main process private by default, but permit direct all-address binding only with an explicit dangerous-mode flag; retain same-origin checks.
- Require an explicit `--allow-unauthenticated-public` flag and verified archive checksum for the user's requested open mode.

## scan_scope
- `opencraft/scripts/headless-server.mjs`, `serve-workbench-web.mjs`, package and build docs; official systemd references.

## scan_output
- Bounded source and primary-doc evidence summarized above; no credentials or raw account data.

## handoff
- The user-authorized Linux test host now runs the static `opencraft-server.service` on port 80, directly serving the same WebUI and both WebSockets. It is enabled and active with its original four-account state. The temporary port-80 probe is stopped and 8089 is no longer listening.
- The current tar is retained in `/opt/opencraft-artifacts`; the original installation and root-only data/unit backups remain for rollback. No Git commit/push or production rollout occurred. A whole-host reboot was not part of this acceptance.
