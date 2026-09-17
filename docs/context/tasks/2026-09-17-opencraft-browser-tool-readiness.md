---
id: opencraft-browser-tool-readiness
type: task
scope: Make Electron browser tools a verified Thread capability lease and preserve activity-only completed Turns without fabricating a final answer.
triggers: ["browser tool", "UNKNOWN_TOOL", "completed without assistant message"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/browser-appserver/src/dynamic-tools.ts
  - opencraft/packages/workbench-runtime/src/appserver-runtime.ts
  - opencraft/apps/local-agent-host/src/dsh-execution-record.ts
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Fail capability hydration when the Host did not bind the complete browser tool catalog, while allowing a DSH Turn containing visible commentary/tool activity to complete without inventing a final assistant answer.

## non_goals

- Do not add guessed browser-tool aliases.
- Do not promote commentary such as “Let me try…” into a final answer.
- Do not weaken truly empty completed-Turn validation.

## requirement_ids / requirement_refs / requirement_excerpt

- User report, 2026-09-17: repeated unknown browser-tool calls followed by `DSH Turn completed without an assistant message`; verify whether Electron packaging omitted browser tools and fix the lifecycle model.

## interface_refs / data_structure_refs

- AppServer `dynamicTools` is the product declaration.
- `runtime/capabilities/register` creates a connection-owned Thread capability lease and returns the registered definition count.
- DSH `commentary`, tool Items and `final_answer` are distinct presentation facts; Turn completion is not synonymous with final-answer presence.

## history_context

- Codex collects dynamic tools at Thread creation. It models final answer as an optional Turn item and separately tests whether one exists; visible commentary/tool activity remains valid Turn content.
- OpenCraft browser tool code is present in both the Electron renderer build and the signed `/Applications/OpenCraft.app`; the failure is not a packaging omission.

## acceptance

- A Thread does not become resident when fewer tools are registered than declared.
- The three OpenCraft browser tools are counted across namespace/function declarations.
- Commentary plus a failed unknown tool can finish as a completed activity-only Turn without a fabricated final answer.
- A genuinely empty completed Turn still fails closed.

## affected_paths

- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/local-agent-host/src/dsh-execution-record.ts`
- focused runtime/projection tests and Chat architecture documentation.

## required_context

- No Context Pack matched; bounded source trace used OpenCraft Chat/Browser architecture and pinned Codex references.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@worktree` | Local implementation and verification boundary. | Preserve Host/Renderer ownership. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Required OpenCraft maintenance method. | Model capability and Turn lifecycle owners. |
| `opencraft/docs/chat-ui-architecture.md@worktree` | Chat projection authority. | Keep commentary/final/tool semantics distinct. |
| `opencraft/docs/build-matrix.md@worktree` | Electron artifact contract. | Verify packaging closure separately from runtime readiness. |
| `ref/codex/conversations/filter-recommended-plugins-by-version-03649.ts@worktree` | Requested Codex reference. | Confirm dynamic tools are a Thread creation/execution configuration. |
| `ref/codex/lazy/app-initial/has-final-answer.js@worktree` | Requested Codex reference. | Confirm final answer is queried, not required for every completed Turn. |
| `ref/codex/lazy/app-initial/has-displayable-turn-content.js@worktree` | Requested Codex reference. | Confirm tool/commentary activity remains visible content. |

## evidence

- Red evidence captured: activity-only completion was projected as failed, and Workbench exposed no capability-count verifier.
- Electron packaging closure verified: `@opencraft/browser-appserver` is a Workbench dependency; current `dist-electron` and the signed `/Applications/OpenCraft.app` renderer both contain `open_in_vela`, `get_tab_context` and `browser_use`.
- Capability readiness now verifies declared count in Workbench, Host broker and DSH plugin; deferred/partial registration fails hydration instead of silently entering resident state.
- DSH projection now accepts a completed Turn with settled commentary/failed tool activity without inventing `final_answer`; a truly empty completion still fails closed.
- Focused Host/Browser/Chat tests: 45 passing. Complete DSH bridge, AppServer and Chat suites pass; Workbench unit suite passes 259/259 after synchronizing the earlier navigation typography owner assertion.
- Workbench Runtime, Local Agent Host and Web typechecks, platform boundaries, imported HyperNode source lock and Electron build pass.

## risks

- Treating activity-only completion as success must not hide a completely empty provider response.
- Capability count validates binding completeness, not whether a model chooses the canonical tool name.

## validation

- Focused DSH projection and Workbench capability tests, typechecks, DSH source lock, Electron build/package content inspection.

## decisions

- Preserve the existing explicit capability registration seam instead of putting Renderer-owned tools into generic Codex `thread/resume` fields.
- Do not create compatibility aliases for hallucinated tool names.

## scan_scope

- Browser dynamic-tool declaration, Workbench binding hydration, local Host capability bridge, DSH terminal projection, Codex references.

## scan_output

- Bounded exact source trace; no graph extraction used.

## handoff

- Implementation and local build verification complete in the current dirty worktree. The other machine's exact malformed tool name remains unverified without its event log. No commit, push, MR, package install or release was performed.
