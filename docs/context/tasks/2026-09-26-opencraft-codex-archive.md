## goal
Expose Codex Host archive and restore through the existing OpenCraft Thread lifecycle contract.

## non_goals
- Do not archive or restore any real user Thread.
- Do not deploy, restart, or replace the running OpenCraft service.
- Do not add a second Web archive implementation or change DSH semantics.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-09-26: “归档能力codex 也是必要的”. External issue reference: unknown.

## interface_refs / data_structure_refs
- `opencraft/thread-lifecycle` version 1 advertises Host-owned operations; absent flags mean unsupported.
- `thread/archive`, `thread/unarchive`, and `thread/list {archived:true}` are native Codex AppServer RPCs.
- Codex `thread/start` is not durable until its first Turn is accepted; an unmaterialized Thread has no rollout to archive.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`; `docs/engineering/domains/agent-gateway-runtime.md` OpenCraft Thread lifecycle.
- `relevant_evolution`: Web archive menu and Settings management already gate on Host lifecycle capability; DSH declares archive, Codex adapter omitted it.
- `superseded_refs`: none.

## acceptance
- Codex initialize response truthfully advertises archive for the verified native runtime.
- Archive and restore flow through the same logical-client adapter and archived catalog query.
- Focused adapter, Web archive, type, and boundary checks pass; no live data or service mutation.

## affected_paths
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/tests/codex-engine-adapter.test.ts`
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `service-opencraft` from Context Router.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Root boundaries and Task Pack rules | Scope and verification |
| `opencraft/AGENTS.md@worktree` | Host capability and OpenCraft validation rules | Capability honesty |
| `docs/context/project/services/opencraft.md@worktree` | Router must-read | Service boundary |
| `opencraft/docs/platform-architecture.md@worktree` | Current lifecycle design | Ownership and durability |
| `docs/engineering/domains/agent-gateway-runtime.md@worktree` | Formal mapped design | Cross-domain contract |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | OpenCraft architecture task | Verification discipline |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Required verification reference | Client/runtime evidence |

## evidence
- Initial exact Context Router query `opencraft Codex Host archive unarchive thread lifecycle capability Web Settings` had no route; broader `opencraft workbench` routed to `service-opencraft`.
- Isolated Codex 0.156.1 AppServer probe: after `thread/start` and first `turn/start`, `thread/archive` returned `{}`, archived `thread/list` contained the synthetic Thread, and `thread/unarchive` returned it. Probe used a temporary `CODEX_HOME` and removed it afterward. Archive before first Turn returned `no rollout found`, consistent with first-Turn durability.
- Existing Web archive menu and Settings page gate on `capabilities.archive`; runtime already forwards archive/unarchive RPCs.
- New adapter regression proves initialize capability, logical-client archive forwarding, archived list, restore, and active list projection. Focused adapter/Web tests: 17 passed.
- Daemon, Workbench runtime, and Web typechecks passed; boundary check passed; Bot/Host management suite: 32 passed; `git diff --check` passed.
- Explicit changed-path documentation impact passed with `agent-gateway-runtime` owner review advisory. `--staged` check passed with no staged files; it is not evidence of the working-tree diff.
- Repository documentation validation passed with no errors or broken first-party links.

## risks
- Older or swapped native Codex executables could differ; this change is validated against packaged Codex 0.156.1 only. Preserve native RPC failures rather than claiming success.
- Existing worktree contains unrelated modifications in adapter, test, and design files; edit only narrow lifecycle regions.

## validation
- Focused adapter and archived-settings tests.
- Daemon and Workbench runtime typechecks, boundary check, relevant lint.
- Context change-impact check for changed paths.

## decisions
- Use Codex AppServer's native archive state as authority for Codex Threads; keep DSH's OpenCraft catalog authority unchanged.
- Reuse the current Host lifecycle capability and Web flow. Do not add a Renderer-side archive flag.

## scan_scope
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/tests/codex-engine-adapter.test.ts`
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`

## scan_output
- Bounded `rg` and source excerpts in current turn; no saved scan artifact.

## handoff
- Source and focused verification complete. Running service and actual Web client still use the old release; deployment/restart requires separate explicit authorization.

## checkpoint
### stage
Implementation and focused validation complete; awaiting handoff.

### verified
- Codex 0.156.1 native archive/list/unarchive works for a synthetic Thread after its first Turn begins in an isolated `CODEX_HOME`.
- The Host capability is now declared and the existing Web capability gate can expose it.
- Focused tests, affected typechecks, Bot/Host suite, boundaries, and changed-path impact check passed.

### unverified
- No real user Thread was mutated, and the running service/Web were not replaced or visually exercised with this source change.
- Other user-selected Codex executable versions were not probed.

### discard
- Initial pre-Turn archive failure is expected first-Turn durability behavior, not evidence that the native method is unsupported.

### restore
- Preserve unrelated dirty worktree changes, especially concurrent permission-mode work in Codex adapter/test/fixture.
- Review the current working diff before any commit or deployment.

### next_action
- Hand off source result and request explicit deployment authorization if the user wants the running service replaced.
