---
id: reasoning-markdown
type: task
scope: Render actual returned thinking as Markdown inside its existing disclosure on Web and Native.
triggers: ["reasoning markdown", "思考 Markdown", "thinking document rendering"]
owner: skipzhang
authority: derived
source_of_truth: ["opencraft/docs/chat-ui-architecture.md", "opencraft/design/invariants.md"]
status: retired
reviewed_at: 2026-10-08
review_due: 2027-01-06
revision: 1.0.0
precedence: task
derived: true
---

## goal
Use the existing shared document pipeline for expanded returned thinking; show a plain readable one-line header without Markdown control syntax.

## non_goals
No engine requests, hidden reasoning recovery, disclosure defaults/identity changes, desktop work or live preview publication. Subsequent user request explicitly authorizes commit, push and mono2 master integration.

## requirement_ids / requirement_refs / requirement_excerpt
External ID unknown. User: “思考好像没支持md渲染？” followed by “搞起来。” Source delivery subsequently authorized by “提交，推送，盒入master”.

## interface_refs / data_structure_refs
`chat-core/src/reasoning.ts` selects exactly one actual source; `chat-document` owns assistant Markdown parsing and text projection. Web `ReasoningBlock` and Expo `ReasoningBlock` consume their existing document renderer and Host resource context. Item identity, outer work ownership and explicit inner choices remain unchanged.

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md#returned-thinking-content`, `docs/engineering/journeys/agent-request-streaming.md`.
- relevant_evolution: previous work-container fix nested thinking/tools with separate inner controls; Markdown body remained raw text.
- superseded_refs: none.

## acceptance
- Body renders emphasis, lists, inline/fenced code and links using the normal document policy on both platforms.
- Header contains visible text, not formatting delimiters or link destinations; literal escaped punctuation and identifiers remain readable.
- Streaming and completion retain explicit folding choices; thinking does not escape the outer work fold or gain tool content.
- Resource opening/measurement and safe HTML/link policy use existing authority, not new local handlers.

## affected_paths
`opencraft/packages/chat-document`, `opencraft/packages/chat-core`, Web/Expo reasoning renderers, focused tests/browser fixture, shared design and mapped engineering journey.

## required_context
Root/OpenCraft AGENTS, maintenance skill and verification reference, frontend-runtime-openspec-i18n adjacency, task/checkpoint templates, current ChatUI design.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | authority/verification | source-only scope, shared semantics, real UI evidence |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | maintenance scope | focused tests plus isolated real browser |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | bounded adjacent search | shared document/compiler tests and Native renderer seam |
| `docs/context/tasks/TASK-TEMPLATE.md`, `CHECKPOINT-TEMPLATE.md` | task state | explicit acceptance and handoff |
| `opencraft/docs/chat-ui-architecture.md#returned-thinking-content` | current design | stable identity, source precedence, initially folded |
| `docs/engineering/journeys/agent-request-streaming.md` | mapped formal knowledge | update lasting returned-content contract |

## evidence
- Router query `opencraft reasoning markdown rendering 思考摘要 Markdown`: no matching pack; bounded source search confirmed raw Web paragraph and Native Text body.
- Source baseline: clean branch `fix/opencraft-reasoning-work-container-20261008`, HEAD `5adb049a1f`.
- Implemented shared AST-to-visible-text projection with literal/escape/code preservation, unchanged selected body and one-way Core → platform-free document dependency.
- Shared document/core tests: 125 passed; production Native document/prose/code/link with only platform seams: 5 passed. Final Chat suite: 595 passed.
- Affected Core/document/Web/Expo typechecks, Web release build and Expo Web export passed. Full gate reached the independently known SSH `pin: false` expectation failure; it is not green.
- iOS bundling is blocked by the checkout's missing generated `mobile-bot-runtime.html`. Its generator crosses into uninstalled frontend tooling; do not copy another worktree asset or expand this task to frontend setup.
- Browser diagnostics distinguish ordinary thinking/Markdown from unchanged long-tool-group reflow warnings. Do not suppress browser error delivery, broaden scroll ownership or claim the full legacy matrix is warning-free.
- Final browser matrix passed: Codex/Hermes/DSH × light/dark × mouse/touch, including real 390 CSS-pixel phone viewport, rich Markdown, safe HTML/link handling, Host file activation, appended formatted text, completion/outer fold and independent choice restoration. Ordinary thinking/Markdown paths have no ResizeObserver feedback; the separate long-tool-group sequence retains recorded warnings.
- Final Web build, typography/platform boundaries, repository documentation (zero errors/broken first-party links), and mapped staged impact validation through an isolated temporary index passed. The actual Git index and live preview were left unchanged.

## risks
Markdown introduces nested resource controls and asynchronous geometry; use existing Host context and measurement ingress. Plain text projection must preserve escaped literals/code, not strip punctuation with a regular expression. Test seams do not prove iPhone OS acceptance.

## validation
Shared document/core and Native disclosure tests; real Web mouse/touch/light/dark/engine fixtures; affected workspace typechecks; boundaries and Web build. The previous full gate has an independently reproduced unrelated SSH capability expectation failure; do not conceal it or modify that scope.

## decisions
Platform-free document compiler owns Markdown interpretation. Core selects plain header lines from that document projection; body source stays unchanged. Platform renderers own layout and reuse the ordinary document/resource path.

## scan_scope
Chat document/compiler, reasoning presentation and its existing renderer/test neighbors only.

## scan_output
No broad scan or secret output.

## handoff
Source complete and verified within the stated scope. User now authorizes commit/push/master integration; delivery proceeds with scoped staged checks and ordinary fast-forward remote refs, never force push. Current preview still serves the previous work-container build; no preview replacement or Host restart is authorized here. Long-tool-group resize warnings, the unrelated full-gate SSH expectation and absent generated iOS Bot asset remain explicitly outside acceptance claims.

## checkpoint
### stage
Source repository delivery. Long-term Markdown and resource ownership contract updated in ChatUI design and the mapped engineering journey.
### verified
Body now consumes ordinary document renderers with Host policy and stable Item identity. Native real prose/code/link rendering and safe resource policy execute in tests, not a mocked text body. Both platform typechecks and Web/Expo Web builds pass.
### unverified
No iPhone OS acceptance or iOS bundle while the required generated Bot asset is absent. No paid provider calls or deployed preview verification. Full gate is not green because of the unrelated SSH expectation.
### discard
Do not reuse previous work-container results as evidence of Markdown. The attempted disclosure RAF change was reverted: warning diagnostics localized to separate long-tool-group sequences, not a reason to rewrite scrolling for this task. Plain-header HTML block boundaries and Native Node JSX harness setup were corrected by focused tests.
### restore
Use this checkout and current design; leave running Host and Web preview untouched. Pre-delivery remote master is equal to the clean source baseline; any concurrent advance must be reconciled without overwriting it.
### next_action
Commit the scoped Markdown source/docs/tests, push the feature branch and master atomically by fast-forward, and verify both remote refs. Preview delivery remains a separate explicit request.
