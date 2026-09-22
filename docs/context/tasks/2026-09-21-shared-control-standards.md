---
id: task-shared-control-standards-20260921
type: task
scope: Apply existing typography and interaction standards to shared workbench controls.
triggers: ["shared control standards", "control typography", "control state tokens"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/packages/design-system/src/typography/typography.tokens.json, opencraft/docs/platform-architecture.md]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User requests that existing standards cover shared controls, following the ZCode density/theme comparison.

## non_goals
- No control-density changes, page-layout changes, ZCode imports, account operations, commits or releases.
- Preserve unrelated working-tree changes to sidebar activity styles and tokens.

## context_receipt
- Root AGENTS.md; opencraft/AGENTS.md; opencraft maintenance skill and references/verification.md.
- baseline-ui, normalize and fixing-accessibility skills: reuse semantic primitives; preserve keyboard focus and native input semantics.
- Router returned no pack; exact searches bounded to shared controls, typography registry, CSS consumers and their tests.
- Prior task: 2026-09-21-zcode-density-theme-comparison.md; platform-architecture.md typography ownership; adjacent typography-system.test.ts and appearance-theme tests.

## interface_refs / history_context
- Typography registry owns role metrics; Web SCSS and Native TypeScript project it.
- Button size contract remains sm/md/lg/toolbar with unchanged geometry.
- SettingsButton and native HTML form semantics remain unchanged.

## acceptance / validation
- Shared buttons and settings labels/inputs consume typography roles; no arbitrary 590 weight.
- Keyboard focus, disabled and invalid feedback consume shared state primitives and theme tokens.
- Loading does not resize the generic button. Existing size variants remain unchanged.
- Generated typography check, focused tests, affected typechecks and real-component Chromium checks across themes and states.

## affected_paths
- opencraft/packages/design-system; shared Web button/settings styles; relevant tests and architecture docs.

## risks
- CSS cascade and existing dirty app.scss: patch only control selectors.
- Normalized line heights may expose clipping; verify actual controls with Chinese/English and held loading states.

## handoff
- Complete: generic Web/Native button typography and Settings form typography project the registry. Size and padding contracts remain unchanged. Utility settings label/copy overrides also use roles.
- Shared focus/disabled/invalid primitives cover selected controls; disabled selects no longer hover-highlight. Settings danger actions consume theme text-danger. Generic loading preserves label footprint and honors reduced motion.
- npm run check:typography and npm run test:control-standards: 11 passed. New test command is part of npm test.
- Design-system, workbench-web and workbench-expo typechecks passed; check:boundaries passed; git diff --check passed.
- Chromium fixture: six light/dark palette cases passed. Isolated Electron fixture: six cases passed, including dimensions, fonts, keyboard focus, invalid state, disabled hover, held loading geometry, reduced motion and forced colors. Final report: /var/folders/pc/47xyrxbs1296b6sjfc2sfd6r0000gn/T/opencraft-controls-Nlnqzn/report.json.
- Fixture corrections: first size assertion exposed flex stretch and the select inner-box vs outer-shell distinction; fixed the fixture's alignment and measured the real shell. Palette/label screenshot reads now wait for repaint before comparing; final captures confirm the loading label is hidden without removing its layout footprint.
- Inspected final Electron light screenshot. No production app package was rebuilt/replaced and no existing window/profile was touched; Native was typechecked, not device-tested. Product-specific typography and legacy .button styles remain outside this scoped migration.
- Mapped design documentation updated. Explicit changed-file docs-impact check and required --staged check passed (no staged files).
