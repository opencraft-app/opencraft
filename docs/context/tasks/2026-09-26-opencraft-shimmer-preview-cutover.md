## goal
Update the running OpenCraft headless preview with the verified high-contrast working shimmer source and confirm the served release.

## non_goals
- No commit, push, production/GitOps deployment, systemd configuration change, or preview data migration.
- No edits to unrelated concurrent worktree changes.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-09-26: “好 更新预览吧”. External issue reference: unknown.

## interface_refs / data_structure_refs
- `opencraft-server.service` serves `/opt/opencraft-server/current` on port 80, with a private data directory.
- Headless package builder: `opencraft/scripts/package-headless-linux.mjs`; isolated smoke: `opencraft/scripts/smoke-headless-package.mjs`.
- Health: `/__opencraft_health`; served build identity: `/version.json`.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md#headless-linux-server-archive`; `docs/context/tasks/2026-09-26-opencraft-shimmer-contrast.md`.
- `relevant_evolution`: Shimmer color change passed focused tests, three typechecks, boundaries and Web build, but the running preview did not yet contain it.
- `superseded_refs`: none.

## acceptance
- A fresh headless archive from this checkout passes package smoke.
- Its bundled Web CSS includes the new semantic highlight token.
- The existing release remains available, and a health-checked cutover updates the active symlink and running buildId.
- The service returns healthy after restart; any failure rolls back the release pointer.

## affected_paths
- New isolated archive/build output under `/data`.
- New release under `/opt/opencraft-server/releases`, `/opt/opencraft-server/current` symlink, and `opencraft-server.service` restart.

## required_context
- `service-opencraft` from Context Router.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Root authorization and delivery rules | Preview scope |
| `opencraft/AGENTS.md@worktree` | OpenCraft preview rules | Runtime evidence |
| `docs/context/project/services/opencraft.md@worktree` | Router must-read | Service boundary |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Preview maintenance trigger | User continuity and honesty |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Required verification reference | Runtime checks |
| `opencraft/docs/build-matrix.md@worktree` | Headless archive contract | Package and smoke |
| `docs/context/tasks/2026-09-26-opencraft-preview-restart.md@worktree` | Prior preview cutover | Rollback pattern |

## evidence
- Router exact queries `OpenCraft isolated preview build and service cutover` and `opencraft preview` found no route; broader `opencraft workbench` matched `service-opencraft`.
- Initial service active, release `/opt/opencraft-server/releases/20260926054956-409412c8dd8f`, HTTP buildId `20260926054956-409412c8dd8f`, health `ok`.
- The checkout is dirty with unrelated concurrent changes; build identity must be explicit and cannot be called a clean Git revision.
- Fresh archive `/data/opencraft-shimmer-preview-cDH1yB/OpenCraft-server-preview.tar.gz` has buildId `20260926061700-4ff168f72dc8`; isolated `smoke:headless:linux` passed, including DSH/Codex initialization and package manifest verification.
- Its compiled Web CSS contains `--color-text-working-highlight`; release `/opt/opencraft-server/releases/20260926061700-4ff168f72dc8` is staged separately. Current release still points to the old build and service remains active.
- Health-checked rollback script `/data/opencraft-shimmer-preview-cDH1yB/switch-preview.sh` passed `bash -n` and checks current release identity before switching.
- Timer `opencraft-shimmer-cutover-4ff168f72dc8.timer` is scheduled for 2026-09-26 14:22:12 CST, allowing this turn to finish before its WebSocket is interrupted.

## risks
- Restart breaks active WebSocket connections and can interrupt a turn; use a delayed out-of-band cutover with rollback.
- Concurrent releases can race; verify the current release identity again before switching.
- The existing preview is unauthenticated HTTP on port 80; this task does not change that pre-existing configuration.

## validation
- Focused shimmer tests and package smoke; inspect release manifest, bundled CSS, service health and served buildId.

## decisions
- Build a new archive, smoke it in isolation, preserve current release, then switch the symlink only if current identity still matches the observed baseline.

## scan_scope
- Active systemd unit, current release pointer, headless package and smoke scripts, prior cutover receipt.

## scan_output
- Bounded source/docs searches and live service checks in this turn.

## handoff
- Build, isolated smoke, separate release staging and delayed cutover scheduling complete; post-cutover runtime evidence pending.

## checkpoint
### stage
Delayed health-checked cutover scheduled; send the final response before it fires.

### verified
- Archive smoke passed for buildId `20260926061700-4ff168f72dc8`.
- Staged release includes the high-contrast highlight CSS; old release remains active.

### unverified
- New service after restart and user-visible mobile rendering.

### discard
- Direct `/opt` writes from this agent mount namespace are read-only; staging used a systemd one-shot in the manager namespace.

### restore
- Old release: `/opt/opencraft-server/releases/20260926054956-409412c8dd8f`.
- New release: `/opt/opencraft-server/releases/20260926061700-4ff168f72dc8`.
- Existing private data directory remains owned by the same service.

### next_action
- Send user-facing response before restart, then verify health/buildId after reconnect.
