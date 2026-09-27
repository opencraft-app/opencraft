## goal
Rebuild and restart the current OpenCraft headless preview so the Codex archive and rename capabilities become visible in the Web client.

## non_goals
- Do not commit, push, or deploy to production/GitOps.
- Do not migrate, delete, or copy the preview's private data directory.
- Do not modify the systemd unit's bind address or authentication mode.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-09-26: “重启预览”. External issue reference: unknown.

## interface_refs / data_structure_refs
- Active `opencraft-server.service` executes `/opt/opencraft-server/current/bin/opencraft-server --host 0.0.0.0 --port 80 --data-dir /var/lib/opencraft-preview-codex-20260923173651 --allow-unauthenticated-public`.
- `/opt/opencraft-server/current` currently points to release `791224baf`; current HTTP buildId is `20260925114240-385dd3f8f717`.
- Package builder `scripts/package-headless-linux.mjs`; isolated archive smoke `scripts/smoke-headless-package.mjs`; health at `/__opencraft_health` and Web build at `/version.json`.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md#headless-linux-server-archive`; `opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`.
- `relevant_evolution`: Source now declares Codex `rename` and `archive`; running release predates both. Previous preview cutovers used a release symlink with health-checked rollback.
- `superseded_refs`: none.

## acceptance
- New archive is built from the current checkout and passes isolated headless smoke, including Codex Host initialize.
- Current release symlink changes only after smoke; old release remains available.
- After restart, service is active, health reports ok, HTTP buildId matches new archive, and Codex initialize advertises rename/archive.
- No preview data directory mutation beyond normal service startup; no production/GitOps change.

## affected_paths
- Preview release directory and `/opt/opencraft-server/current` symlink only; systemd service restart.
- Build output in a new temporary `/data` directory.
- `opencraft/scripts/smoke-headless-package.mjs` now asserts rename/archive in the package smoke.

## required_context
- `service-opencraft` from Context Router.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Root deployment boundary | Authorization and evidence |
| `opencraft/AGENTS.md@worktree` | OpenCraft preview rules | Build/runtime distinction |
| `docs/context/project/services/opencraft.md@worktree` | Router must-read | Service identity |
| `opencraft/docs/build-matrix.md@worktree` | Headless archive contract | Package and smoke |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Preview maintenance skill | Safe cutover |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Required verification reference | Runtime evidence |

## evidence
- Router query `opencraft headless preview restart` did not match; broader `opencraft workbench` matched `service-opencraft`.
- Before cutover: service active, PID 2622124, HTTP health ok, release symlink `791224baf`, HTTP buildId `20260925114240-385dd3f8f717`.
- Worktree is dirty with other active changes. A prior `check:boundaries` failed on an unrelated concurrent `merge-turns.ts` edit; package and isolated smoke must pass before cutover.
- Built a fresh headless archive at `/data/opencraft-preview-build-pik85B/OpenCraft-server-preview.tar.gz`, buildId `20260926050103-cfaff2d670a4` (sourceRevision null because the worktree is dirty).
- Isolated package smoke passed twice. The second run explicitly asserted Codex Host `rename: true` and `archive: true` during initialize, in addition to manifest, health, DSH, and Codex checks.
- New release extracted and promoted to `/opt/opencraft-server/releases/20260926050103-cfaff2d670a4`; current symlink still points to the old release. The original release remains untouched.
- Direct `/opt` writes from this agent mount namespace fail because `/` is read-only; a systemd transient check confirmed the manager's host mount is writable. Staging used isolated systemd one-shot units, not a filesystem remount.
- Health-checked cutover script is staged at `/data/opencraft-preview-build-pik85B/switch-preview.sh`; `bash -n` passed. The script checks old/new identities, restarts the existing unit, verifies health and buildId, and rolls back on failure.
- Scheduled `opencraft-preview-cutover-cfaff2d670a4.timer` to run the script 30 seconds after scheduling, allowing this turn's final response to reach the client before its WebSocket disconnects.

## risks
- Restart interrupts current WebSocket leases and any in-flight turns; use an out-of-band health-checked cutover with rollback.
- Building from current dirty checkout includes concurrent changes; record the new buildId and smoke result, do not present it as a clean Git revision.
- The existing service listens on unauthenticated `0.0.0.0:80`; this task leaves that pre-existing preview configuration unchanged.

## validation
- Build package with a fresh output path; run `smoke:headless:linux` against it.
- Inspect package manifest/buildId and Codex initialize capability.
- Post-restart service state, health, Web version, and release symlink.

## decisions
- Preserve the current release and data directory; switch only the release symlink after validation and roll back on health failure.

## scan_scope
- Active unit metadata, package/smoke scripts, build matrix, current release pointer and health endpoints.

## scan_output
- Bounded shell inspections in current turn; no saved scan artifact.

## handoff
- Build, isolated smoke, new release staging, and delayed health-checked cutover scheduling complete. Final live health is not yet observed in this turn; inspect the service and timer journal after reconnect.

## checkpoint
### stage
Delayed cutover scheduled; final response should be sent before it fires.

### verified
- New packaged buildId `20260926050103-cfaff2d670a4` passes isolated smoke and Codex rename/archive capability assertions.
- New release is staged; current preview still points to `791224baf` and remains healthy.
- Cutover script syntax and exact target paths were checked.

### unverified
- Post-cutover service health and Web client behavior; scheduled cutover's own health loop will roll back on failure.
- This is a dirty-worktree preview, not a committed source revision or production deployment.

### discard
- Direct `/opt` mutation from this agent namespace is unavailable due to read-only mount; systemd one-shot staging worked in the manager namespace.

### restore
- Old release: `/opt/opencraft-server/releases/791224baf`.
- New release: `/opt/opencraft-server/releases/20260926050103-cfaff2d670a4`.
- Preview data directory: `/var/lib/opencraft-preview-codex-20260923173651`, unchanged by staging.

### next_action
- Send the final response now; after reconnect, verify service health, buildId, and Codex lifecycle capability or inspect the cutover unit journal if it rolled back.
