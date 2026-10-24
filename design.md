# Designing OpenCraft interfaces

Read this entry before creating or changing UI. Compose the closest existing
OpenCraft pattern for the user's task. Explicit user direction can change the
visual treatment; preserve accessibility, interaction ownership and the user's work.

This is an authoring guide. Linked source owns token values and component behavior.
Read the relevant owner and a real consumer before coding. Do not copy numbers
from screenshots or freeze a theme's current colors into feature styles.

For repository UI work, use the maintenance Skill's [UI workflow](.agents/skills/opencraft-maintenance/references/ui-design.md)
to carry the selected pattern through implementation and visual review. New
features with UI use the same path. Load only the relevant topics below.

## Choose a working pattern

| Task | Pattern | Working reference |
|---|---|---|
| Configuration and preferences | Related sections, aligned label/description/control rows, quiet actions | [Settings page](apps/workbench-web/src/components/settings-page.tsx), [Settings controls](packages/extension-react/src/settings-controls.tsx) |
| Utility dialogs and configuration forms | Shared modal presentation with compact panel content, adjacent labels/inputs and stable validation | [Settings panel](packages/extension-react/src/settings-panel.tsx), [modal owner](apps/workbench-web/src/components/modal/modal-surface.tsx); keep package boundaries when consuming their public contracts |
| Browsing tasks, schedules or other managed objects | Scannable object rows, meaningful groups, one clear destination and subordinate actions | [Collection composition](design/ui/collections.md), Settings list primitives and route container in the references above |
| Reading, input and results | One reading axis, bounded width, separate content/process hierarchy, stable input and result slots | [Chat architecture](docs/chat-ui-architecture.md), [Workbench language](docs/workbench-design-language.md) |
| Navigation and grouped choices | Shared icon/text alignment, section rhythm, distinct hover/current/pressed states | [Sidebar item](apps/workbench-web/src/components/sidebar-navigation-item.tsx), [shared controls](packages/design-system/src/controls.web.scss) |
| Inline utility or calculator | Compact inputs and result/selection, one primary action, natural height inside the existing frame | [MCP App authoring](docs/mcp-app-builder.md#visual-authoring-in-the-conversation) |

Combine patterns when appropriate. Start with content and actions; use spacing,
alignment and a small text hierarchy to organize them. Keep ordinary labels quiet;
reserve emphasis and accent for meaningful distinctions. Add a card, badge,
illustration or animation when it explains something or serves explicit visual
direction. Reusing a page's composition does not duplicate its business state.

Before implementation, name the user's main task, the chosen pattern and real
consumer, the owner of the page gutter/scrolling, and the primary versus secondary
actions. A few lines in the existing task notes are enough; this is not an approval
step. For collection pages, follow the composition rules and review examples in
[Collection composition](design/ui/collections.md). Its source references identify
reusable pieces, not proof that every existing consumer already meets the guide.

## Select existing semantic tokens

[Package exports](packages/design-system/package.json) define importable entry
points. [Web tokens](packages/design-system/src/tokens.web.scss) own shared geometry
and material fallbacks; the [theme engine](packages/design-system/src/theme-engine.ts)
projects the selected palette. [Shared tokens](packages/design-system/src/tokens.shared.ts)
and the Native projection serve platform code. Shared palette defaults are not
the resolved colors of the current Web theme.

| Meaning | Existing Web tokens / owner |
|---|---|
| Copy hierarchy | `--color-text`, `--color-text-secondary`, `--color-text-tertiary` |
| Page, panel, input, opaque raised surface | `--color-background-surface`, `--color-background-panel`, `--color-background-input`, `--color-background-elevated-primary-opaque` |
| Separation | `--color-border-subtle`, `--color-border-default`, `--color-border-strong` |
| Primary action | Pair `--color-background-button-primary` with `--color-text-button-primary`; use its `-hover`, `-active`, `-inactive` background states |
| Secondary / quiet action | Corresponding `--color-background-button-secondary*` / `--color-background-button-tertiary*` and `--color-text-button-secondary` / `--color-text-button-tertiary` |
| Navigation state | `--color-background-navigation-hover`, `--color-background-navigation-current`, `--color-background-navigation-pressed` |
| Feedback | `--color-text-accent`, `--color-text-warning`, `--color-text-danger`, `--color-status-success` |
| Category badge | Paired `--color-badge-{tone}-foreground` / `--color-badge-{tone}-background`; tones: blue, cyan, red, indigo, green, purple, orange, neutral |
| Spacing / corners | Multiples of `--spacing`; `--radius-xs`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl`, `--radius-full`; prefer an existing control-specific role |
| Navigation geometry | `--height-navigation-row`, `--size-navigation-leading-slot`, `--gap-navigation-row-content`, `--gap-navigation-sections`, `--gap-navigation-groups` |
| Settings layout | `--height-token-settings-row`, `--padding-token-settings-panel`, `--gap-token-settings-sections`, `--radius-token-settings-card` through Settings components |
| Reading / input | `--thread-content-max-width`; existing Composer owns its input, rail and corner geometry |
| Input density | `--size-control-hit-min` and `controls.density-target`; touch targets adapt without shrinking essential text |
| Material | `material.surface` / `material.floating` consume `--material-background-*`, `--material-backdrop-filter` and shared shadows with accessibility fallbacks |
| Focus / disabled | Shared `controls` and `focus.web`; `--color-border-focus`, `--width-control-focus-ring`, `--opacity-control-disabled` |
| Motion / stacking | Existing component motion; `--transition-duration-basic`, shared easing and semantic `--layer-*` planes where relevant |

Select by purpose. Shell materials, stacking planes and Composer geometry belong
to their owners: use the relevant component rather than copying its internals
into a standalone feature.

## Choose typography by meaning

The [registry](packages/design-system/src/typography/typography.tokens.json) owns
font stacks, sizes, weights and platform mappings. The [typography contract](design/ui/typography.md)
explains usage. Select `settingsTitle` for page titles, `panelTitle` for utility
headings, `body` for UI copy, `metadata` for essential supporting text,
`control` / `controlCompact` for controls, `chat` for conversation reading and
`composer` for composition. Selection changes state treatment, not font weight.
Preserve reading preferences and native font scaling.

In existing Workbench styles:

```scss
@use "@opencraft/design-system/typography.web" as typography;
@use "@opencraft/design-system/controls.web" as controls;

.feature-description { @include typography.role(body, secondary); }
.feature-destination { @include controls.navigation-control; }
```

Plain CSS in a document already initialized with the design system:

```css
.feature-description {
  font: var(--typography-body-font);
  letter-spacing: var(--typography-body-tracking);
  color: var(--color-text-secondary);
}
```

Keep shared style imports at their established owner. Avoid repeatedly emitting
Typography utility CSS through nested Sass imports; shared controls already use
the mixin-only module internally. Never edit generated typography.

## Reuse interaction and extend at the owner

Use `@opencraft/extension-react` Settings controls for configuration; existing
Radix/Modal infrastructure for menus, popovers and dialogs; shared controls for
hover modality, navigation states, focus and disabled feedback. The [icon owner](packages/design-system/src/icons.web.scss)
holds navigation glyph metrics. Features supply values, actions and domain state;
Shell owns placement, safe areas, collision, scrolling and overlay lifetimes.

Use an existing primitive when it fits. Extend a shared semantic token or variant
when a reusable state is missing, then migrate affected consumers together.
Feature-specific composition can remain local. Preserve drafts, selection, focus
and scroll through theme, size and presentation changes. Follow [UI ownership](AGENTS.md#ui-与设计系统)
and [workspace invariants](design/invariants.md) for stable asynchronous feedback.

## Generated Apps have a different delivery boundary

Repository UI consumes an initialized design system. A generated MCP App is an
opaque-origin iframe: it does not inherit host CSS, fonts, React components or
token variables. The current host exposes theme changes, not `styles.variables`.
Do not output undefined host variables and assume they resolve inside the frame.

Use the portable guidance and self-contained example in [MCP App authoring](docs/mcp-app-builder.md#visual-authoring-in-the-conversation).
Choose the same configuration / input-result / selection composition; provide
local semantic styles with explicit light/dark fallbacks and preserve inputs on
theme updates. Builder `help` supplies essential rules without repository access.
This guide does not add a token bridge or restyle published Apps.

## Review the result

Identify the selected pattern, shared primitives and any needed extension. Check
the actual relevant UI in light/dark and an extension theme when changing themed
controls; use narrow/wide containers, long labels and values. Exercise pointer,
touch and keyboard paths, selected/disabled/pending/error/empty states as applicable.
Keep feedback in stable slots and preserve the user's work. Respect reduced motion,
reduced transparency and forced colors through existing owners.

Run the changed owner's checks via [UI topics](design/ui/README.md) and
[maintenance verification](.agents/skills/opencraft-maintenance/references/verification.md).
A token reference or screenshot alone does not prove semantic fit. Distinguish
source checks, rendered UI and unverified device/model/service paths.

Review the complete composition as well as each control: reading order, content
insets, action emphasis, density and state feedback. Use the relevant
[collection acceptance checks](design/ui/collections.md#verify-the-composition)
for list or management pages. Fix the cause at its owner when a shared container
breaks these rules; do not compensate with a different margin in every feature.
