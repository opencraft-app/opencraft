# Composer action artwork

Microphone, lightning, stop, permission and settings glyphs share the restrained rounded line-art language of
conversation activity glyphs. `packages/design-system-web/src/action-icons.tsx`
owns their SVG artwork. Voice input, Composer controls and settings entrances consume the same exports;
no feature carries a second bolt or microphone path.

Use a simple capsule and open receiver for the microphone, with a matching slash
when the existing voice state requires it. Commands, full-access permissions,
Fast menu actions and the compact Fast indicator use one lightning silhouette.
Fast retains its existing filled enabled state and accessible checked/label semantics.
These are action glyphs, not provider logos or activity rows.

Existing control owners retain geometry: the microphone uses the shared
`ui-composer-input-icon` token (20px normally, 24px on touch), with the existing
44px touch target. Model/menu/compact glyphs retain their respective slots and
labels. The 24-unit action SVG artwork uses 2-unit round strokes and `currentColor`;
small markers and larger touch controls remain optically appropriate to their role.
Do not import the process rail into input controls or reduce the microphone's
existing touch size to make all outer canvases identical.

The same module also supplies common copy/edit/compose/delete/more/add/close,
check, attachment and directional chevron controls. Static model, search,
terminal and folders share its proportions; they never inherit a process cursor
or pulse. The semantic Workbench registry resolves the shared SVG components through
an explicitly typed component resolver,
preserving classic/core role metrics and fallback
selection. Generic file-type frames also use this package; their code/JSON/image
interiors retain the file semantics. Brand/provider artwork and generated avatars
retain their identity. The retained panel silhouettes are exposed through this
package unchanged.

All Web loading controls, including SettingsButton and the startup/recovery
spinner, consume LoadingRingIcon. Existing classes still own rotation, slot size,
reduced-motion and when a busy state is visible. Replacing SVG artwork must not
add a loading state to cached refreshes. Reset/retry, refresh, viewport rotation
and conversation replay have separate exports and keep their original callbacks.

This artwork owns no animation or behavior. Recording feedback remains with the
voice footer; recording, failure/retry, cancel and draft/selection ownership are
unchanged. Decorative SVGs are hidden from accessibility; a supplied label creates
an image role only where the existing consumer needs it.

Validate the real Composer and voice contribution at narrow/wide widths and in
both themes. Check microphone idle/error, Fast off/on in its menu and expanded/
collapsed footer, command/permission icons, original hit areas and stable editor
geometry. Existing dictation and model-menu smoke scenarios retain interaction
coverage. Browser speech/Host fixtures do not establish physical microphone or
external ASR behavior.

The stop control retains its ring and rounded square, and its existing pending
spinner. Read and edit permissions share one folded-page silhouette with distinct
line/code interiors; the permission entrance keeps its checked shield. Settings
entrances share one rounded six-tooth gear with an open hub. Existing color,
selection, danger, disabled and busy semantics belong to their controls.

The left/right split-panel and sidebar toggles are explicitly retained as drawn,
per user feedback. Do not replace their artwork or change their geometry while
unifying action icons. They also demonstrate the desired restrained proportions.

Loading and reset/retry artwork also belongs to `action-icons`. `LoadingRingIcon`
uses the shared progress geometry (faint full track and a foreground arc), with
round 1.5-unit strokes. `ProgressIndicator` reuses it while retaining its existing
24px slot, document-timeline phase and live reduced-motion cancellation. Composer
stop/attachment/transcription feedback retains its existing motion and size.
`ResetIcon` uses one counterclockwise arc and open return corner for model-default
reset, voice retry and attachment retry. Disabled/default state and callbacks stay
with their existing controls. Check a non-default effort returning to its model
default without replacing the editor or changing the draft.

All general Web interface artwork now belongs to this package: navigation and
contribution registries, connectors, alerts, account categories, devices, schedules,
full arrows and links, tools, file frames, media/table/Mermaid controls and timeline
indicators. `icon-glyph` owns the common canvas and decorative/labelled accessibility;
`interface-icons` owns static shapes. `activity-icons` keeps the existing process
classes and source geometry; `timeline-icons` keeps progress ratios, interpolation
and gradient identifiers. Consumers retain their callbacks and motion policies.
The Workbench compatibility activity entry only re-exports shared components.

Interface glyphs use the shared original artwork. Lucide packages and copied Lucide SVG paths are prohibited, including for new image editing controls. The shared `layout-icons` owner provides the sidebar frame and collapse action without a library adapter; consumers retain their public names, slots and callbacks. Image text, crop, fit, undo/redo, sticker and mosaic controls use `image-edit-icons` through the shared action entry. Content sticker previews are content, separate from interface glyphs.

Run `npm run check:icons` to inspect direct imports, re-exports, dynamic registry
inputs and inline control SVG across Web, shared packages and plugins. Test the
policy with `node --test tests/tooling/interface-icons-policy.test.mjs`. Product workspaces
consume the same entry and must be scanned in their own delivery verification.

