---
id: task-zcode-density-theme-comparison-20260921
type: task
scope: Source-level comparison of OpenCraft and ZCode control density and theme implementation.
triggers: ["ZCode density comparison", "control theme comparison", "OpenCraft typography comparison"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/design-system/src/typography/typography.tokens.json
  - opencraft/packages/design-system/src/theme-engine.ts
  - ref/zcode/packages/ui/src/styles.css
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
Current conversation requests an in-depth comparison of control density and themes, not implementation. Identify proven differences rather than assume the reference is better.

## non_goals
- No UI or theme changes, dependency installation, upstream scripts, production actions, commits or builds.
- No claim of screenshot parity, measured runtime contrast, accessibility compliance or ZCode runtime qualification.

## context_receipt
| Source | Use |
|---|---|
| Root AGENTS.md and opencraft/AGENTS.md | Read-only reference and design ownership rules |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | Compare concrete consumers, retain existing semantic authority |
| .agents/skills/baseline-ui/SKILL.md | Shared controls, keyboard focus and token consistency |
| /Users/skipzhang/.codex/skills/critique/SKILL.md and frontend-design/SKILL.md | Hierarchy and interaction review; do not override desktop system typography policy |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | UI neighboring tests/generated evidence; scope remains OpenCraft, not mono2 frontend changes |
| opencraft/tests/typography-system.test.ts | Generated registry and actual control consumers |
| opencraft/tests/workbench-appearance-theme.test.ts | Theme projection, overrides, unload and material boundaries |

## history_context / scope
- Previous reference review: docs/context/tasks/2026-09-21-zcode-reference-review.md.
- Router query returned no pack; bounded exact search used design-system, extension-react, workbench-web styles/components and ref/zcode UI.
- Initial theme-engine directory lookup failed; actual file is packages/design-system/src/theme-engine.ts.
- Reference remains commit 872ad96. Compare current OpenCraft working tree, including pre-existing edits in tokens.web.scss. None altered by this task.

## Source comparison

### Density: nominal CSS dimensions, not whole-app runtime measurements
| Element | ZCode | OpenCraft |
|---|---|---|
| Standard button | 28px default, 20/24/28/32px variants; base text 14px | ui-button default min-height 40px, sm 32px, lg 44px, toolbar 32px |
| Settings button | Same Button primitive unless caller overrides | Separate SettingsButton: height 32px, text 13px, horizontal padding 12px |
| Input/select | Aligned 20/24/28/32px variants, base text 14px | SettingsTextInput/SettingsSelect 32px, text 13px; searchable select has separate min-height 36px plus padding |
| Compact controls | icon variants 20/24/28/32px | Settings icon 28px; legacy .button 30px/compact 28px |
| Settings rows | 12px block padding, 16px inline; description 14px/24px +4px top gap | General rows min-height 56px, 12px/16px padding, description 12px/16px +2px gap; utility settings-panel overrides min-height 48px, 10px block padding |

ZCode heights assume standard 4px Tailwind spacing and default browser root sizing. Arbitrary consumer classes can override variants. Neither table nor source values prove every rendered control has the default size.

Important: ZCode settings rows with descriptions may be taller, not shorter. Its compact controls retain larger text than our 13px settings controls. Do not infer that shrinking text or every row improves density.

### Concrete ownership gap in our consumers
- apps/workbench-web/src/components/connectors/connector-setup.tsx uses generic Button with no size for save/check/done (md, 40px).
- plugins/builtin-agents/src/model-services/view.tsx uses SettingsButton (32px) for save/check/cancel.
- Generic web Button consumes shared size names/defaults, but geometry is repeated in button.scss; native consumes buttonSizeMetrics directly.
- SettingsButton is a separate native button wrapper in extension-react, with its geometry/state styling in app.scss; the legacy .button is another styling path. Different families are not inherently bugs, but context-specific density is currently implicit in component choice.
- button.scss still specifies font-weight:590; app.scss settings headers/labels/inputs/buttons use direct font-size/font-weight rather than registry roles. Shared typography tests pass because they check selected consumers, not all control files.

### Typography
- Both base UI/body scales default to 14px. OpenCraft has semantic roles (navigation, metadata, body, composer, etc.) and separate Web/Native metrics, with generated CSS and a checked registry.
- ZCode has relative size utilities based on --ui-font-size and a real 12–20px UI font preference (lib/uiFontSize.ts, store and settingsCodePreview.tsx). It changes only font baseline, not root rem geometry.
- This is an independent feature to consider, not proof of superior semantic modeling. Fixed 20/24/28px controls at larger font settings require rendered overflow checks; source inspection alone cannot establish that they remain readable.
- OpenCraft Native contract explicitly preserves a 44pt hit target for compact visuals; desktop density must not be applied blindly to touch.

### Themes
- OpenCraft: theme ID and light/dark/system mode are separate; theme-engine generates semantic properties from ink/surface/accent/contrast, includes shell material, supports extension palette registration and root-owned projection to document or other elements. Vela chooses opaque quiet material; Codex can choose translucent shell material. This is already a substantial theme model.
- ZCode: class-based fixed Zai light/dark palettes, with explicit panel/sidebar/card/input/menu roles. Light background #f8f8f8, sidebar #f0f0f0, panel #ffffff. Dark background/sidebar #161616, panel #202020, card/input/menu #2b2b2b. Useful art-direction reference, not an architectural replacement.
- Both have semantic colors and system-mode/browser/native integration. ZCode's theme switch code does not establish an advantage over our existing applyAppearanceThemeToElement/applySnapshot path.
- ZCode's Button/Input/Select reuse equivalent variant geometry, but repeat Tailwind classes in three files; there is not a single cross-control numeric density registry to transplant.

### Do not borrow: global focus suppression
- ZCode styles.css:121 globally forces outline:none and box-shadow:none !important on focus/focus-visible, including forced-colors mode. This suppresses the normal focus-ring mechanism on shared buttons. Some controls use other focus backgrounds/borders, so do not claim all focus indication is absent.
- Its dropdown-menu.tsx already adds important shadows to work around the global reset. This is a concrete maintenance cost, not an example of industrial polish.
- OpenCraft quiet controls, SettingsButton and generic Button retain explicit focus rules. Preserve these rather than imitate the reset.

## Recommendations (not implemented)
1. Retain the current typography registry and theme engine; no new theme library or wholesale Tailwind migration.
2. Express desktop context density deliberately and align Button/Input/Select within each context. Map SettingsButton to shared visual primitives while keeping its domain-level API; avoid unrelated application-wide size changes.
3. Remove direct typography values from shared-control consumers where a role exists; add a role only for a real missing semantic use. Normalize unsupported 590 weight.
4. Compare rendered specimens for themes (Vela/Codex/Paper, light/dark), focus/hover/disabled/pending, Chinese/English and long text. Keep font scale separate from control density and verify touch targets independently.
5. If users need larger UI text, assess a typography preference projected through existing UiPreferencesRuntime and registry; do not copy localStorage-based reference state.

## acceptance / validation / handoff
- npm run check:typography passed.
- node --import tsx --test tests/typography-system.test.ts tests/workbench-appearance-theme.test.ts: 7 passed, 0 failed.
- No product files changed. ZCode was not installed or launched. Static evidence supports control-family inconsistencies and theme-model comparison, not aesthetic pass/fail or computed pixel equality.
- Complete: strongest takeaway is consistent application of existing models, not borrowing a stronger model from ZCode.

## Follow-up: can the current theme system carry a ZCode-inspired theme?
- Read-only trace: extension-contract ThemePaletteContribution -> contribution-store validation/freezing -> appearance-theme import/projection -> theme-engine -> shell CSS; separately checked Electron appearance IPC and Expo Unistyles.
- Web theme registration, palette selection, retained intent/unload fallback and light/dark switching are wired. Existing appearance tests: 3 passed.
- Internal shellMaterial is emitted as CSS and consumed by app.scss. Public extension palettes do not expose it; their adapter fixes opaqueWindows=false and fonts=null.
- Panel/control/elevated/border colors mostly derive from ink/surface/contrast, rather than independently selectable surface roles. A close palette is possible now; precise ZCode surface layering needs controlled semantic overrides.
- Direct pure-function probes: toggling opaqueWindows or changing fonts leaves emitted CSS identical in both modes. Fields are declared, not effective generator inputs.
- Electron IPC carries only themeSource and resolvedTheme; focused macOS vibrancy and backing colors are Main policy, not selected-theme policy. CSS opaque material does not prove native vibrancy was disabled.
- Expo registers only static nativeThemes.light/dark; no dynamic theme contribution/catalog adapter found in the inspected Expo path. Do not claim selecting a Web extension theme changes Native.
- Conclusion: existing architecture can host the feature without replacement, but current capability is not a complete arbitrary cross-platform appearance system. For a faithful desktop theme, extend controlled semantic surfaces/material policy end-to-end, preserve generated defaults and interaction/geometry ownership. Native dynamic palette support is a separate optional implementation scope.
