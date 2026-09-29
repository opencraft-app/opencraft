## goal
Prevent unintended focus zoom in OpenCraft's iPhone in-app-browser Web UI while intentionally locking page pinch zoom for the app-like surface.

## non_goals
- Change Electron or Expo Native typography.
- Change desktop Web control density.
- Alter the previous Linux server user or filesystem privileges.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-09-24: tapping an input in iPhone WeChat and WeCom embedded browsers zooms part of the OpenCraft page.
- User decision, 2026-09-24: treat Web as an app-like surface; both enlarge focused text controls and disable voluntary page pinch zoom.

## interface_refs / data_structure_refs
- `apps/workbench-web/index.html` owns Web viewport metadata.
- `apps/workbench-web/src/styles/app.scss` owns Web controls and Codex Composer typography.
- The ProseMirror editor is a `contenteditable` element; its current 14px text is below the commonly observed iOS focus-zoom threshold.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`.
- `relevant_evolution`: Web and Electron share the renderer stylesheet; mobile overrides must not change desktop density. The site already uses `width=device-width, initial-scale=1` and a 14px Composer editor.
- `superseded_refs`: none.

## acceptance
- Packaged Web HTML expresses a locked viewport scale for iPhone in-app browsers.
- Coarse-pointer phone text fields and editable content are at least 16px, including the Composer and its code block, while desktop Composer stays 14px.
- Focus, editing, keyboard input and draft ownership remain unchanged.
- Tests, typecheck and Web build pass; mobile emulation verifies computed style/viewport metadata. Actual WeChat/WeCom iPhone behavior is reported separately if no device access exists.

## affected_paths
- `opencraft/apps/workbench-web/index.html`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- Focused Web tests and formal design documentation.

## required_context
- Context router returned no matching Pack; use the OpenCraft local Agent entry and maintenance verification checklist.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Local Web/UI boundaries | Preserve platform separation and tests |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | Maintenance workflow | Real client validation |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Verification matrix | Select focused UI gates |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack format | Record requirements and evidence |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | Closest front-end static artifact adjacency; no OpenCraft-specific card exists | Check release-test neighbor without treating frontend truth as OpenCraft truth |

## evidence
- `app.scss` declares `.codex-composer-editor { font-size: 14px; line-height: 21px; }`, including a 12px code block.
- `index.html` currently declares `width=device-width, initial-scale=1.0` without a scale lock.
- WebKit documents focused-element zoom; the observed sub-16px field is a plausible cause, but direct WeCom device evidence is not available in this workspace.
- The new typography regression failed before the change and passed afterward. `test:workbench:unit` passed 280/280; `test:shell-space` passed 17/17; Web typecheck, boundary check, Web release test 10/10, release build, docs impact and documentation checks passed.
- A separate clean master-based checkout also passed Web typecheck, boundaries, Web build, 276 Workbench tests, 17 shell-space tests and 9 Web-release tests; its first terminal run required only a local `node-pty` executable-bit repair, not a source edit.
- Built `dist/index.html` includes `maximum-scale=1, user-scalable=no`; built CSS includes the coarse-pointer 16px editable rule, a 24px Composer line and 16px code block.
- In an iPhone 17/iOS 26.2 Simulator Safari fixture using this built viewport/CSS, focusing both the contenteditable Composer and a text input opened the keyboard without shifting or enlarging the visible page content. This is not a WeChat/WeCom WKWebView device test.
- Authorized test-server deploy at that time: native Linux archive SHA-256 `1f78180492afee2ef7ed883948c91c914abab7ff62b33ef87ed8a013745cac84`, build ID `20260924103545-79a7c75e1202`; isolated archive smoke passed. Server runtime bundle matched the previous release byte-for-byte, while Web index changed. The service then pointed to `/opt/opencraft-server/releases/1f78180492afee2e` with `NRestarts=0`; later OpenCraft preview releases superseded this pointer.
- Direct IP and HTTPS-proxied index both return the new build ID and viewport metadata; new CSS is reachable (HTTP 200), browser Workbench reaches a connected Codex draft, and Codex AppHost initialize/account-list smoke passed. Desktop computed Composer font remains 14px.
- An attempted second Simulator pass against the deployed full page stopped because the Mac was locked. The simulator was shut down; no lockscreen bypass was attempted.

## risks
- Locking page pinch zoom removes a user accessibility affordance by explicit product decision; retain readable field typography and do not remove keyboard focus indicators.
- iOS Safari may ignore author scale limits even if an embedded WKWebView honors them; validate the actual WeChat/WeCom surfaces separately.

## validation
- Focused viewport/style regression, Web typecheck, boundary/typography checks, Web release build and mobile computed-style check.

## decisions
- Use a mobile coarse-pointer style floor rather than increasing desktop typography or blocking focus events.
- Keep the existing viewport-fit and interactive-widget values while adding explicit scale limits.

## scan_scope
- `opencraft/apps/workbench-web` and relevant `opencraft/tests`.

## scan_output
- Bounded searches for viewport metadata, Composer editor CSS, and adjacent Web release/typography tests.

## handoff
- Source, local Web build and authorized test-server deployment were completed; WeChat/WeCom iPhone focus and pinch behavior remain a device-only verification gap. The test service already ran as root with `/data` writable before this deployment; this task did not alter its unit or privilege configuration.
