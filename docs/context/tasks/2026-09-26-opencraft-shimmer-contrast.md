## goal
Make the active Workbench text shimmer visibly high-contrast while preserving its current cadence and readable base text.

## non_goals
- Do not change activity state ownership, shimmer timing, layout, or reduced-motion behavior.
- Do not hard-code white for every theme or modify unrelated loading surfaces.
- Do not restart or replace the running preview without separate verification and cutover work.

## requirement_ids / requirement_refs / requirement_excerpt
- User conversation, 2026-09-26: “扫光 shimm 好像不是白色？或者我换一句 不是对比很强的颜色”. External issue reference: unknown.

## interface_refs / data_structure_refs
- `CadencedShimmer` is the shared Web renderer for active Thinking, activity, review, plan, and approval text.
- Native `NativeCadencedText` mirrors the same readable-base/highlight projection.
- Theme definition `ink` is the high-contrast foreground authority; activity state does not own a color palette.

## history_context
- `current_design_refs`: `opencraft/docs/codex-chatui-fidelity.md`; `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: The preceding change shortened cadence to a 1s sweep every 1.5s, but left Web at 50%-alpha primary text and Native at 72%-opacity primary text.
- `superseded_refs`: none.

## acceptance
- Web shimmer highlight consumes a theme-derived high-contrast ink token, with a primary-text fallback.
- Native shimmer consumes the corresponding opaque theme token; no 50%/72% weakening remains.
- Light themes receive dark ink and dark themes receive light ink; cadence and reduced-motion contracts stay unchanged.
- Focused shimmer tests, Design System/Web/Expo typechecks, boundaries, and documentation impact pass or any unrelated worktree failure is reported precisely.

## affected_paths
- `opencraft/packages/design-system/src/theme-engine.ts`
- `opencraft/packages/design-system/src/tokens.shared.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-expo/src/components/workbench-conversation.tsx`
- `opencraft/tests/workbench-shimmer-motion.test.ts`
- `opencraft/docs/codex-chatui-fidelity.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `service-opencraft` from Context Router.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Root Task Pack/change-impact rules | Scope and validation |
| `opencraft/AGENTS.md@worktree` | Design System and visual verification rules | Shared semantic token |
| `docs/context/project/services/opencraft.md@worktree` | Router must-read | Service boundary |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | OpenCraft visual maintenance trigger | State/visual ownership |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@worktree` | Required verification reference | Evidence selection |
| `opencraft/docs/codex-chatui-fidelity.md@worktree` | Current shimmer design ledger | Expected visual contract |

## evidence
- Exact Context Router query `opencraft shimmer highlight contrast theme token` had no route; broader `opencraft workbench` matched `service-opencraft`.
- Before change, Web uses `color-mix(in srgb, var(--color-text) 50%, transparent)` and Native uses primary text at `opacity: 0.72`; neither is a high-contrast highlight.
- Earlier preview baseline was buildId `20260926050103-cfaff2d670a4`. During verification, another cutover advanced `/opt/opencraft-server/current` to buildId `20260926054956-409412c8dd8f`; its emitted CSS does not contain the new highlight token. Neither release includes this task's color change.
- Theme engine now projects each light/dark palette's opaque `ink` into `--color-text-working-highlight`; Native Codex light/dark tokens expose the corresponding opaque value. The readable base text and motion values are unchanged by this task.
- Focused shimmer, appearance-theme, and theme-material tests passed (13/13); Design System, Web, and Expo typechecks passed; platform boundaries passed; documentation impact and full documentation validation passed.
- Web production build passed and emitted `.is-shimmering__highlight` with `color:var(--color-text-working-highlight,var(--color-text))` in compiled CSS.
- Vela browser inspection did not return a tab list in this environment, so a real mobile/light/dark visual check remains open. This task did not replace the active preview.

## risks
- Literal white would disappear or reverse intent in light themes; derive from each theme's ink instead.
- Worktree contains concurrent unrelated changes, including in the same visual files; patch only the shimmer color regions.

## validation
- Focused `workbench-shimmer-motion` tests and theme-engine tests.
- Design System, Web, and Expo typechecks; `check:boundaries`; scoped diff/documentation checks.
- If practical, inspect a real rendered dark/light sample; do not equate build success with visual acceptance.

## decisions
- Use opaque, theme-owned ink for the moving highlight; keep the underlying active text at its existing semantic tone.
- Expose a semantic `--color-text-working-highlight` on Web and `text.workingHighlight` on Native rather than borrowing a button token.

## scan_scope
- Workbench shimmer renderer/style, Design System theme projection, Native counterpart, focused tests, and visual ledger.

## scan_output
- Bounded `rg` and source excerpts in current turn; no saved scan artifact.

## handoff
- Source implementation and static/build verification complete. A rendered visual check and preview cutover remain separate follow-up work; the currently running preview serves another build without this color change.
