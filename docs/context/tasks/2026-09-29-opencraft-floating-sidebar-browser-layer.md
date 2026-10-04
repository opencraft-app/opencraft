# Floating sidebar over browser surface

## goal
On a narrow viewport, the transient left sidebar and its outside-dismiss hit surface remain fully above the right browser surface, then reveal the unchanged browser after exit.

## non_goals
- No browser session, Host, routing, or preview-service lifecycle change.
- No change to the right panel's stored open state.

## requirement_refs / acceptance
User screenshot: opening the right panel and then the left sidebar leaves only the top of the left sidebar visible. After the fix, the entire sidebar is visible and interactive; the first outside tap only closes it; the browser becomes interactive after sidebar exit.

## interface_refs / history_context
- `AppShell` owns floating-sidebar presentation and outside dismissal.
- Browser presentation uses a body-level fixed portal, separately from `AppShell`.
- `ref/paseo` mobile panel selection and overlay plane, and `ref/codex` floating sidebar are read-only comparison points, not runtime authority.

## affected_paths
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-sidebar-dock.test.ts`
- `opencraft/scripts/smoke-shared-sidebar.ts`
- `opencraft/design/invariants.md`

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Root task and verification rules | Bounded scope and Task Pack |
| `opencraft/AGENTS.md` | OpenCraft ownership and UI checks | Shell presentation owner |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft maintenance method | Preserve state and verify visible result |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Validation selection | Focused test and browser smoke |
| `opencraft/docs/platform-architecture.md` | Renderer/browser boundary | No browser resource rewrite |
| `opencraft/docs/browser-workbench-architecture.md` | Browser presentation/resource distinction | Preserve browser backing |
| `opencraft/design/README.md`, `opencraft/design/invariants.md` | Workbench UI authority | Update WSP-11 |

## decision / risk
Keep existing independent sidebar/right-panel state. A z-index increase inside the fixed `AppShell` cannot outrank the body-level browser portal because the Shell is its own stacking context. Portal the transient sidebar and outside hit surface together to a body-level Shell overlay host, preserving inherited Shell CSS values and React-owned shared content. Risk: another body-level overlay may need its own higher layer; verify actual browser hit testing and exit behavior, not only CSS values.

## validation / handoff
Focused sidebar test 22/22 and adjacent Shell geometry tests 17/17 passed; Web TypeScript check, platform boundary check, and Vite production build passed. The shared-sidebar browser smoke could not start because this checkout lacks `playwright`; mobile hit testing remains unverified in a real browser. No preview replacement requested or performed.
