# Floating primary headers

## Goal

Replace the full-width, separator-led Web header treatment with one shared floating material surface across Vela's
primary content stages. The visual reference is Rivet's inset navigation bar, but Vela keeps its macOS density,
typography, interaction ownership and platform semantics.

The change is architectural rather than screen-local. A page must not draw its own floating rectangle, shadow,
backdrop filter or inset values.

## Scope

The shared floating treatment applies to every primary content header:

- the active Channel or direct-message header;
- `SystemPage` headers used by Task, Reminder, Agent, Computer, Member and Server settings screens;
- the compact primary header when it is the only title/action surface for the active content.

The following remain docked and are not floating headers:

- resource-directory and sidebar headers;
- Channel list group labels and direct-message group labels;
- thread, terminal, popover, dialog, form and card-internal headers;
- inline notices, operation islands and collection toolbars.

This boundary prevents nested pills and preserves a clear hierarchy: one floating primary header per active content
stage, with subordinate navigation and panels remaining structurally attached to their containers.

## Component ownership

Add `SystemFloatingHeader` as the only legal primary floating header surface. It owns material, geometry, border,
shadow, active-window state and responsive density. Consumers own only header content.

`SystemFloatingHeader` is backed by a new `floatingHeader` role in `SystemMaterialSurface`. It accepts:

- `children`;
- `layoutMode: "wide" | "medium" | "compact"`, derived from the existing viewport layout model; medium and wide
  share the desktop inset tier while compact alone uses reduced viewport insets;
- `testID`;
- an optional style used only for layout participation, not chrome overrides.

Input density is not a component prop. Pointer/touch density remains independently resolved by the theme from input
hardware. A compact Mac window therefore keeps pointer metrics, while a wide touch device keeps touch metrics.

`ManagementHeader` continues to own the title, eyebrow, summary and actions grid. `SystemPage` wraps it with
`SystemFloatingHeader`, so every management screen adopts the material without local work. The conversation header
uses the same primitive around its existing identity and actions. `CompactHeader` passes compact viewport layout while
still receiving pointer or touch density from the theme.

The primitive is exported through the shared UI index. Lock tests reject direct primary-header chrome in screens and
layouts outside the primitive/material implementation.

## Token model

Tokens are named for semantic responsibility rather than the Rivet reference.

Add `semantic.material.floatingHeaderFill` and `floatingHeaderInactiveFill`. They follow the existing frosted material
system and retain light/dark adaptive-theme ownership.

Do not add a seventeenth recipe namespace or increase the recipe leaf ceiling. Floating-header geometry is a semantic
composition of existing shared tokens:

- wide/compact viewport insets use existing `spacing` tokens selected by `layoutMode`;
- pointer/touch height and action metrics continue to use the existing density-derived
  `desktopWorkspace.headerHeight` and control recipes;
- internal padding and shadow clearance use existing `spacing` tokens;
- radius uses `semantic.radius.overlay`;
- `semantic.stroke.hairline` and `semantic.color.borderOverlay`;
- `theme.shadows.floatingControl`;
- `semantic.layer.docked`;
- `semantic.material.blur`;
- `semantic.motion.transition.surface`.

The duplicate `managementWorkspace.headerHeight` leaf is removed and management consumers use
`desktopWorkspace.headerHeight`; this reduces rather than expands the geometry vocabulary. No consumer may supply raw
radius, blur, alpha, shadow, border or inset numbers. `theme-contract.test.ts` must remain within both the 16-namespace
and recipe-leaf ceilings.

## Layout and scrolling

The header remains in normal document/layout flow. It is visually floating but is not `absolute`, `fixed` or CSS
`sticky`. Existing stage ownership already keeps primary headers outside their content ScrollViews, so this preserves
the current always-visible behavior without obscuring messages or management content.

The stage shows its canvas around the inset surface. The header slot reserves the block inset, header height, shadow
clearance and following content boundary. Header removal or viewport changes must not change the page root position.

