## goal

Make the iOS Bot drawer interruptible and restore fresh horizontal swipes after embedded WebView scrolling.

## non_goals

- Change Bot DOM features, account navigation semantics, Android drawer, or production deployment.

## requirement_ids / requirement_refs / requirement_excerpt

- User report 2026-10-01: a fast reverse swipe loses touch; after scrolling the embedded WebView, a subsequent sideways swipe is not captured. User asked to put research in AGENTS.md and implement.

## interface_refs / data_structure_refs

- `apps/workbench-expo/src/components/mobile-bot-host.ios.tsx` owns Bot shell and packaged WebView.
- `apps/workbench-expo/src/components/interruptible-mobile-drawer.ios.tsx` owns only drawer gesture progress and rendering.
- `apps/workbench-expo/src/runtime/mobile-shell-model.ts` remains the semantic navigation owner.

## history_context

- `current_design_refs`: `opencraft/docs/mobile-shell.md`.
- `relevant_evolution`: installed Gesture Handler 2.32 `ReanimatedDrawerLayout` disables pan while settling and requires 100pt before closing.
- `superseded_refs`: none.

## acceptance

- Drawer can reverse during either spring without a dead interval or jump.
- Embedded WebView vertical scroll remains usable; a new horizontal stroke can operate the drawer.
- Bot runtime remains mounted and account return reveals the same drawer state.
- Expo typecheck, iOS bundle, focused shell tests, and lightweight external Expo manifest check.

## affected_paths

- `opencraft/apps/workbench-expo/src/components/`, `opencraft/apps/workbench-expo/AGENTS.md`, `opencraft/apps/workbench-expo/README.md`, `opencraft/docs/mobile-shell.md`.

## required_context

- Context router returned no pack; bounded exact search was `ReanimatedDrawerLayout`, `Gesture.Native`, and `mobile-bot-host` within OpenCraft. Read root/OpenCraft/Expo AGENTS, mobile shell design, maintenance skill, and Expo preview skill.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | P0 delivery and task rules | Keep commit/push outside this change |
| `opencraft/AGENTS.md` | Mobile rules | Preserve native shell and Expo Go |
| `opencraft/apps/workbench-expo/AGENTS.md` | Expo local rules | Add lasting gesture guidance |
| `opencraft/docs/mobile-shell.md` | Current interaction design | Update drawer ownership and acceptance |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft maintenance method | Keep one progress owner and verify interrupted drag |

## evidence

- `react-native-gesture-handler@2.32.0` drawer source: `.minDistance(drawerOpened ? 100 : 0)` and `.enabled(drawerState !== SETTLING ...)`.
- Software Mansion primary sources are linked in Expo AGENTS.md.
- New drawer has one UI-thread progress, cancels running springs on pan activation, snaps from live progress, and leaves the Bot runtime mounted.

## risks

- WebView internal horizontal controls can compete with full-width drawer pan; check on iPhone and add a deliberate exclusion only if reproduced.
- Gesture relationship with WKWebView's internal scroll view must be confirmed on device; bundle success is not that confirmation.

## validation

- `npm run typecheck --workspace @opencraft/workbench-expo`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- Focused shell tests and external Expo manifest check; no full bundle download for the preview URL.
- The node/npm executable is under `/data/node-v22.20.0-linux-x64/bin` and not on the default shell PATH in this workspace. Direct `node` invocation was used for checks.

## decisions

- Use one local Gesture Handler/Reanimated drawer because installed `ReanimatedDrawerLayout` cannot accept reverse gestures while settling. HeroUI Native remains the controls library; it has no drawer container in the installed version.

## scan_scope

- `opencraft/apps/workbench-expo/src/components`, `opencraft/docs`, `opencraft/node_modules/react-native-gesture-handler/src/components`.

## scan_output

- Bounded search results summarized in evidence.

## handoff

- `tsc --noEmit -p apps/workbench-expo/tsconfig.json`, iOS `export:embed`, `node --test tests/mobile-shell-model.test.mjs`, documentation validator, `git diff --check`, and Cloudflare external iOS manifest check passed. No iPhone gesture run occurred in this environment; device acceptance remains required.
