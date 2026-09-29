## goal
Expose Codex Host Thread rename through the existing OpenCraft lifecycle contract.

## non_goals
- Do not rename a real user Thread.
- Do not deploy, restart, or replace the running service.
- Do not alter DSH rename ownership or create a second Web title store.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-09-26: “修改会话名称，好像codex 也没有。” External issue reference: unknown.

## interface_refs / data_structure_refs
- `opencraft/thread-lifecycle` v1 `rename` flag gates the Web Thread menu.
- `thread/name/set {threadId,name}` is the native Codex AppServer RPC; `thread/list` and `thread/read` return `thread.name`.
- `ThreadTitleWriter` owns per-Host/Thread optimistic generations and failure handling; Host is the durable name writer.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`; `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: Existing Web menu, title writer, and runtime RPC path support rename; Codex capability omitted it while DSH declared it.
- `superseded_refs`: none.

## acceptance
- Codex initialize response advertises rename for the verified native runtime.
- Logical-client rename request passes through to native AppServer and the catalog/read path reflects its title.
- Focused adapter/title tests, affected typechecks, boundary checks, and documentation impact pass.

## affected_paths
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/tests/codex-engine-adapter.test.ts`
- `opencraft/tests/fixtures/fake-codex-stdio-appserver.mjs`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `service-opencraft` from Context Router (`opencraft workbench`).

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Root Task Pack and change-impact rules | Scope and validation |
| `opencraft/AGENTS.md@worktree` | Host capability boundaries | Capability honesty |
| `docs/context/project/services/opencraft.md@worktree` | Router must-read | Service boundary |
| `opencraft/docs/platform-architecture.md@worktree` | Lifecycle ownership design | Native name authority |
| `docs/engineering/domains/agent-gateway-runtime.md@worktree` | Formal mapped design | Cross-domain note |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | OpenCraft maintenance trigger | Runtime/UI evidence discipline |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Required verification reference | Test selection |

## evidence
- Isolated Codex 0.156.1 probe using a temporary `CODEX_HOME`: `thread/name/set` returned `{}` before and after first Turn; `thread/list` and `thread/read` returned the new name; after AppServer restart, `thread/list` still returned it. Synthetic profile was removed afterward.
- Existing Web `ThreadRowMenu` gates “重命名” on `capabilities.rename`; `ThreadTitleWriter` already serializes optimistic writes; runtime sends `thread/name/set`.
- Adapter/title tests: 18 passed. Daemon, Workbench runtime, and Web typechecks passed. Bot/Host suite: 32 passed.
- Changed-path documentation impact, documentation validation, and scoped `git diff --check` passed. Staged impact check passed with no staged files, so the explicit changed-path check is the working-tree evidence.
- `check:boundaries` currently fails at `packages/appserver-session/src/merge-turns.ts` because a concurrent, unrelated change introduces a `window` parameter name that the renderer-neutral boundary scanner flags. That file was not edited for this task; the prior turn's boundary check passed before this concurrent change appeared.

## risks
- Other user-selected Codex executable versions were not probed; preserve native failures rather than masking them.
- Worktree contains unrelated changes in the same adapter/test/fixture/docs; patch only rename-specific regions.
- The whole-worktree boundary gate is currently red for unrelated concurrent work; do not claim a clean global gate or alter that code in this task.

## validation
- Adapter and title-writer tests; daemon/Workbench typechecks; boundary and Bot/Host checks; context impact.

## decisions
- Codex native AppServer is the durable name owner for Codex Threads; Web only projects and optimistically stages the name.
- Reuse the current lifecycle capability and menu; no duplicate Renderer flag or storage.

## scan_scope
- Codex adapter, AppServer runtime, Web Thread menu/title writer, adjacent tests and native protocol method.

## scan_output
- Bounded `rg` and source excerpts in current turn; no saved scan artifact.

## handoff
- Source implementation and focused verification complete. Current service/Web still run an older release; no deployment or visual live-client verification was performed. Deployment requires separate authorization.

## checkpoint
### stage
Focused implementation and verification complete; handoff pending.

### verified
- Native Codex 0.156.1 persists a synthetic Thread name across AppServer restart.
- Adapter capability and logical-client rename/list/read test pass; affected typechecks and Host/Bot suite pass.
- Documentation and changed-path impact checks pass.

### unverified
- Actual running Web UI still uses the old release; no real user Thread was changed.
- Other Codex executable versions and the unrelated current boundary-gate violation remain unverified for this feature.

### discard
- Do not interpret the unrelated `merge-turns.ts` boundary failure as a rename-adapter regression.

### restore
- Preserve all pre-existing and concurrently appearing worktree changes. The rename additions are in the Codex adapter, fake AppServer fixture, regression test, and two lifecycle design notes.

### next_action
- Hand off source result with the precise boundary-gate caveat and wait for explicit deployment authorization.
