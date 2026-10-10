## goal
Reduce Codex app-server memory amplification during repeated OpenCraft Thread recovery while preserving subscription, event replay, and active-turn ownership.

## non_goals
- Do not restart or replace the running preview, publish a binary, or change production limits in this task.
- Do not automatically unarchive a user-archived Thread or change another engine's resume protocol.
- Do not claim that the observed 19.5 GB OOM proves a particular Rust allocation leak.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in the current conversation: optimize repeated Codex recovery and stop deterministic failed-resume retries. External issue ID: unknown.

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-session/src/resume-coordinator.ts`: logical View resume state and generation.
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`: one physical stdio subscription per Thread, logical Client fan-out.
- `opencraft/runtime/codex/package.json` and lockfile: packaged Codex version.
- `opencraft/runtime/codex/patches/queue-steer-rust-v0.157.0.patch`: existing optional native queue-steer build patch; not needed for this memory fix.
- `opencraft/docs/execution-ownership.md`: a newly resumed logical Client may claim unanswered server requests only after successful recovery.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/execution-ownership.md`.
- `relevant_evolution`: an earlier physical-subscription grace and Host-side queue are already present; preserve their dirty-worktree changes.
- `superseded_refs`: none.

## acceptance
- A repeatedly resumed already-loaded paginated Thread using `excludeTurns` does not clone persisted turn history solely to build the resume response.
- A deterministic archived/missing Thread error does not enter an automatic retry loop; transport failures remain recoverable.
- Focused session, Host adapter, and pinned Codex package tests pass; active-turn and interaction-owner invariants remain covered.

## affected_paths
- `opencraft/packages/appserver-session/`, relevant Workbench retry caller, Codex adapter, focused tests, `opencraft/runtime/codex/package*.json`, and architecture documentation.

## required_context
- Context router returned no matching Pack. Bounded searches in OpenCraft resume, adapter, and native patch paths were used.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | repo constraints | no deployment or commit without separate approval |
| `opencraft/AGENTS.md` | service boundaries | preserve Client/Host/Server ownership |
| `opencraft/docs/platform-architecture.md` | current physical subscription contract | do not lose events on reconnect |
| `opencraft/docs/execution-ownership.md` | interaction-owner contract | claim pending requests only after successful attach |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | maintenance workflow | model identity and lifecycle before editing |

## evidence
- OOM at 2026-09-30 14:31 CST killed a Codex process with approximately 19.5 GB anonymous RSS.
- In that process generation, 625 `thread/resume` attempts occurred; 456 failed, 455 for one Thread. Error reason was not persisted in the diagnostic event.
- The running `0.156.1` package precedes a pinned `0.157.0` source path that reads only metadata for an already-loaded paginated Thread and avoids full history when `excludeTurns` is set. The `0.157.0` tag was verified at commit `00c972ed5d6ff6499317fd41b7f23605b8e6850d`; stock npm package installed and reports `codex-cli 0.157.0`.
- The current Workbench reconnect loop already stops retrying semantic RPC errors, but another View acquisition could issue a new Resume in the same generation. Session now memoizes the rejection for automatic acquisitions while retaining explicit retry and new-generation recovery.
- Host had a 30-minute subscription grace in addition to Codex's own idle retention; new Host default is 2 minutes, with active-turn, queue, and pending-interaction demand still blocking release.

## risks
- Existing preview still runs `0.156.1` until a separately authorized rebuild/restart. The source changes here are not deployed yet.
- Legacy Threads with `initialTurnsPage` can still require history work on `0.157.0`; this change does not claim to eliminate all native allocations or prove the OOM root cause.
- Skipping physical resume without an atomic replacement subscription would lose events and interaction authority.
- Existing dirty changes in queue and adapter files belong to other work and must be preserved.

## validation
- Session, Workbench runtime, and Daemon TS typechecks passed. 49 focused session/Workbench binding tests, 12 reconnect/Host proxy tests, and 23 Codex adapter tests passed. `codex-cli 0.157.0` launched successfully from the npm runtime. Typography and platform boundary checks, plus `git diff --check`, passed. Rust build/tests unavailable because Cargo is not installed; no native source patch was required.

## decisions
- Use the existing `0.157.0` paginated `excludeTurns` fast path rather than maintaining a second Rust patch. Cache AppServer RPC rejections per Thread and connection generation in the Session owner, while allowing explicit user retry. Retain physical resume/subscribe semantics. Shorten only the demand-free Host subscription grace.

## scan_scope
- OpenCraft appserver session, Workbench recovery caller, Codex adapter, pinned native patch/build path.

## scan_output
- No bulk scan artifacts.

## handoff
- Source implementation and focused verification completed; running preview remains unchanged. No deployment or commit/push. Disk audit during this task found `/` at 99% (about 1.8 GiB free), while `/data` had about 380 GiB free; do not run a large package build before separately addressing root-disk pressure.
