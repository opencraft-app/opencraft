---
id: task-zencode-theme-20260921
type: task
scope: Optional ZenCode built-in theme for OpenCraft Web and Electron.
triggers: ["ZenCode theme", "ZCode inspired palette", "ZenCode appearance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/packages/design-system/src/theme-engine.ts, opencraft/apps/workbench-web/src/appearance-theme.ts]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User requests the ZCode-inspired finished theme, named ZenCode, using the newly added theme capability.

## non_goals
- No default-theme, control-density, font, layout or Expo dynamic-theme changes.
- No copying ZCode components, global focus suppression, or arbitrary CSS. No commit/push/package replacement.

## context_receipt / history_context
- Root/OpenCraft AGENTS; maintenance and normalize skills; prior density comparison and theme-material-capabilities Task Packs.
- Router returned no match; bounded source search of theme engine, theme registry, Settings theme picker and appearance tests.
- Reference: ref/zcode commit 872ad96 styles.css Zai light/dark surface colors. Only visual layer inspiration; adapted status colors keep readable feedback.

## interfaces / decisions
- Built-in id vela.core.zencode, visible label ZenCode; mode remains separate light/dark/system preference.
- Use public semantic surfaces and opaque/flat material options; do not introduce theme-id CSS selectors.
- Preserve concurrent Frost and previous capability changes.

## acceptance / validation
- Theme visible/selectable in existing Settings picker; switching restores other themes without residue.
- Verify light/dark and system, stored theme restoration, layer colors, focus, native opaque backdrop and unchanged control geometry.
- Focused tests/typecheck and isolated Electron screenshots.

## handoff
- Complete: optional ZenCode is registered beside Codex/Vela/Frost; existing defaults unchanged. Both modes use semantic surface/material inputs with no theme-specific selectors.
- Settings miniature previews now project actual palettes for the resolved mode, removing hardcoded per-ID preview color copies. Preview geometry unchanged.
- 13 focused tests passed; design-system and Web typechecks, boundaries, Web production build, diff check and docs-impact passed. Existing build-size/dynamic-import warnings remain non-blocking.
- Isolated Electron used production SettingsContent, appearance service, preload and native applicator. Clicked ZenCode in the real Theme radio group, switched Light/Dark/System, checked native opaque backing and reloaded the page to verify stored selection restoration.
- Final report/screenshots: /var/folders/pc/47xyrxbs1296b6sjfc2sfd6r0000gn/T/opencraft-theme-materials-R8rhg8. Light/dark screenshots reviewed; temporary test extension removed before final preset screenshots.
- A repeat smoke hit asynchronous native blur timing with the old fixed 100ms wait; changed the harness to await settled native state. Final run passed. No production behavior change made for this timing issue.
- No installed desktop package or existing user window replaced; this is verified source plus a Web build, not a newly distributed Mac package. No commit/push.
