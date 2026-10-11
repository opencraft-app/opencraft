# /agents-next Web theme color compatibility

## goal
Remove HeroUI colorKit's invalid RGB conversion in the Expo Web preview.

## non_goals
- No theme redesign, native theme override, authentication changes or release.

## requirement_refs
- User reported `[colorKit.RGB]` console error in `/agents-next`.

## interface_refs / history_context
- HeroUI Native `useThemeColor` consumes Uniwind CSS variables.
- Uniwind 1.12 Web returns unresolved CSS Color 4 expressions; colorKit does not parse them.
- Formal design: `opencraft/docs/mobile-shell.md`.

## affected_paths
- `opencraft/apps/workbench-expo/src/runtime/heroui-theme-color.web.ts`
- `opencraft/apps/workbench-expo/metro.config.cjs`
- `opencraft/docs/mobile-shell.md`

## context_receipt
- Read root, frontend, OpenCraft and Expo AGENTS; opencraft-maintenance skill.
- Root context router query had no matching pack.
- Read HeroUI theme hook/button/colorKit and Uniwind Web variable reader.

## decisions
- Resolve valid browser colors through a one-pixel sRGB canvas before colorKit.
- Keep alpha; cap cache at 128 entries, keyed by current resolved CSS value.
- Substitute only HeroUI's Web theme reader, preserving Uniwind resolver and native path.
- Do not suppress console errors or substitute black.

## evidence / validation
- Before: mounted exported Shell on local Next page emitted colorKit error;
  `--color-default-hover` was `color-mix(in oklab, lab(...) 96%, lab(...) 4%)`.
- After: same Chromium mount fixture emitted no colorKit error, light and dark.
- Fixture uses empty credentials; expected HTTP 401 remains. Real user API flows unverified.
- Expo typecheck passed; Expo Web export passed and preview manifest updated.
- `git diff --check` passed. Native bundle verification recorded in turn output.

## risks / handoff
- Browser fixture uses Chromium, not iPhone Safari hardware.
- Recheck this adapter when HeroUI or Uniwind updates its color parsing.
- Source and local preview only; no commit or deployment.
