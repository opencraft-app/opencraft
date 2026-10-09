## goal
Keep the thinking disclosure clear with a readable, localized status and an appropriate icon.

## non_goals
- Change reasoning content, disclosure state, or other activity headers.
- Translate engine-returned reasoning content.
- Commit, publish, or deploy the fix.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot, 2026-10-09: the red box shows a truncated "Th..." status before a long reasoning preview.
- User follow-up, 2026-10-09: adapt the status label for multiple languages.
- User follow-up, 2026-10-09: replace the small robot icon beside the thinking disclosure.

## interface_refs / data_structure_refs
- `ReasoningBlock` passes localized status and preview to `ActivityDisclosure`.
- `.thread-activity-item__summary` and `__detail` share a flex header.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md#returned-thinking-content`; `opencraft/design/invariants.md`.
- `relevant_evolution`: existing reasoning disclosure smoke already covers live, settled, and narrow layouts.
- `superseded_refs`: none.

## acceptance
- The full localized thinking status fits at desktop and narrow widths in running and completed states.
- A long preview truncates within the header instead.
- Embedded LightVela running and settled labels follow all supported console locales; the standalone catalog stays English/Chinese.
- The reasoning disclosure uses a clear thinking icon in running and settled states.
- Focused browser smoke, Web typecheck, and change impact check pass.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/command-and-review-renderers.tsx`
- `opencraft/tests/fixtures/reasoning-disclosure.tsx`
- `opencraft/tests/fixtures/intl-root.tsx`
- `opencraft/apps/workbench-web/src/i18n/embedded-companion-messages.json`
- `opencraft/tests/thinking-label.test.ts`
- `opencraft/tests/embedded-companion-locales.test.ts`
- `opencraft/scripts/smoke-reasoning-disclosure.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `opencraft/design/invariants.md`
- `docs/engineering/journeys/agent-request-streaming.md`

## required_context
- Context router returned no pack for `opencraft chat thinking activity label clipped`; bounded exact search located `ReasoningBlock` and the shared header CSS.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | repository boundary | authorization and verification |
| `opencraft/AGENTS.md` | service boundary | UI and real component verification |
| `opencraft/docs/chat-ui-architecture.md` | design owner | reasoning header behavior |
| `opencraft/design/invariants.md` | interaction invariants | keep status and preview responsibilities separate |
| `docs/engineering/journeys/agent-request-streaming.md` | mapped formal design | locate the existing returned-thinking presentation contract |
| `opencraft/apps/workbench-web/src/i18n/catalogs.ts` | locale routing | keep embedded translations separate from standalone language options |
| `frontend/src/i18n/locales.json` | console locale registry | cover every host locale, including zh-SG alias |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | maintenance workflow | focused browser evidence |
| `frontend/AGENTS.md`, `frontend/DESIGN.md` | initial host route | established embedded chat boundary |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | initial adjacency check | confirmed the host source is not the rendering owner |

## evidence
- Screenshot and source inspection identify flex shrink on the reasoning status label.
- Web typecheck and localized thinking-label tests passed.
- Browser smoke passed across Codex, Hermes, DSH; light/dark themes; desktop/touch widths. Long preview truncated while the status label fit in running and settled states.
- Existing tool-group ResizeObserver warnings occurred in the older long-tool sequence; the new long-detail step produced none.
- `validate_change_impact.py --staged` passed with a temporary Git index; `validate_documentation.py --format json` passed with zero broken first-party links.
- Multilingual follow-up: `check:i18n`, Web typecheck, and localized status tests passed. Browser smoke passed for five added locales at touch width with full running/settled labels and truncated previews.
- Icon follow-up: replaced the Web reasoning `Bot` glyph with Lucide `Brain`; Web typecheck and the reasoning browser smoke passed, and light/dark screenshots show the new icon.

## risks
- Narrow locales may still consume most of a very small header; the browser smoke checks desktop and mobile widths.

## validation
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npx tsx scripts/smoke-reasoning-disclosure.ts`
- `npm run check:i18n`
- `npx tsx --test tests/thinking-label.test.ts tests/embedded-companion-locales.test.ts`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- Scope the CSS rule to reasoning so other activity summaries retain their existing flex behavior.
- Add five embedded-only translations; keep the standalone language catalog unchanged.
- Use the existing Lucide Brain icon at the current 14px size; avoid adding an icon asset or changing other activity icons.

## scan_scope
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/`, its header CSS, and existing reasoning smoke.

## scan_output
- Bounded `rg` results and source reads in this task.

## handoff
- Fix and focused validation complete in the isolated worktree; user requested a local commit. Remote delivery remains out of scope.
