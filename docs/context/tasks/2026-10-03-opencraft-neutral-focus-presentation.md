## goal
Remove the blue Composer outline and converge owned Web keyboard focus on neutral presentation.

## non_goals
- No commit, publishing, unrelated dirty source rollout or iframe/browser-chrome modification.
- Preview replacement/restart was subsequently authorized by the user on 2026-10-04.
- Do not remove keyboard navigation, caret/selection or forced-colors accessibility.

## requirement_refs
- User, 2026-10-03: “蓝色焦点环，我们完全不需要啊。”

## interface_refs / data_structure_refs
- `opencraft/packages/design-system/src/focus.web.scss`: low-specificity fallback, not a component override.
- `opencraft/packages/design-system/src/theme-engine.ts`: focus is independent of brand accent.
- `opencraft/apps/workbench-web/src/styles/app.scss`: Composer owns its no-outline editor presentation.

## history_context
- current_design_refs: `opencraft/design/invariants.md`, WSP-36.
- relevant_evolution: `2026-10-02-opencraft-owned-focus-presentation.md`; touch origin is already modeled separately from `:focus-visible`.
- Current fallback selector outranks `.codex-composer-editor { outline: none }`; mouse-clicking a contenteditable can match `:focus-visible` in Chromium too.

## acceptance
- Real Composer mouse, Tab and touch focus have no external editor outline.
- Other owned controls retain neutral keyboard focus in light/dark/extended themes; pointer-opened previews remain quiet; forced-colors focus remains visible.
- Focus and theme tests, affected typechecks and browser component smoke pass.

## affected_paths
- OpenCraft Design System focus/theme tokens, Web focus consumers, focus tests/smoke, AGENTS and WSP-36.

## required_context
- Root and OpenCraft AGENTS, maintenance skill and verification, design entry, relevant Chat and focus contracts.

## context_receipt
| File | Reading reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | authority and scope | preserve dirty changes; no deploy |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md` | maintenance discipline | shared owner and computed-style proof |
| `opencraft/design/README.md`, `design/invariants.md` | formal presentation contract | update WSP-36 |
| `opencraft/docs/chat-ui-architecture.md` (relevant Composer sections) | editor boundary | keep focus and document identity intact |
| `docs/context/tasks/2026-10-02-opencraft-owned-focus-presentation.md` | history | preserve pointer/dialog-origin fix |

## evidence
- Context route `opencraft composer blue focus ring shared focus presentation theme` has no matched pack; bounded exact focus-token/selector searches located the owner.
- Deployed CSS reproduced the screenshot in Chromium: mouse-clicked editor has a 2px rgb(51,156,255) outline. This is application CSS, not UA styling.

## risks
- Shared selector priority must not hide fallback focus on unstyled buttons. Real browser regression covers fallback and component overrides together.
- Existing worktree is dirty; preserve unrelated changes. Current live preview stays unchanged.

## validation
- Focus/theme/shared-control tests: 16/16 passed.
- Design System and Workbench Web typechecks passed; `check:boundaries` and `git diff --check` passed.
- `smoke-focus-presentation.ts`: actual CodexComposer/ProseMirror and current app.scss in Chromium; mouse click, Tab, touch, preserved input, neutral styled/unstyled buttons in four theme cases, dialog pointer origin and forced-colors passed; no page errors.
- `smoke-control-standards.ts`: six Codex/Vela/custom light/dark cases passed, including quiet input/select focus border, disabled/invalid states and stable loading geometry. Report outside source tree.
- A pre-existing shared-control test/smoke expected a global outline to override the quiet Settings input owner; corrected that expectation to the owned border treatment and separately retained button outline checks. A browser probe initially inserted its color sample into a void input element; fixed the test probe placement and reran successfully.
- Required staged impact check passed on an empty staged set (no staging requested). Explicit scoped impact check hits the overly broad `opencraft/**` gateway rule and requests an unrelated gateway design change. Formal focus semantics were updated in WSP-36 and AGENTS; no gateway architecture or context-rule exclusions were changed just to silence this check.

## decisions
- Keep the fallback at zero specificity so deliberate component presentation wins; do not add a Composer-specific `!important` patch.
- Focus color is neutral, independent of theme accent; legacy aliases use the same semantic token.

## scan_scope
- `opencraft/packages/design-system/src`, `opencraft/apps/workbench-web/src/styles` focus declarations.

## handoff
- Source implementation and relevant checks complete. Current preview has not been rebuilt/replaced/restarted; no commit or publishing. Chromium evidence is not iPhone/Electron visual acceptance.

## preview replacement (2026-10-04)
- User authorized replacement/restart. Self-hosted preview skill and maintenance verification read; no Context Router pack matched the bounded preview query.
- Base is the verified running package, build `20261002070350-7c100bfaf6e8`, unit `opencraft-codex-0160-20261002-preview.service`, PID 2434528.
- Candidate in a separate generated directory ports only the exact focus-selector/theme-token changes to the base Web artifact. No unrelated dirty source, runtime, Codex binary, data or account configuration is included.
- A fresh content-derived asset URL namespace avoids old-cache reuse; unchanged legacy URLs remain available to open clients. The original package/unit remain the rollback owner.
- Candidate build `20261004-neutral-focus-b77cdda508d1` passed isolated package startup on loopback 8095, Web manifest checksum verification and real packaged Composer click/touch/keyboard/input in light/dark; zero asset/page errors. Codex binary and server.mjs hashes match the original package exactly.
- Initial candidate smoke rejected stale dynamic preload references; absolute and relative asset references were both corrected before deployment. The quiet Settings forced-color input selector was also matched to the actual source selector.
- Independent switch script prepared outside source. It validates the original PID/unit/cwd, preserves the data root, checks new build/health, and restores the retained original package on failure.
- Independent switch completed; post-reconnect checks confirmed build `20261004-neutral-focus-b77cdda508d1`, active/running unit `opencraft-neutral-focus-20261004-preview.service`, MainPID 1554252 and cwd `/data/opencraft-neutral-focus-YZHpna/opencraft-server`. Health passed; runtime/binary hashes were unchanged. The independent switch unit returned `Result=success`.

### deployment checkpoint
- Candidate package: `/data/opencraft-neutral-focus-YZHpna/opencraft-server`.
- Switch script: `/data/opencraft-neutral-focus-YZHpna/switch-preview.sh`.
- Expected new unit: `opencraft-neutral-focus-20261004-preview.service`.
- Expected old unit/PID: `opencraft-codex-0160-20261002-preview.service`, 2434528.
- Post-reconnect verification complete, including a fresh `/version.json` and systemd state check on 2026-10-04. Retained old package remains available for rollback; no additional restart is needed.

## checkpoint
- stage: scoped source fix complete.
- verified: zero-specificity global fallback respects the real Composer; keyboard color is independent of accent; touched and pointer-opened controls remain quiet.
- unverified: iOS Safari/Electron and current live preview after a separately authorized replacement.
- discard: a source-only `outline: none` assertion and the old expectation that shared fallback must override quiet Settings fields.
- restore: changes live in the dirty `/data/mono2` checkout; unrelated changes remain untouched.
- next_action: replace the preview only on explicit user request, following the self-hosted preview skill and rollback verification.
