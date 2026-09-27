## goal
Publish the verified OpenCraft image-attachment Web implementation to the existing headless `opencraft-server` on this machine without bundling concurrent unrelated worktree edits.

## non_goals
- Do not change the service's data directory, account state, public-binding policy, systemd unit, DSH/Codex versions, GitOps deployment, or unrelated Worked-for diagnostics.
- Do not claim mobile visual acceptance without a real client observation.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this conversation: “你可以更新了”, following the image-attachment implementation and explicit list of commit/push/runtime replacement as remaining steps.

## interface_refs / data_structure_refs
- `opencraft/scripts/package-headless-linux.mjs`: exact-version Web/Host archive.
- `opencraft/scripts/headless-server.mjs`: static Web, `/appserver` and `/apphost` binding.
- `/etc/systemd/system/opencraft-server.service`: existing runtime entry and data-directory owner; preserve it.
- `/opt/opencraft-server/current`: live release pointer; retain prior release for rollback.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md`, `docs/engineering/domains/release-gitops.md`.
- `relevant_evolution`: existing service runs a headless archive under `/opt/opencraft-server/releases`; root `master` is current with `origin/master` before this update.
- `superseded_refs`: installer is for fresh installs and explicitly refuses an existing unit/current release; it is not the updater.

## acceptance
- A clean source commit containing only image-related changes is pushed to `origin/master`.
- A clean checkout of that commit passes relevant checks and produces a headless archive that passes package smoke.
- The new release is installed immutably, the live pointer changes atomically, and the existing service restarts against its unchanged data directory.
- The local health endpoint, Web build ID and active release path all identify the intended artifact; old release remains available for rollback.

## affected_paths
- Image implementation and related tests/design documents under `opencraft/` and `docs/`.
- Local immutable release directory and `/opt/opencraft-server/current` pointer.

## required_context
- `release-gitops`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/release-gitops.md` | Router must-read | Distinguish source, artifact and live revision |
| `opencraft/AGENTS.md` | Service delivery contract | Require gate, real-client caveat and source/runtime separation |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance skill | Preserve ownership and honest acceptance |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Skill verification route | Check package/runtime boundary |
| `opencraft/docs/build-matrix.md` | Headless artifact authority | Select archive and smoke test |
| `opencraft/scripts/package-headless-linux.mjs` | Package implementation | Confirm exact build inputs and archive output |
| `opencraft/scripts/install-headless-linux.sh` | Fresh-install contract | Avoid applying a refusing installer to a live service |

## evidence
- `npm run gate`: passed in the current checkout before isolation (includes concurrent unrelated source; release archive must come from clean commit).
- Live service initially points to `/opt/opencraft-server/releases/20260926232644-eece21b2400b` and serves port 80 with its existing state directory.
- A separately installed release `20260927001716-7bb36b3addfd` lacked the headless Web/Codex entry despite carrying the Codex runtime; the prior release was restored. Its Web assets contained no `vela.headless-codex`, `OpenCraft Server`, or `/apphost` markers, while an isolated build with the required flags restored them.

## risks
- Restart briefly disconnects WebSocket clients, including this conversation; retain the old release pointer and verify recovery.
- A dirty source build could include unrelated diagnostics; build only from a clean checkout at the image commit.
- A generic `build:web` can produce a healthy headless server with no Codex UI. Reject it at build/package/startup boundaries using explicit release metadata, not a minified-string grep as the durable contract.
- Existing port 80 is unauthenticated public access; this release must not widen that already-existing boundary.

## validation
- Staged diff and docs-impact; clean-checkout type/tests/build; headless package smoke; archive digest and manifest; local health/build ID/release path after restart.

## decisions
- Preserve the existing service unit and state directory, and replace only its immutable release pointer after a clean archive is verified.
- Do not use the fresh installer on the occupied live service.

## scan_scope
- Bounded `opencraft/scripts`, build-matrix and local service/release paths.

## scan_output
- No bulk scan output retained.

## handoff
- Release preparation in progress; no live pointer or process has changed yet.
