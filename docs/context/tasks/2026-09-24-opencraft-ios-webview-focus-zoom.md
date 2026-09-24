## goal
Prevent unintended focus zoom in OpenCraft's iPhone in-app-browser Web UI while intentionally locking page pinch zoom for its app-like surface.

## non_goals
- Change Electron or Expo Native typography, desktop Web density, or Host permissions.

## requirement_ids / requirement_refs / requirement_excerpt
- User report and decision, 2026-09-24: an input focused in iPhone WeChat/WeCom enlarges the page; enlarge editable text and disable voluntary page pinch zoom.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/index.html` owns Web viewport metadata.
- `opencraft/apps/workbench-web/src/styles/app.scss` owns Web input and Composer typography.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` and `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: Web and Electron share a renderer stylesheet, so the mobile floor must not change desktop Composer density.
- `superseded_refs`: none.

## acceptance
- Built Web HTML requests a fixed mobile viewport scale.
- Coarse-pointer phone editable text has a 16px minimum, while desktop Composer remains 14px.
- Focus and keyboard input remain operable; iPhone device behavior is verified separately from source/build checks.

## affected_paths
- `opencraft/apps/workbench-web/index.html`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/typography-system.test.ts`
- Mapped design docs.

## required_context
- Root context router returned no matching Pack. OpenCraft local Agent entry and maintenance verification checklist apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Local Web/UI boundaries | Scope and gates |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Maintenance workflow | Client validation |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Validation matrix | Focused tests |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack format | Record evidence |

## evidence
- The original Composer CSS was 14px; a focused regression test failed before the patch and passed afterward.
- Local Web typecheck, 280 Workbench unit tests, 17 shell-space tests, 10 Web-release tests, boundaries and release build passed.
- Built CSS and viewport metadata were checked; an iPhone Simulator Safari fixture focused Composer and text input without a visible page-scale jump.
- The isolated test-server archive was deployed separately, with its prior server binary unchanged; real WeChat/WeCom WKWebView validation remains outstanding.
- On the clean master-based worktree: Web typecheck, boundary checks, Web release build, 276/276 Workbench unit tests, 17/17 shell-space tests and 9/9 Web-release tests passed. The first Workbench run exposed a non-executable `node-pty` helper in the fresh ignored `node_modules`; repairing that local install permission made the terminal tests and full suite pass without source edits.
- Documentation inventory and explicit changed-file impact checks passed.

## risks
- Locking pinch zoom removes a user accessibility affordance by explicit product decision. Keep phone input text readable and keyboard focus intact.
- Safari and embedded WKWebView may interpret author scale limits differently.

## validation
- Re-run focused typography test, Web typecheck, boundaries, Web release test/build and design impact against the clean master-based worktree.

## decisions
- Use a coarse-pointer phone CSS floor and viewport metadata, not desktop-wide typography changes or focus suppression.

## scan_scope
- OpenCraft Web entry, styles, Composer and adjacent Web tests.

## scan_output
- Bounded exact searches for viewport metadata and Composer editor CSS.

## handoff
- Clean master-based commit and merge in progress; the original dirty branch and other pending OpenCraft work remain out of scope. No iPhone WeChat/WeCom device result has been claimed.
