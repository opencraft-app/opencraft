## goal
Ensure OpenCraft-owned Web controls and content never expose a browser-default focus outline, while retaining visible, theme-owned keyboard focus.

## non_goals
- Do not suppress keyboard focus or change focus ownership inside third-party iframes/browser chrome.
- Only switch the running preview with explicit user authorization and a verified rollback.

## requirement_refs
- User request, 2026-10-02: constrain the repository and converge existing browser-default focus outlines.
- Screenshot: a blue rectangle around a Markdown table in mobile Web.

## interface_refs
- `opencraft/packages/design-system/src/controls.web.scss`
- `opencraft/packages/chat-render-web/src/renderers/table/table-renderer.tsx`

## history_context
- The table wrapper had an unnecessary `tabIndex={-1}`. The horizontally scrollable element can also receive browser focus without an explicit `tabIndex`.
- Existing Web controls use theme focus tokens, but without a global authored fallback some focusable native elements can still show UA rings.
- The first candidate (build `20261002033558-65d3686e3d67`) incorrectly treated all `:focus-visible` as keyboard focus. iPhone touch and dialog auto-focus visibly triggered bright rings on a table, close button, and Composer. User screenshots disproved the initial visual assumption; preview was rolled back to `20261002013722-8155eebec676`.
- The second candidate (`20261002042549-c0564c977ddf`) removed most rings on the user's iPhone, but the Table preview close button still showed one. Dialog `showModal()` auto-focuses that button; its opening pointer intent needs to survive any synthetic input-mode change until keyboard navigation starts.
- A horizontal audit found the same native `showModal()` auto-focus pattern in Image and Mermaid previews, plus feature-owned `:focus-visible` outlines/shadows and container-owned `:focus-within` rings that outrank the low-specificity UA reset.

## acceptance
- Browser-default outlines are neutralized for owned focusable DOM, including browser-focusable overflow containers; the theme-owned fallback is gated by actual input modality as well as `:focus-visible`.
- Component-specific focus treatment remains authoritative, with forced-colors visibility.
- The Markdown table no longer creates an unnecessary focus target; copy/expand buttons remain keyboard reachable.
- Tests and Web build pass; mobile screenshot is separately verified when a browser with rendering dependencies is available.

## affected_paths
- `opencraft/packages/design-system/`, `opencraft/packages/chat-render-web/`, `opencraft/apps/workbench-web/`, `opencraft/AGENTS.md`, `opencraft/design/invariants.md`, `opencraft/tests/`.

## required_context
- Root and OpenCraft `AGENTS.md`; OpenCraft maintenance skill and verification reference; relevant focus/control source.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Repo boundaries | Task pack and release boundary |
| `opencraft/AGENTS.md` | OpenCraft scope | Design-system ownership |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UX maintenance | Focus must remain usable |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Validation | DOM/rendered proof |

