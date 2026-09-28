## goal
Make the conversation identity icon sit as compactly after Back/Forward as the mobile navigation actions sit beside one another.

## non_goals
- Change the action order, click targets, desktop geometry, or running service.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and request, 2026-09-25: the icon before the conversation title is too far from the Back/Forward buttons.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/components/app-shell-header.tsx`: persistent action rail and context are siblings.
- `opencraft/apps/workbench-web/src/styles/app.scss`: rail measures its own padding; context owns the additional title inset.

## history_context
- `current_design_refs`: `opencraft/docs/workbench-design-language.md`, `opencraft/design/invariants.md` WSP-25.
- `relevant_evolution`: the hidden-Sidebar Write action is already part of the measured rail.
- `superseded_refs`: none.

## acceptance
- At viewport widths up to 620px, the title context has no extra left inset; action rail dimensions and wider layouts remain unchanged.
- Header-focused tests, Web typecheck/build, and a mobile-width rendering check.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-timeline-host.test.ts`
- `opencraft/docs/workbench-design-language.md`

## required_context
- mono2 root `AGENTS.md`, OpenCraft `AGENTS.md`, OpenCraft maintenance skill and verification checklist.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Repo boundary | Task and verification requirements |
| `opencraft/AGENTS.md` | Service boundary | Shell and live-preview requirements |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UI/layout task | Scope and ownership |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | UI verification | Evidence layers |
| `docs/context/project/services/frontend.md` | Router result | Confirmed unrelated LightVela frontend |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Router adjacency | Confirmed no frontend runtime/i18n neighbor |

## evidence
- User screenshot shows four 28px chrome actions followed by a 24px identity icon with a larger final interval.
- Source: rail `gap: 4px`, trailing padding `8px`, and context desktop `padding-left: 14px`.
- Focused Header tests: 76/76 passed. Web TypeScript check and release build passed.
- Local release preview started on loopback, but the browser inspection bridge could not access its tab; no narrow-screen DOM/screenshot evidence was obtained.

## risks
- Narrow route headers share the context slot; preserve their internal padding and action hit targets.
- Source changes will not appear in the currently running client until a separately authorized replacement.

## validation
- Focused Header tests, Web typecheck and release build, change-impact check, narrow viewport rendering.

## decisions
- Remove only the duplicate context inset under 620px. Keep the rail owner and wider layout untouched.

## scan_scope
- `opencraft/apps/workbench-web/src/components/app-shell-header.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-timeline-host.test.ts`

## scan_output
- Bounded `rg` and source inspection; no external artifact.

## handoff
- Source and local build verified. Running user service not replaced. Narrow-screen visual acceptance remains pending.
