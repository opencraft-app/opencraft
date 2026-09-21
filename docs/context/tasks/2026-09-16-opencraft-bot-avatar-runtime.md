---
id: 2026-09-16-opencraft-bot-avatar-runtime
type: task
scope: Upgrade the OpenCraft Bot avatar runtime, geometry, effects, materials, and multi-Bot scheduling.
triggers: ["Bot avatar", "animation runtime", "Morph", "multi-Bot choreography"]
owner: skipzhang
authority: task
status: completed
reviewed_at: 2026-09-16
review_due: 2026-10-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Upgrade the existing Bot avatar renderer while preserving Conversation-owned semantic Presence and the Stage-owned source/mirror topology.

## non_goals

- No AppServer animation fields or persisted visual state.
- No copy of reference-derived geometry or third-party visual assets.
- No animation-library migration, audio personality, publishing, or production operation.
- No replacement of the existing Bot chat delivery-status work already present in the dirty tree.

## requirement_ids / requirement_refs / requirement_excerpt

- User objective, 2026-09-16: shared scheduler; separated clock/springs/behavior/Morph; cached measurement; original sampled geometry; shape-aware eyes; bounded material layer; explicit effect lifecycle; active/attentive/ambient multi-Bot rates; reduced-motion and particle limits.

## interface_refs / data_structure_refs

- `plugins/bot-chat/src/bot-avatar-stage-context.tsx`: Stage runtime and pointer ports.
- `plugins/bot-chat/src/bot-avatar-stage.tsx`: unique projection/source owner.
- `plugins/bot-chat/src/bot-avatar.tsx`: SVG facade and DOM projection.
- `plugins/bot-chat/src/bot-avatar-motion.ts`: renderer-only state catalog.
- `packages/bot-conversation/src/model.ts`: semantic Presence authority; unchanged.

## history_context

- `current_design_refs`: `opencraft/docs/bot-chat-motion-ownership.md`, `opencraft/docs/appserver-bot-protocol-v1.md`.
- `relevant_evolution`: the current implementation already moved to one persistent source per participant and flow-owned SVG mirrors.
- `superseded_refs`: reconstructed Grok sources remain bounded reference evidence, not product source authority.

## acceptance

- One scheduler is owned by each mounted Stage and drives every live participant source.
- No per-frame layout read exists in the avatar renderer.
- Shapes share one sample count; eye geometry remains inside the current interpolated outline.
- Every effect follows reset/enter/hold/exit/done and is not an infinite CSS animation.
- Material identity is stable across visual states and adapts to theme without animated blur or glass.
- Active, attentive, ambient, hidden, and reduced-motion scheduling are covered by deterministic tests.
- Focused Bot tests, boundaries, typecheck, and a real browser preview pass.

## affected_paths

- `opencraft/plugins/bot-chat/src/`
- `opencraft/tests/chat-bot-conversation.test.ts`
- `opencraft/docs/bot-chat-motion-ownership.md`

## required_context

- Root and `opencraft/AGENTS.md`.
- `opencraft-maintenance`, `fixing-motion-performance`, `baseline-ui`, and `animate` skills.
- Context router returned no matching pack; bounded exact search found the Bot motion ownership design.

## context_receipt

| File                                                   | Reading reason                               | Use                               |
| ------------------------------------------------------ | -------------------------------------------- | --------------------------------- |
| `AGENTS.md@worktree`                                   | Repository safety and Task Pack requirements | Scope and validation              |
| `opencraft/AGENTS.md@worktree`                         | OpenCraft routing                            | Formal design and test boundary   |
| `opencraft/docs/platform-architecture.md@worktree`     | Renderer/domain ownership                    | Keep animation out of protocol    |
| `opencraft/docs/bot-chat-motion-ownership.md@worktree` | Current avatar authority                     | Preserve Stage/source invariants  |
| `ref/grokbotani@6c27d964`                              | Bounded reference implementation             | Adopt lifecycle/tests, not assets |

## evidence

- Baseline `npm exec tsx -- --test tests/chat-bot-conversation.test.ts`: 20/20 passed.
- Reference `npm test`: passed 39 states, 18 shapes, 14 effects, 1,521 ordered transitions, and 1,800 shape/expression combinations.
- Final `npm run test:chat`: 390/390 passed, including 14 shared-runtime, geometry, effect, material, and scheduling cases.
- `npm run typecheck --workspace @opencraft/plugin-bot-chat`: passed.
- `npm run check:boundaries`: passed.
- `npm run build:web`: passed; 5,453 application modules transformed.
- `scripts/smoke-bot-avatar-runtime.ts`: passed with installed Chrome and bundled Playwright; verified 60/30/8/0Hz behavior, one-shot effects, dark material, <=16 particles, reduced motion, and zero page exceptions.
- `validate_documentation.py`: passed with no broken first-party links.
- `validate_change_impact.py` over the explicit task change set: passed; `agent-gateway-runtime` formal design updated.
- Full workspace typecheck is not task-green because the pre-existing dirty Hermes group-conversation file calls `.unref()` on browser numeric timers. The affected Bot Chat workspace is green and this task did not edit that file.

## risks

- Existing dirty Bot Chat styles may overlap. Apply narrow patches and preserve current delivery-status changes.
- SVG path updates paint. Only live visible sources may update; ambient sources are rate-limited.
- Exact reference geometry is not licensable from the reference README. Generate OpenCraft-owned parametric rings.

## validation

- `npm exec tsx -- --test tests/chat-bot-conversation.test.ts`
- `npm exec tsx -- --test tests/chat-bot-avatar-runtime.test.ts`
- `npm run check:boundaries`
- `npm run typecheck`
- Browser preview with active, attentive, ambient, hidden, dark theme, and reduced-motion cases.

## decisions

- Keep React as lifecycle facade and imperative SVG writes below it; do not add Motion/Framer to this renderer.
- Use one Stage scheduler and one live source per participant.
- Use static theme-aware gradients and edge highlights only; no rainbow glass or animated blur.

## scan_scope

- `opencraft/plugins/bot-chat/src/`
- `opencraft/packages/bot-conversation/src/model.ts`
- `opencraft/tests/chat-bot-conversation.test.ts`
- `ref/grokbotani/component/runtime/`

## scan_output

- `ref/grokbotani/opencraft-analysis/`

## handoff

- Implementation and scoped verification are complete. No commit, push, publish, or production operation was requested or performed.