The shared sidebar/split-panel family is the visual reference for common Web
glyphs: light rounded strokes, complete quiet frames, generous interior space and
only the detail needed to identify an action. The existing paired Shell sidebar-state artwork retains its geometry; generic layout controls use the shared rounded frame.
Use `RoundedPage` for both file types and permission pages so folded corners stay
aligned. Static model choices and reasoning share `BrainArtwork`; only activity
rows add the existing pulse. Semantic openings such as arrows, folder openings and
overlapping objects remain intentional; decorative gaps are not a house style.
Review the entire family at 16/20/24px in both themes, including dense compound
glyphs. Calibrate activity paint bounds at the existing rail owner after geometry
changes; never change global strokes or the Shell sidebar-state glyphs to compensate.

CSS borders, pseudo-elements and Unicode glyphs are also artwork. Sidebar running/opening,
generic Button busy and desktop clipboard progress consume LoadingRingIcon; their existing
state, slot and reduced-motion owners remain. Code copy/success/wrap, task priorities,
IM navigation, Settings search/back and generated overview checkbox/image placeholders
consume the same SVG package. Preserve document text and image alt text, keyboard kbd
symbols, dimension multiplication signs and textual history arrows. Unused legacy loading
CSS is removed instead of declaring an unmounted spinner migrated. The icon policy also
checks generated control characters and CSS-drawn spinners/copy/check shapes. Product
workspaces can pass explicit paths to check:icons; no product path is embedded in the core.


Native input paint also consumes this artwork. `generate-native-control-icons.tsx`
exports SVG alpha masks from the actual React glyphs into the checked generated
stylesheet; never hand-copy paths into feature CSS. The Web native-controls adapter
replaces date/time picker indicators, search clear, checkbox and numeric stepper
paint while retaining the original input, labels, events, focus and system popup.
Forced-colors native fallbacks are intentional accessibility behavior. Engines
without these native pseudo-elements keep their platform controls.

CodeMirror folding uses its supported markerDOM configuration with shared chevron
masks. Its default search panel retains the library commands, keyboard scope and
localization; the owner adapts the close glyph's paint and native checkbox marks.
Check real fold/unfold and search/replace/close behavior after dependency upgrades.
Native disclosures opt into `ui-native-disclosure`; existing explicit SVG summaries
retain their owner. Device toolbar selects retain native selection and focus with
a shared ChevronDown overlay. Unassigned task avatars use a shared person glyph;
assigned initials and profile images retain their meaning. Source checks alone do
not establish coverage of runtime-generated or browser-painted controls.


The Workspace editor configures search in its top panel slot. The floating chat
input may cover the bottom slot on narrow screens; moving the dependency-owned
panel keeps its shared close/checkbox controls reachable without changing search,
replacement, file-save or draft ownership.


Notification status and close glyphs are explicitly provided through the toast
library's supported icons API. Reuse the shared success/info/warning/error SVGs,
ProgressIndicator and CloseIcon; keep notice history, deduplication, lifetime and
owner cleanup unchanged. NativeSelect adapts single-select arrows while retaining
the native element, attributes, ref, keyboard and popup; multiple/size lists have
no arrow. MCP numeric fields opt into the shared stepper paint without enabling
spinners on controls that intentionally hide them. Native disclosure markers use
the existing shared adapter. Check real paint as well as source ownership.

The design-system CSS radio marker is already centrally owned. Browser audio and
video controls remain platform UI; changing those requires a complete accessible
media control owner rather than replacing isolated icons. These explicit limits
and forced-colors native fallbacks are not general Web icon exceptions.


Common interface glyphs need a consistent optical weight at their actual size.
`ActionGlyph` owns a 2-unit rounded stroke for actions, files, alerts, devices,
menus and navigation. Outline navigation uses the same weight in both its token
and Web adapter. Consumers must not restore a thinner stroke in feature CSS;
image, table, Mermaid, citation and native-control adapters inherit the shared
artwork. Semantic selected-state weights still belong to navigation.

Filled marks need area rather than stroke: the three More dots use 1.5-unit
radii and grip dots use 1.2-unit radii, so 14/16px controls remain legible. Keep
their existing centers, slot, color and callbacks. Composer uses a 20px add
glyph, an 18px permission shield and a 14px permission chevron within existing
targets. The scroll-to-bottom arrow uses a 2-unit stroke; touch scales its canvas
to 23px without a separate hairline override.

The paired Shell sidebar-state artwork and settings gear keep their
existing geometry and weight; the gear explicitly retains 1.5 units. Activity
rails retain their calibrated 1.2px effective stroke, and loading rings retain
shared progress geometry. These are separate semantic owners, not feature-level
thin overrides. Collaboration numerals keep their existing font. Review the
whole family at 14/16/20/24px in both themes, including compound glyphs and dots;
then inspect real sidebar menus, Composer, content toolbars and disabled states.

Search overlays and the touch header also inherit the shared SVG weight; their
slot sizing and materials do not carry a separate thin stroke override. Generated
Bot personas are avatar artwork and retain their dedicated body/effect strokes.


Native actions use `@opencraft/design-system-native/action-icons`. The plain
`@opencraft/design-system/action-artwork` catalog owns shared action contours;
Web and Native adapters choose SVG primitives and accessibility independently.
Keep size, color, stroke and disabled-state decisions at existing control slots.
The Native sidebar buttons use the existing `sidebar-toggle-glyphs` filled state
contours and their 20-unit canvas. Do not import Web SVG components into Native
or add a second local drawing when an action already has a shared semantic icon.
