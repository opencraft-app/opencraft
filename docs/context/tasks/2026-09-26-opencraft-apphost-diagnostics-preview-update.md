# OpenCraft AppHost diagnostics preview update

## goal

Replace the running OpenCraft headless preview with the current verified build, preserving its state and retaining an automatic rollback path.

## non_goals

- No Git commit, push, GitOps/production deployment, or systemd unit configuration change.
- No data directory migration or deletion.
- No claim that the second-phone failure's root cause is fixed before reproduction.

## requirement_ids / requirement_refs / requirement_excerpt

- User conversation, 2026-09-26: “可以 更新吧” and “都更新 可以的”. External issue reference: unknown.

## interface_refs / data_structure_refs

- `opencraft-server.service` executes `/opt/opencraft-server/current/bin/opencraft-server` on port 80 with the existing private data directory.
- `scripts/package-headless-linux.mjs` builds the archive; `scripts/smoke-headless-package.mjs` verifies the isolated Web/DSH/Codex artifact.
- Runtime health: `/__opencraft_health`; build identity: `/version.json`.

## history_context

- `current_design_refs`: `opencraft/docs/build-matrix.md#headless-linux-server-archive`, `opencraft/docs/platform-architecture.md`.
- `relevant_evolution`: earlier preview cutovers used a separate release directory and delayed, health-checked symlink switch to keep the conversation deliverable.
- `superseded_refs`: none.

## acceptance

- Fresh archive passes isolated package smoke; bundled build ID differs from the active service.
- Old release and state directory remain intact.
- After cutover, active service is healthy and serves the new build ID; otherwise rollback restores the old symlink and service.

## affected_paths

- Temporary build and cutover scripts in `/data/opencraft-apphost-update-Zd0ef1WR`.
- New release `/opt/opencraft-server/releases/20260926081211-2224a6698459`, current symlink, and existing service restart.

## required_context

- `release-gitops`, `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Authorization and preview boundary | No implicit commit/push |
| `docs/context/domains/release-gitops.md` | Delivery route | Do not call preview GitOps production |
| `docs/context/domains/agent-gateway-runtime.md`, `site-environment-routing.md`, `project/upstream-subtrees.md`, `project/services/opencraft.md` | OpenCraft route | Source and runtime ownership |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Preview maintenance | Separate artifact, runtime and mobile evidence |
| `opencraft/docs/build-matrix.md` | Archive/install contract | Isolated package smoke |
| `docs/context/tasks/2026-09-26-opencraft-preview-restart.md` | Prior cutover pattern | Preserve old release and rollback |

## evidence

- Before update: service active on build `20260926061700-4ff168f72dc8`, current points to same release.
- Fresh archive `/data/opencraft-apphost-update-Zd0ef1WR/OpenCraft-server-preview.tar.gz`, SHA-256 `4b4e24c88dc08505a858ed4998f9fa167d158f2a59ddf05f011981cb35eceda7`, build `20260926081211-2224a6698459`.
- Isolated headless package smoke passed, including DSH and Codex initialization.
- New release staged separately; old service still active before cutover.
- Health-checked cutover script passed `bash -n`; timer `opencraft-apphost-cutover-2224a6698459.timer` is scheduled for 2026-09-26 16:17:16 CST.
- After cutover: `opencraft-apphost-cutover-2224a6698459.service` result `success`/exit 0; `opencraft-server.service` active since 16:17:17 CST, PID 3695075; current symlink and HTTP `/version.json` both identify `20260926081211-2224a6698459`; health reports `ok:true`.
- Live diagnostic logs show two concurrent AppHost sockets (`active:2`) and successful Host connects for both. A later heartbeat timeout and matching browser `socket-error` occurred for one previously ready connection; this does not establish the original second-phone failure cause.

## risks

- Restart interrupts browser WebSockets and potentially in-flight turns. Delayed out-of-band cutover lets the current response finish; service health and build ID gate the switch.
- Dirty worktree includes other user changes, as explicitly acknowledged. Build ID has no clean source revision and must not be described as a single diagnostic-only patch.
- Existing public preview remains unauthenticated on port 80; this update does not change exposure.

## validation

- Archive SHA/build identity, isolated package smoke, stage identity, cutover script syntax, then service health/version/symlink after cutover.

## decisions

- Reuse the current checkout as the user requested all current changes. Preserve the previous release and exact data root; do not invoke the installer because it refuses an existing unit and state owner.

## scan_scope

- Current service, symlink, package/install/smoke scripts and build matrix.

## scan_output

- Bounded command output only; no source scan artifact.

## handoff

- Preview update complete and live build identity verified. Real reproduction of the original second-phone conversation restore failure remains pending; no commit, push, GitOps or production change was made.
