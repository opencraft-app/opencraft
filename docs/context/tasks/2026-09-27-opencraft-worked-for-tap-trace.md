## goal
Capture enough bounded mobile-browser evidence to distinguish a lost first `Worked for` click from a click whose disclosure state is later overwritten.

## non_goals
- Do not change disclosure behavior, hit area, or animation before identifying the failure.
- Do not record message text, thread IDs, URLs, pointer coordinates, credentials, or account data.
- Do not commit, push, or publish a production release.

## requirement_ids / requirement_refs / requirement_excerpt
- User report in this conversation: the first tap shows press feedback but does not expand; subsequent tap does. User authorized adding diagnostic records.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers.tsx`: `AgentActivity` derives `open` from `resolveAgentActivityLayout` and submits `onCollapsedChange(open)`.
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/work-status.tsx`: actual disclosure button and pointer/click event boundary.
- `opencraft/scripts/serve-workbench-web.mjs`: existing browser diagnostic receiver.
- `opencraft/packages/chat-core/src/agent-activity.ts`: persisted preference takes precedence over auto-collapse.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`; `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: focused state-table test passes, while the existing component smoke checks only that clicking does not duplicate the label; mobile first-tap behavior remains unverified.
- `superseded_refs`: none.

## acceptance
- A reproduction yields ordered `pointerdown`/`pointerup`/`click`/React commit/settled records or shows exactly which stage is missing.
- Diagnostic records are capped, sanitized, and leave the toggle's state transition unchanged.
- Focused typecheck, relevant tests, and build pass; a live-preview cutover is health checked and reversible.

## affected_paths
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft` (broad OpenCraft route).

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md` | Router must-read | Keep renderer diagnosis separate from Agent authority. |
| `docs/context/domains/site-environment-routing.md` | Router must-read | No production/site change inferred. |
| `docs/context/project/upstream-subtrees.md` | Router must-read | mono2 remains sole write source. |
| `docs/context/project/services/opencraft.md` | Router must-read | Service boundary and validation. |
| `opencraft/AGENTS.md` | Local rules | Preserve ownership and verification. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UI maintenance skill | Observe actual interaction before fixing. |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Skill verification | Use focused UI/runtime checks. |
| `opencraft/docs/chat-ui-architecture.md` | Current design | View-level disclosure does not own Thread history. |
| `docs/context/project/adjacency/README.md` | Adjacency index | No card specifically covers OpenCraft renderer; focused neighboring smoke checked. |

