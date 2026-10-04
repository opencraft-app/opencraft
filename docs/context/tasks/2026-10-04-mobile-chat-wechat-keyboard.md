## goal
Keep the domestic mobile Chat composer visible when the iOS WeChat browser scrolls the page after keyboard focus.

## non_goals
- Change composer density, desktop or international Chat, or the sidebar.
- Merge, release, or change production infrastructure.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot from 2026-10-04: after MR !4965 reached production, the iOS WeChat browser still shows only a caret in a blank area above the keyboard.

## interface_refs / data_structure_refs
- `window.visualViewport.pageTop` and `height` locate the visible bottom in page coordinates.
- The difference between the Chat root and body `getBoundingClientRect().top` values locates the Chat root within the page after document pan or scroll.

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md` and `frontend/src/pages/marketing/agent-chat-visual-viewport.ts`.
- `relevant_evolution`: MR !4965 sized the root from visual viewport height and offset alone; its unit test kept the root at viewport top.
- `superseded_refs`: none.

## acceptance
- On a focused mobile Chat, document or visual viewport movement keeps the Chat root bottom at the visible keyboard edge.
- Dismissing the keyboard restores full height; listeners release on unmount.
- The frontend focused test, check, build, and OpenCraft generated-copy check pass.

## affected_paths
- `frontend/src/pages/marketing/agent-chat-visual-viewport.ts`
- `frontend/src/pages/marketing/__tests__/agent-chat-visual-viewport.test.ts`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- The symptom query did not match a Domain Pack. An exact path route matched frontend, site routing, Agent runtime, and OpenCraft Packs.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@HEAD` | Region boundary | Scope to domestic embedded Chat |
| `docs/context/project/services/frontend.md@HEAD` | Frontend owner | Select service gates |
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | Chat boundary | Keep runtime and Composer unchanged |
| `docs/context/project/upstream-subtrees.md@HEAD` | OpenCraft ownership | No generated subtree edits |
| `docs/context/project/services/opencraft.md@HEAD` | Embedded owner | Check existing Composer rendering |
| `frontend/AGENTS.md@HEAD` | Service requirements | Check frontend and generated-copy gates |
| `opencraft/AGENTS.md@HEAD` | Web UI validation | Distinguish browser proof from device proof |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | Adjacent paths | Checked archived OpenSpec and focused test |
| `frontend/openspec/specs/bot.md@HEAD` | Prior console design | Confirmed the embedded Chat is separate |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@HEAD` | Layout procedure | Test actual visible geometry |

## evidence
- The added test first failed: after simulating a 180px page pan, the computed Chat root bottom was 265px while the visible bottom was 445px.
- A second failing case covered WebKit-style visual viewport pan with `scrollTop` unchanged and `pageTop` different from `offsetTop`: the intermediate calculation returned 529px instead of 474px.
- The root sizing now uses page-relative coordinates and listens to document scroll; both cases and keyboard dismissal pass.
- A Chromium layout fixture using the transpiled production helper placed the composer bottom at 445px after a 180px document scroll, matching the simulated keyboard edge at 445px. This fixture did not run the authenticated Chat or iOS WebView.
- [WebKit bug 311821](https://bugs.webkit.org/show_bug.cgi?id=311821) documents body movement without `scrollTop` movement in an iOS WebView; its report also notes that `offsetTop` can diverge from `pageTop`.
- Final focused test passed (1/1); `pnpm check` passed with zero new TypeScript diagnostics; `pnpm build:cn`, OpenCraft generated-copy check, and documentation validation passed.
- Physical WeChat iOS verification remains unavailable locally.

## risks
- WebKit may report a root move without a matching scroll or resize event; validate the focused experience on an iPhone before calling the production symptom resolved.

## validation
- Focused frontend viewport test, `pnpm check`, `pnpm build:cn`.
- Browser geometry proof with a scrolled root and keyboard edge.
- `npm --prefix opencraft run check:mono2-agent-console`.
- Documentation and staged change-impact checks, `git diff --check`.

## decisions
- Measure the Chat root relative to the body and use the visual viewport's page-coordinate bottom, so layout scroll and WebKit visual pan use the same reference frame.

## scan_scope
- Frontend Agent Chat shell and viewport helper, OpenCraft embedded Composer presentation, and adjacent tests.

## scan_output
- The exact symptom route returned no pack; bounded `visualViewport`, keyboard, and Composer searches located the helper and its test.

## handoff
- The follow-up is ready for an MR under the user's earlier authorization to submit this keyboard fix. Real iOS WeChat keyboard behavior remains the acceptance boundary; merge and release are separate.