`MessageStage` is the sole owner of conversation top geometry. Rename the existing
`conversationWorkspace.toastTopInset` leaf to `stageTopOverlayInset` and calculate it from the wide floating-header
slot. The chat error toast and `OperationStatusIsland` both receive this offset from `MessageStage`; neither primitive
retains its own conversation-specific `top` value. Compact conversation layout, where the compact primary header is
outside `messageStage`, passes the existing compact spacing inset instead. Search, reconnect and membership-repair
content remain in normal flow beneath the header slot.

Conversation feedback, membership repair, search and operation islands remain below the primary header in their
existing semantic order. A shadow never changes hit testing or consumes layout space outside the reserved clearance.

## Responsive behavior

Wide layout uses the full inset geometry and the existing two-line identity hierarchy. Compact layout uses the same
component with smaller viewport insets and the existing compact copy/action model. Either layout can independently use
pointer or touch density.

The component may reduce copy or actions only through the existing responsive model. It must not wrap into a taller
web-style toolbar. At narrow widths, one-line truncation and existing overflow/navigation behavior take precedence
over vertical stacking.

Sidebar and collection headers remain edge-attached at every width. Horizontal compact resource directories continue
to omit their collection header as they do today.

## Window, material and accessibility states

On Web, the surface uses backdrop blur and the active floating fill. When the application window is inactive it uses
`floatingHeaderInactiveFill`; text and controls retain the existing inactive semantics and accessibility contrast.

The management header's drag region remains on the noninteractive copy area. Buttons and other actions remain
`AppRegion: no-drag`. Focus rings, keyboard order, labels and hit targets continue to come from existing shared controls.

Reduced motion sets the existing surface transition duration to zero. No entrance, scroll-linked or parallax motion is
added.

## Adoption plan

1. Add material and recipe tokens plus `SystemMaterialSurface` support.
2. Add and export `SystemFloatingHeader` with native/Web styles.
3. Make `SystemPage` the management adoption point.
4. Replace desktop conversation and compact primary header chrome with the shared primitive.
5. Add representative management and conversation variants to Style Lab.
6. Remove obsolete primary-header separators and local transparent-surface declarations.

No resource-directory, sidebar or nested panel header is migrated in this change.

## Verification

- primitive tests cover the four layout/density combinations (wide-pointer, compact-pointer, wide-touch,
  compact-touch), active/inactive material, border, shadow and accessibility pass-through;
- `SystemPage` tests prove Task, Agent, Computer, Member and settings pages inherit the primitive without local chrome;
- workspace tests prove Channel/direct headers use the same primitive and preserve search/member actions;
- compact tests prove no vertical header stacking or viewport push-down;
- token ownership tests reject raw primary-header border, radius, blur, shadow and inset values outside the primitive;
- Style Lab contains light/dark and pointer/touch examples;
- screenshot baselines cover management, conversation and compact variants;
- add `web/apps/client/tools/verify-floating-primary-header-layout.ts` as the browser-visible preview gate. It measures
  `message-stage`, `conversation-primary-header`, `message-viewport`, `system-page`, `management-primary-header` and
  `system-page-content` at 1280px, 961px, 959px and 900px pointer viewports, plus a wide touch baseline. It asserts:
  stage/page root top and height remain stable during header material changes; header height never grows through
  wrapping; header left/right/top are inset from their owning stage; message/page content begins below the header and
  reserved shadow clearance; error toast and operation island top positions are at or below the header slot; no box
  overlaps its primary header. The tool writes the measured boxes and screenshots into the release evidence directory;
- focused Jest suites include `floating-primary-header-layout.test.tsx`, which locks test IDs, normal-flow positioning,
  layout-mode propagation and shared `stageTopOverlayInset` ownership;
- `theme-contract.test.ts` proves recipe namespace/leaf ceilings and validates new material keys;
- focused Jest suites, TypeScript check, TUI reproducible build check, Web export and `git diff --check` pass.

## Non-goals

- redesigning sidebar or collection navigation;
- changing header content, labels, permissions or actions;
- adding a global marketing-site navigation bar;
- introducing arbitrary glass variants or per-screen appearance props;
- making every nested header float.