## evidence
- `npm run typecheck --workspace @opencraft/workbench-web`: passed in both working checkout and isolated HEAD-plus-trace checkout.
- `tsx --test tests/workbench-agent-activity-disclosure.test.ts tests/chat-core.test.ts`: 94 passed in working checkout.
- `npm run check:boundaries` and `npm run build:web`: passed in working checkout; `npm run build:web:release` passed in isolated checkout containing only the two trace source files.
- `validate_change_impact.py` with explicit changed files and `validate_documentation.py`: passed.
- Isolated staged release `20260926225820-a993b7122fc1` started on loopback; health, Web version, HTML and diagnostic POST returned 200/202 as expected. Mobile reproduction remains pending.
- First live mobile reproduction produced no trace because the initial instrumentation incorrectly gated on `after-final-answer`; `agent-activity.ts` sets `disableCollapse` for that phase, while the actual `Worked for` header is in the pre-final slot. The gate is now the rendered `layout.showToggle`, and a corrected isolated Web build passed typecheck, 94 focused tests and release build. The first reproduction is not evidence of the product root cause.
- Corrected live preview `20260926230542-bd7eaad685b4` received two touch attempts at 07:13:23–07:13:25 CST. Attempt `edejjx1e-1` produced `pointerdown → pointerup → click → commit(open=true, persistedCollapsed=false) → settled(open=true)`. Attempt `edejjx1e-2` produced `pointerdown → pointerup → settled(open=false, clicked=false)` with no `click` or state commit. This proves at least one first-tap failure occurs before the button's `click` handler; it does not prove which browser gesture or geometry condition suppressed click.
- A repeated sequence at 07:17:19–07:17:21 and 07:17:50–07:17:51 CST shows failed attempts `edejjx1e-5` and `edejjx1e-7` (`pointerdown → pointerup → settled`, no click), each followed by a successful attempt `-6` / `-8` (`click → commit(open=true)`). Both attempts of each pair began `open=false, persistedCollapsed=null`; the first tap did not initialize a hidden disclosure preference. `conversation-viewport-owner.ts` calls `cancelScrollAnimation()` on pointerdown, so scroll-motion interception is a plausible first-tap mechanism, not yet proven without viewport-motion evidence.
- User reports the first tap still fails after waiting for the page to be fully still for two seconds. Treat ongoing scroll inertia as rejected by this manual input, not as the root cause. A follow-up bounded trace will classify pointer travel, scroll change, button position/node stability and any document-captured click target without transmitting coordinates or content.
- Second-stage trace Web build `20260926232644-eece21b2400b` passed isolated typecheck, 94 focused tests, and release build. Its immutable release was staged and started on an isolated loopback port; health and version endpoints returned the expected build, and HTML returned 200. Live mobile reproduction on this build is pending.
- Live preview switched to `20260926232644-eece21b2400b` at 07:31:01 CST. Reports arriving through 07:31:08 still contain only first-stage fields and therefore came from an already-open client bundle; the server does not strip additional trace fields. No trace report appeared after 07:31:30. A hard reload and new reproduction are required to exercise the second-stage instrumentation.
- Fresh mobile run at 07:34:58–07:35:02 CST (`dvgeiads-1` through `-4`) exercised the second-stage bundle. Attempts `-1`, `-2`, and `-3` each had `pointerdown → pointerup → settled(open=false, clicked=false)` with no document-captured `click`; all had `travel=still`, `shift=still`, `hit=button`, `sameButton=true`, `scrollChanged=false`, and `defaultPrevented=false`. Attempt `-4` had the same pointer geometry and then `document-click(hit=button, defaultPrevented=false) → click → commit(open=true) → settled(open=true)`. This rules out pointer movement, scroller movement, button replacement/repositioning, click retargeting, and React state overwrite for these failures. The browser did not deliver a `click` to document capture for three otherwise stable button taps. Exact platform-level click-suppression cause remains unknown.
- Repeated mobile run at 08:04:42–08:04:45 CST reproduces the same pattern on attempts `dvgeiads-10` and `-12`: stationary touch on the same button, no scroll or position change, no default prevention, no document `click`, and no state change after settle. Immediately subsequent attempts `-11` and `-13` received `click` and committed `open=true`. This is not limited to the first run after refresh. Some fast adjacent successful attempts have duplicated document-capture reports from an older still-pending trace listener; those extra reports do not affect the two failed-attempt findings.
- Overlay audit prompted by user objection: a persistent overlay over the toggle is inconsistent with `pointerdown` arriving at that button and `elementFromPoint` reporting the button at `pointerup`. The diagnostic's document-level capture would also log a `click` retargeted onto another same-document overlay; failed attempts have none. The scroll-footer gradient has `pointer-events:none`; the scroll-to-bottom button only enables pointer events when visible; the floating sidebar can intercept only its own occupied region. The scroll owner's pointer/touch listeners are passive and do not prevent default; AppShell's global pointerdown only dismisses the floating sidebar; the composer outside listener only closes its own popup. No application-level window click capture suppressor was found in the inspected source. This does not rule out transient DOM/style changes between events, a touch-event `preventDefault` in an uninspected dependency, or browser/native gesture arbitration. Do not implement a pointerup fallback on the assumption of a browser bug alone.
- Third-stage bounded trace now records final `touchstart`/`touchend`/`touchcancel.defaultPrevented`, window-capture vs document-capture `click`, and post-`pointerup` animation-frame hit category. It also removes the prior attempt's transient listeners when a new tap begins, avoiding duplicate document-click attribution during rapid taps. It does not change toggle semantics or transmit coordinates/content/identifiers. Isolated typecheck and 94 focused tests, release build `20260927001716-7bb36b3addfd`, design-impact and documentation checks passed. The immutable release was staged and launched on an isolated loopback port; health, version, and HTML checks passed. Live mobile evidence is pending.
- The running Web preview advanced to async-question build `20260927044131-36119ed931e2`, which lacks the third-stage trace. The exact two trace source files were merged into that preview's isolated source worktree `/data/opencraft-async-release-UenQKB/repo`, leaving the async-question implementation and unrelated main-checkout edits untouched. Web typecheck, 99 focused activity/chat/async-question tests, `check:boundaries`, full headless package build, and package smoke passed. Merged archive: `/tmp/opencraft-worked-merge-artifact-yBTzVw/OpenCraft-server-merged-linux-amd64.tar.gz`, SHA-256 `d7c7cafbb46e4e737b6fb3172bb24c50bcde59f4911c8503472738c9ba464076`, build ID `20260927050932-832173fd9b7c`. Built JS contains both `post-up-frame` and `questionItemId` markers. The current execution mount namespace exposes `/` read-only, including `/opt/opencraft-server`; attempted staging failed with `Read-only file system` both normally and with escalation. PID 1's namespace still has `/` writable, and no kernel filesystem errors were found. No live cutover occurred in this turn.

## risks
- Updating the live preview interrupts its WebSocket; stage and health-check with rollback, then ask for a fresh tap.
- The trace is temporary; remove it after diagnosis.

## validation
- `npm run typecheck --workspace @opencraft/workbench-web`, focused chat/disclosure tests, Web build and headless smoke.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` at repository root.

## decisions
- Reuse the existing bounded browser diagnostic receiver; emit only fixed enums and booleans with ephemeral attempt correlation.
- Do not change the toggle semantics in this diagnostic pass.

## scan_scope
- Bounded OpenCraft activity renderer, state reducer, diagnostic endpoint, and adjacent smoke.

## scan_output
- No bulk scan output.

## handoff
- The second-stage trace locates the failure between stable touch `pointerup` and arrival of a `click` at document capture; the exact suppressor remains unknown. The third-stage trace has been fused with the async-question preview source and built/validated as `20260927050932-832173fd9b7c`, but cannot be staged or made live from this read-only execution mount namespace. Do not interpret reports from the still-running `20260927044131-36119ed931e2` Web build as third-stage evidence. Once a supported writable preview deployment context is available, verify the expected old build, stage the merged archive as an immutable release, hot-switch Web assets without restarting Host, and health-check version/HTML with rollback. Then ask the user to manually reload the phone tab and reproduce. Inspect final touch `defaultPrevented`, window-capture `click`, and post-up hit category before considering any pointerup fallback. Remove temporary tracing after root cause and fix are verified.
