## stage
Source, focused tests, Web typecheck/build and impact check complete; not deployed.

## verified
- The Activity item button owns selected fill; the separate Radix menu trigger previously painted its own fill.
- Trigger is now transparent, with hover kept on the row wrapper so moving onto the trigger does not break the row surface.
- 25 focused tests and Web TypeScript/build pass; compiled CSS confirms the intended selectors.

## unverified
- Actual mobile touch and desktop visual rendering; current in-app mobile browser cannot inspect an isolated page without Preview Bridge and cannot capture a screenshot.

## discard
- Historical r3562 Codex desktop source path is unavailable here; official Codex app documentation is not an internal CSS specification.

## restore
- Changed source: `opencraft/apps/workbench-web/src/styles/app.scss`, test: `opencraft/tests/sidebar-activity.test.ts`.
- Current running preview before any replacement: buildId `20260925103419-23c1aeeb42e7`.

## next_action
If the user asks to replace the preview, build/package/smoke an independent release, switch with rollback, and visually confirm the menu on the new page.
