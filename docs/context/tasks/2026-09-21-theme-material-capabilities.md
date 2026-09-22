---
id: task-theme-material-capabilities-20260921
type: task
scope: Typed extension surface/material overrides and Electron theme appearance projection.
triggers: ["theme material capabilities", "theme surface overrides", "native theme appearance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/docs/platform-architecture.md, opencraft/packages/design-system/src/theme-options.ts]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User approved extending public theme materials/surfaces and wiring Electron native appearance, preserving existing registration/selection/mode/fallback behavior.

## non_goals
- No Expo dynamic themes, density/layout changes, arbitrary CSS, font customization, ZCode page imports, commit/push/release.
- Preserve concurrent Frost theme and pane-chrome changes found in the worktree.

## context_receipt / history_context
- Root and OpenCraft AGENTS; maintenance skill and verification checklist; existing typography/theme comparison Task Pack.
- Router returned no pack. Bounded exact trace: extension-contract -> contribution-store -> appearance-theme -> theme-engine -> Shell, then preload/Main and native Unistyles.
- Existing appearance tests, extension activation tests and window-chrome tests are verification neighbors.

## interfaces / decisions
- Design-system owns platform-neutral optional surface overrides (window/sidebar/panel/input/popover), enum material policy and narrow desktop appearance intent.
- Extension palettes are validated and frozen before publication. Unknown surface/material keys, CSS/URLs and incomplete palettes rejected.
- Omitted options preserve existing computed semantic colors and legacy internal shellMaterial. Selection/unload always regenerates full properties, preventing stale overrides.
- Desktop receives validated opaqueWindows/backgroundColor plus existing theme modes; unfocused macOS and non-macOS windows remain opaque. Sender authorization remains unchanged.

## acceptance / validation
- Typechecks and boundary checks for affected workspaces; palette validation/freezing/fallback tests; mode/surface/material generation and IPC rejection tests.
- Real component and isolated Electron evidence for themed controls, registration/removal, focused/unfocused backdrop policy. No user credentials/profiles.

## risks / handoff
- Complete. Concurrent Frost changes preserved, not claimed as this task's work.
- 34 focused tests passed: registry validation/freezing, atomic rejection, palette/token projection, fallback and window chrome/native policy.
- All affected typechecks and boundary checks passed. Full npm run gate exited 0, including Web, Expo Web and iOS bundles. Expo build compatibility does not mean dynamic Expo themes were added.
- Isolated Electron smoke passed using actual extension registration, renderer theme service, production preload and shared native applicator: computed layer colors, getBackgroundColor, real setVibrancy calls, focus/blur, light/dark/system change, unload/reinstall intent, invalid IPC rejection. Report: /var/folders/pc/47xyrxbs1296b6sjfc2sfd6r0000gn/T/opencraft-theme-materials-HTNwLt/report.json. Dark screenshot visually inspected.
- Initial smoke sampled input background during its color transition; changed verification to await the expected settled endpoint. No production change needed for that harness issue.
- Native smoke uses a minimal authorized IPC receiver with the production validator/applicator, not a full Agent runtime launch. Main's sender guard and actual applicator call are separately covered by source regression tests.
- Updated formal architecture and plugin docs. git diff --check and explicit/staged docs-impact checks passed. No commit, push, package replacement or change to user windows/profiles.
- This delivers theme capabilities, not a new ZCode preset. Named semantic overrides keep layout, typography and platform interaction policy outside the theme.
