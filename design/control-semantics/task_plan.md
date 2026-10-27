# Shared control semantics

The user's main task is a coherent Workbench across touch and pointer/keyboard
presentation. The navigation pattern, shared Settings composition and current
Shell are the working references. Shell continues to own placement, scrolling,
portals, safe areas, dragging and geometry. Features supply actions and values;
the design system owns control shape, density, material and feedback.

## Scope and sequence

1. Move the existing Web button adapter and its styles into the design system;
   preserve the shared button contract and migrate Settings and chrome consumers.
2. Give integrated controls and independently floating controls explicit surface
   semantics. Groups own one background; navigation rows keep their quiet surface.
   Remove global material opt-ins and duplicate chrome/button paint.
3. Enforce ownership with TypeScript and SCSS parsing, negative fixtures and
   checks wired into the normal boundary gate. Keep shared interaction density
   and actual input modality independent of surface and viewport size.
4. Validate real consumers across touch and non-touch presentation, light/dark
   and a contributed palette, controls in progress, keyboard focus, menu/panel
   actions and mode switches with the original draft retained.

## State and continuity

Button feedback projects disabled, loading, selected, open, hover and focus;
domain operations retain their existing owner. Loading replaces only visual
content in the original box. Surface changes do not replace the button or its
children. Existing panel motion, route, editor and Host owners are unchanged.

## Acceptance evidence

Record implementation, focused checks, negative controls, inspected rendered
states and any unverified device/native boundaries in progress.md. No publication
or changes to another task's edits are included.

## Continuation: verification hardening

5. Repair stale verification at the current owner: parse exact SCSS base rules,
   follow lazy module boundaries, and use a real browser/history fixture rather
   than a partial `window` object. Keep the same behavioral assertions.
6. Verify Headless restart against actual platform evidence: Linux process
   attestation permits reconciliation; an unavailable observer remains unknown
   without losing the immutable original submission. Do not fabricate origin.
7. Run the remaining gate stages and start a current-source Electron preview
   with an isolated profile. Check actual menu/density/navigation and draft
   continuity, distinguishing Renderer evidence from native compositor pixels.

## Navigation row surfaces

Settings category navigation uses shared NavigationList/NavigationGroup/NavigationItem.
The list owns the horizontal edge gutter; rows share one geometry for hover,
selection, keyboard focus and activation. The host still owns scrolling and slot
width. Row dimensions consume navigation/density tokens, independently of brand or
icon style. Verify resting/hover/current/focus states in actual Settings, narrow
pointer and wide touch, plus themes and navigation continuity. Negative ownership
fixtures must reject feature padding/paint overrides on these primitives.

## Disclosure state feedback

Composer model, permission, Host and project triggers share DisclosureButton and
the accessory role. The menu remains the only open-state owner; Button projects
rest, hover, held press, open, disabled and keyboard focus. Add/context/attachment
and dictation icon actions use the same Button owner. Remove consumer feedback
and geometry, retain existing Radix/focus leases and all domain operations.
Enforce this with ownership/type negative fixtures and `smoke:disclosures` on
the real local Workbench, including wide/narrow touch and multiple themes.

## Settings container constraints

SettingsRow keeps copy and value readable within its actual allocation; inset
segmented options cannot extend beyond their frame. Theme grids derive their
column count from container space. Validate rendered option/label/hit-area bounds,
container-only narrowing, input density, locales and zoom with
`smoke:settings-layout`; live `smoke:controls` includes this regression. Keep a
negative case for the former shrinking frame with fixed inner tracks.
