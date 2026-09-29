## goal
Increase OpenCraft's active Thinking/working-text shimmer to one 1s left-to-right sweep every 1.5s on Web and Native.

## non_goals
- Change the animation's visual contrast, sidebar status glyph, completed rows, execution state, or currently running service.

## requirement_ids / requirement_refs / requirement_excerpt
- User follow-up, 2026-09-26: “1.5秒扫1秒” and “按这个改改看”. No external PRD.

## interface_refs / data_structure_refs
- `workingShimmerMotion` in `opencraft/packages/design-system/src/tokens.shared.ts` owns the cross-platform cadence.
- Web `CadencedShimmer` and Native `NativeCadencedText` remain presentation-only consumers of active state; reduced-motion and cleanup remain unchanged.

## history_context
- `current_design_refs`: `opencraft/docs/codex-chatui-fidelity.md`, `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: OpenCraft previously mirrored Codex's 600ms first delay, 1s sweep, 4s cycle. User requested a more present cadence after comparing BB's continuous sweep. BB is a local reference, not an execution dependency.
- `superseded_refs`: none.

## acceptance
- First sweep begins after 600ms; subsequent sweeps begin 1.5s apart, each lasts 1s, leaving 0.5s rest with no reverse sweep.
- Web and Native consume one timing contract; inactive/reduced-motion stops animation.
- Focused tests, affected typechecks, Web build, and available visual preview evidence.

## affected_paths
- `opencraft/packages/design-system/src/tokens.shared.ts`
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-expo/src/components/workbench-conversation.tsx`
- `opencraft/tests/workbench-shimmer-motion.test.ts`
- `opencraft/docs/codex-chatui-fidelity.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- mono2 `AGENTS.md`, `opencraft/AGENTS.md`, `service-opencraft` context, OpenCraft maintenance skill and verification checklist.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Root boundaries | Task Pack and change-impact gate |
| `opencraft/AGENTS.md` | Service boundaries | Web/Native UI and preview evidence |
| `docs/context/project/services/opencraft.md` | Router result | Cross-platform Workbench owner |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Animation task | Scope and presentation honesty |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification | Real UI and build separation |
| `opencraft/docs/chat-ui-architecture.md` | Current architecture | Shared tokens, separate renderers |
| `opencraft/docs/codex-chatui-fidelity.md` | Current visual contract | Explicit user-directed cadence divergence |

## evidence
- Initial router query for the exact symbol/cadence was unmatched; simplified `opencraft workbench` matched `service-opencraft`.
- Bounded source search found both Web and Expo `setInterval(sweep, 4_000)` implementations; starting a 1.5s interval at mount would overlap the first 600ms-delayed 1s sweep. Web's remove/re-add-class restart also has same-frame style-recalculation risk.
- Focused shimmer/timeline tests: 64/64 passed. Design-system, Web and Expo typechecks passed; Web release build and platform boundary check passed.
- Isolated Web preview server started, but OpenCraft's browser presentation tool did not return a usable tab or screenshot; no real Web/Native visual acceptance is claimed.
- The change-impact gate mapped renderer code to `agent-gateway-runtime`; the formal design note now records that active-state motion remains presentation-only.
- Final focused tests (2/2), final Web release build, `git diff --check`, and changed-file impact check passed. The impact check flags normal Owner review for `agent-gateway-runtime`.

## risks
- More frequent painting can affect long timelines; inactive/reduced-motion cleanup must hold.
- A local build does not replace the user's current Web or Native client.

## validation
- Focused shimmer and timeline tests; design-system/Web/Expo typechecks; Web build; diff/change-impact checks; available visual preview.

## decisions
- Share cadence through a design-system token. Web uses one CSS cycle with a 1s sweep and 0.5s offscreen hold, avoiding class restart; Native starts its recurring timer only after the first sweep starts. Both preserve single-pass geometry.

## scan_scope
- Web/Expo conversation renderer, design tokens, focused tests, ChatUI design ledger.

## scan_output
- Bounded `rg` and source inspection; no external artifact.

## handoff
- Source and local Web build complete. Current running service and Native client unchanged. Real device/client motion acceptance remains pending.