## evidence
- First candidate tests passed but mobile visual verification failed; this demonstrates the old tests were insufficient.
- The previous preview was restored under `opencraft-focus-20261002-rollback.service`, PID 1341467, build `20261002013722-8155eebec676`; port 80 and root HTTP were checked.
- Revised source now separates pointer modality from `:focus-visible`, resets UA outlines on auto-focusable scroll containers, and gives the table scroller a keyboard-only authored indicator.
- Chromium mobile-touch fixture using the compiled Design System and table CSS: tapped input retained `:focus-visible` but computed outline was `none`; dialog auto-focused close button had no outline; focused table scroller had neither outline nor ring; hardware Tab restored a solid authored focus outline. This proves the pointer-mode gate in a real browser, not iOS Safari.
- The same fixture loaded the packaged release CSS (including the actual Composer selector): tapped input and Composer both had `focusVisible: true` yet computed `outline: none`; close button and table scroller had no outline; keyboard Tab restored a solid ring.
- Revised focused tests: 23/23 passed; Workbench Web typecheck passed.
- Revised package `20261002042549-c0564c977ddf` started on isolated loopback port 8095; `/version.json` and `/` returned successfully. Its bundled `runtime/server.mjs` SHA-256 matches the safe currently running package exactly; only Web presentation changed.
- User's second iPhone screenshot is the acceptance counterexample: the Table preview close button retained a blue focus ring. The third source revision records pointer vs keyboard activation on this dialog and suppresses only the auto-focused close ring until Tab navigation. A browser fixture forced `:focus-visible` on the close button while global touch mode was cleared and confirmed `outline: none`; Tab inside the dialog restored a solid focus ring.
- Follow-up revision shares the native-preview opening-origin state across Table, Image and Mermaid, with a Design System rule for pointer-opened dialogs. Touch mode now overrides later component-specific focus outlines/shadows; focus-within rings on owned search and connector shells are keyboard-gated. A source audit found no fourth native `showModal()` preview or other plain `:focus` outline owner in the audited Workbench Web and chat-render styles.
- Focus tests passed (4/4); Workbench Web and chat-render-web typechecks passed; Web release build and headless package passed. Chromium mobile-touch fixture loaded CSS from the actual candidate package and observed no outline or shadow on touched input/Composer/search shell, no outline on a pointer-opened dialog's forced `:focus-visible` close button even after global touch mode cleared, and a solid themed ring after Tab. This is Chromium evidence, not iOS Safari verification.
- Candidate package `/data/opencraft-focus-audit-C5YKF9/opencraft-server` build `20261002055636-44d8c862a89d` passed isolated loopback `/version.json` and root HTTP checks. Candidate and previous runtime/server.mjs SHA-256 both equal `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`.
- Independent switch task completed successfully. Current port 80 owner is `opencraft-focus-audit-20261002-preview.service` PID `1674217`, working directory the candidate package; `/version.json` reports its build ID. No rollback occurred.
- A further plugin audit found `:focus-within` outline on embedded Agent Console options and focus glows in the upstream agent-config styles. OpenCraft's `agent-console.css` adapter now suppresses those touch-only visual rings without editing upstream files; keyboard styling remains. The packaged CSS was tested in Chromium mobile-touch mode, including tapped Agent Console option and legacy input shell, alongside the Workbench controls and Table dialog checks.
- Final candidate `/data/opencraft-focus-plugin-audit-PIa7Hc/opencraft-server` build `20261002064728-5f0da200e6d1` passed packaging, isolated loopback `/version.json` and root HTTP, and the browser CSS fixture. Its runtime/server.mjs SHA-256 remains `775d26c525045d584a6f3685535aaff3d86d840e14989ab36e37af1d8a62258a`. The independent switch succeeded; port 80 is now `opencraft-focus-plugin-audit-20261002-preview.service` PID `1765039`, active with expected working directory and build ID; root HTTP is 200. The prior audited package is retained for rollback.

## risks
- A broad outline reset can hide keyboard focus if the authored fallback is absent or overridden. In particular, component-specific focus styles require review on touch and forced-colors.
- The current worktree has unrelated user changes; preserve them.

## validation
- First candidate: focused tests, affected typecheck, Web build, Web release tests, headless tests and platform boundary check passed, but phone screenshots failed. Revised candidate has focused tests, Web build/boundary checks, isolated package smoke, and Chromium mobile-touch rendered evidence using the release CSS; real iPhone remains a separate acceptance step.
- Change-impact guard with explicit changed paths reports `agent-gateway-runtime` because its rule matches the whole Web stylesheet. This focus-only change does not alter gateway semantics; no unrelated gateway design document was edited merely to satisfy that broad rule.

## decisions
- The Web design system owns the fallback focus ring. Feature CSS can override it with a deliberate theme-owned style.

## handoff
- First preview candidate was reverted after the user's phone screenshots. The plugin-audited candidate is now running on port 80 and keeps the prior package for rollback. iOS Safari confirmation remains outstanding, especially native Image/Mermaid previews, pointer-opened Table preview and embedded Agent Console controls; do not claim phone visual acceptance from Chromium alone.
