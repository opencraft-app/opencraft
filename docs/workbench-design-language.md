# Workbench design language

For UI authoring, start with the [design entry](../design.md), then use this
document for detailed Workbench behavior and material contracts. Task catalogs and
management lists follow [Collection composition](../design/ui/collections.md) for
page hierarchy, action scope, container ownership and rendered acceptance. That
guide is a target contract, not a claim that existing pages have been migrated.

The target sidebar and draft target picker use the existing workbench palette,
typography and surfaces, not a separate the downstream product theme.

## Scheduled task catalog

The scheduled task document uses the shared SettingsContent width, inset and
scroll surface. Tool routes do not override document geometry; master-detail and
edge-to-edge pages retain their explicit layout contracts. Server groups use
quiet heading/state lines and separated task rows. The task title opens its
conversation; an independent quiet action opens the existing schedule manager.
One page refresh covers discovery and all eligible groups, with stable pending
feedback. Cold loading, empty and disconnected groups are distinct. Cached rows
remain through refresh and failure; errors use the shared notification owner,
without inserting a card above the list. Connection state is shown beside the
group identity and cached provenance is available on that state label. Creation
remains in the conversation menu; the catalog does not own scheduling or writes.

## Ownership

- Activity chronology groups tasks. Stable Server identity remains per-task
  provenance; Hub route, tenant authorization and Host placement are not copied
  into the task identity.
- `serverOrigin.serverId` owns the origin badge identity. Display labels are
  mutable copy; route, engine/provider, Host placement, connection health and
  Thread activity remain separate facts and never change the Server color.
- The runtime supplies connection phase. A status dot does not initiate a connection.
- Selected task, chosen execution target and connection health are different states.
- Target-local new chat supplies that Host explicitly and does not inherit another Host's workspace.
- A missing selected Host is unavailable, never silently displayed as the first Host.

## Shared presentation

Docked Sidecar and main content keep their theme-owned material and elevation.
In narrow browser Shells, the mobile drawer sits behind a translated foreground
page with rounded leading corners and the existing sidebar elevation. Both layers
read the same gesture progress; neither introduces a separate transition clock.
The foreground card uses its theme radius throughout presence, rather than
animating the radius and repainting the page/shadow on every move. The rear layer recedes to 90% scale and 45% opacity. A stationary full-height
gradient of the theme elevated surface washes the rear layer toward white in
light themes, fading from 65% to zero as it opens, stronger toward the page edge.
Dark themes use their elevated surface; reduced motion disables the wash. The
veil shares the gesture progress and cannot capture input or outlive active presence.
The rear
layer's normal-motion scale/opacity has a compositing hint scoped to its floating
DOM lifetime; reduced motion and desktop retain their existing rear-depth policy.
The translated foreground has a transform hint scoped to mobile presence too;
otherwise masked composer utilities can repaint with each movement even with a
fixed outline. Both hints release when their presentation lifetime ends. The moving card has
no CSS transition property; even under reduced motion its direct progress writes
must not pick up the global minimum transition duration as a second clock.
The page peek is a touch dismissal target, without a dark viewport scrim.
Content-level clickable rows and images are also valid starts for a sidebar
swipe. Horizontal intent is decided by the shared Shell gesture threshold,
not by excluding every button or link. Taps keep their action; an acquired
swipe consumes its synthesized click. Editors, horizontal scrollers and modal
image viewers retain native input ownership.
The mobile drawer composites the selected Sidebar material over its theme window
backing because its body portal has no window-material ancestor. While a floating
panel is mounted, that portal paints the same composite as a stationary
viewport-wide backing beneath the transparent depth-animated content layer.
The content layer does not repaint the full material at a fractional scale.
Top/bottom safe areas
therefore remain continuous during scale/opacity changes; an empty portal stays
transparent as soon as its panel becomes inert/exiting, so a closed drawer
cannot cover the returned page. Its context is
transparent; sticky disclosures and the floating header reuse that same composite
so scrolling content stays occluded without white patches. Palette selection and
Light/Dark mode remain shared with desktop; mobile does not hardcode theme colors.
Desktop floating sidebars retain their overlay presentation.
There is no Sidebar/main edge gradient. The main surface's upper lip extends
left through the compact rail as the existing pane motion runs, completing the
continuous titlebar including the native window-control reservation. Header
owns this paint-only extension and its horizontal hairline; Sidecar owns the
vertical divider below it. Both project the same live geometry/progress with no
second animation clock or mount-completion switch. Pane retirement still owns
content lifetime, never paint timing. Expanded/context and floating materials
remain unchanged; main content retains its surface and edge-scroll policy.
Child navigation and conversation components do not paint their own seam.
The main surface always consumes the existing theme's
`--opencraft-main-surface-elevation`: soft shadows, thin strokes and flat variants
must all survive unchanged. The titlebar treatment cannot disable full-surface
elevation. Its compact titlebar lip consumes that same elevation, including
flat/none; only the lower exposed edge casts into Sidecar, with the joining
edge clipped to avoid a second seam within the continuous main surface. Shadow
geometry follows the existing lip motion, not a separate animation or theme list.
Floating Sidebar overlays also retain their own elevation. The divider
never adds layout space, owns pointer input, or changes resize targets; it follows
live Sidecar geometry. Header remains the sole native safe-area/drag/control
owner and never duplicates native buttons. Forced colors use a system divider.

`packages/design-system/src/tokens.web.scss` owns navigation row height, group
spacing, control radius and connection status colors. The theme engine exposes
one navigation state family: `navigation-hover` is transient,
`navigation-current` is persistent route identity, and `navigation-pressed` is
the pointer-down transaction. `controls.web.scss` is the only owner that maps
those tokens to hover, `aria-current="page"`/selected, focus and disabled states.
Sidebar actions, Work routes, Settings navigation and platform Shell navigation
consume that primitive instead of choosing feature-local backgrounds. Menus keep
the existing `menu.web.scss` geometry; dialogs retain their established surfaces
rather than adopting navigation styling.

The Conversations heading uses equal block padding from navigation section spacing.
Its desktop New chat row is a quiet action with no resting fill or extra top
margin. A closed filter trigger is also unfilled, including when a filter is
selected; active filters retain foreground emphasis and their descriptive label.
Opening or keyboard-focusing the filter uses the existing primary fill, while
hover remains transient. The mobile floating New chat keeps its primary surface.

Unified conversation group disclosures stick within their own section as its
rows scroll; the next group takes over at the section boundary. They share the
opaque context-column surface, keeping scrolling rows from showing through, and
retain the existing quiet button and chevron interaction. Group items isolate
their internal badge/avatar stacking below the heading; popovers keep their
existing portals. Native sticky consumes
the existing desktop list or mobile navigation scrollport without another state
owner. Mobile navigation itself continues to scroll away. In the mobile drawer,
the active heading sits directly below the floating brand header. The scrollport
already reserves that header with block-start padding, so the heading does not
add another toolbar-height offset; scrolled conversation rows cannot occupy a
gap between the header and the active disclosure.

Hover capability and the last input are separate facts. The Web document marks
touch/pen contact until a real mouse move; shared controls and menus apply
transient hover only when a fine pointer is active. This is document-level so
Radix portals consume the same signal. Keyboard focus-visible and persistent
selected/open states remain independent, including after touch input. Pointer
down also records focus origin for portalled menus and dialogs: their restored
focus remains real, while non-editable controls suppress residual outlines.
Escape dismissal and mouse movement do not change that origin; Tab, arrow and
navigation/activation keys restore keyboard presentation. Editing fields retain
their own focus/caret and all controls retain selected/open surfaces and shadows. Coarse
or touch-only devices receive 44px Settings action and menu targets; theme
identity changes semantic colors, not this interaction contract. The
account disclosure stays separate from its actions trigger: touch scrolling
does not paint a mouse-hover row, while actions remain visible and reachable.

Primary Sidebar routes also share one leading icon slot and text axis. A route
group may retain its own accessible navigation landmark without rendering a
visual heading; section separation comes from the Shell spacing tokens rather
than stacked feature margins.

All Web surfaces consume `controls.hover-capable`, including Composer, content
toolbars and plugins. It combines fine-hover capability with the document's
current input, and supports both nested rules and complete root selectors.
Split hover from keyboard focus, open and selected branches before applying the
gate; do not gate the complete state list. `controls.touch-input` keeps essential
copy, edit and card actions available on coarse devices and after hybrid touch.
Neither helper changes the saved touch-density preference. Hover convergence must retain the startup resource budgets. Hover entry handlers
must distinguish mouse pointers; touch and pen activate through explicit actions.
Separate HTML documents bind their own input signal. `npm run check:hover`
enforces these rules for first-party styles and hover entry handlers, including
Relay and inline HTML styles. Each selector/media alternative must carry its
own guard; mentioning a mouse comparison is insufficient unless it precedes
all effects on non-mouse paths. Gesture movement retains its matching pointer
owner, and portal dismissal cancellation retains continuity. Product source
roots can be passed as extra directory arguments. The PR build runs the scan,
negative policy tests and real Composer input smoke independently of build
selection; downstream products include their own roots in post-deploy checks.

The usage heatmap distinguishes mouse/keyboard preview from explicit cell
selection. Touch and pen entry cannot create a preview; tap or keyboard activation
toggles selection, which remains visible outside the hover gate. Outside-range
cells are disabled and cannot preview unqueried dates as zero usage; the existing
daily table retains the textual alternative.
Large bar values wrap within their numeric column rather than painting outside
the chart card. The seven-row matrix uses bounded square cells even for short date ranges, so
its caption and controls remain readable together. Daily and weekly charts show
at most the latest 26 weeks; cumulative bars retain the usage from the entire
selected range, including days before the first displayed week. The daily table
and summary retain the complete selected range. Missing coverage remains partial;
a model with unknown identity can still have a known token amount. If an older
response omits the optional settled-turn count, show an unknown count rather
than relabeling every turn as settled. A known empty range still has zero turns.

The persistent desktop titlebar rail has one disclosure rule: while the
Sidebar is open, Start is the single new-task affordance; while it is hidden, a
16px Write action appears immediately after the Sidebar toggle and dispatches
the same `navigateToHome` intent. The transient floating Sidebar never renders a
second Write action. Dynamic registration participates in the rail's measured
width and macOS safe-area geometry instead of overlaying window chrome.
On narrow viewports, the conversation identity starts immediately after that
measured rail; the rail's trailing inset already provides separation, so the
desktop context inset is not added a second time. Action hit targets and the
native drag region remain unchanged.

Desktop Web conversation titles and user-message navigation ticks share the
main pane’s leading axis (`--thread-navigation-web-inset`, 36px). The rail keeps
its 36px target; prose clearance derives from that inset plus the target width
(72px), hiding the rail when space is insufficient. Sidebar width changes move
both axes with the existing Shell geometry. Narrow headers retain measured
control spacing; Electron retains its native title geometry and 16px rail inset.

Right Panel visibility and width mode are separate controls. The global Header
toggle owns open/close. The panel toolbar owns explicit maximize/restore width;
when the Shell must auto-expand the panel because split space is unavailable,
it renders no duplicate `Back to chat` or ineffective width action.

Frost is an optional core palette for the translucent desktop treatment. Its
light Sidebar uses the fixed material `rgb(226 244 250 / 35%)`; this constant is
fixed by the palette. Theme identity remains
orthogonal to Light/Dark/System appearance mode.

Lavender is an optional opaque core palette with quiet purple surfaces. It supplies a
complete window, Sidebar, panel, input and popover hierarchy through the same semantic theme contract. It does not
change component geometry, typography or density, and feature CSS must not
special-case its theme ID.

Header toolbar controls consume `toolbar.web.scss` and the corresponding
`--*-toolbar-control` tokens. That contract owns control height, radius,
typography, inline padding, content gap, icon and chevron scale, bounded menu
width and list density. Feature adapters provide semantic values and visual
roles such as `local` or `remote`; they do not choose concrete icons or repeat
toolbar geometry in feature CSS.

- Collapsible conversation groups omit numeric counts. Their chevron sits next
  to the label in a stable slot: fine mouse input reveals it on heading hover,
  keyboard focus reveals it, and mobile/coarse/touch input keeps it visible.
  The entire heading remains one accessible expand/collapse button; mobile rows
  retain at least 44px targets. This does not alter group state or persistence.
- Activity sections use Today, Yesterday, weekday or date headings derived from
  the canonical Thread recency timestamp; presentation never parses relative-time copy.
- Task rows use a shared two-line contract: title first, then project identity.
  A fixed trailing origin slot is empty for the default local Server and renders a
  deterministic server-colored globe for remote Server origins. Full Server identity
  stays in Tooltip/ARIA; display-name and Hub-route changes do not change color. The adjacent
  fixed status slot independently renders running/review/error/unread state.
- Every current navigation destination gets one persistent selection surface;
  hover remains transient and must not double as location state.
- An Activity task owns the full row's hover/selection surface. Its independent
  ellipsis trigger has a transparent background and supplies only hit area,
  focus, and menu-open affordance; moving the pointer onto it must not split
  or dismiss the row hover surface. The shared document input signal suppresses transient touch hover while
  retaining the same selection surface and a visible menu trigger.
- Thread status, unread state, pending navigation and row actions share a stable
  trailing rail so asynchronous changes do not shift title or metadata geometry.
- Show more is a quiet text action, not a full-width outlined button. Start and
  the Composer target picker own target-specific task creation; Settings owns
  connection configuration rather than repeating Host controls in each date group.
  The existing task context menu may expose these Host-scoped actions without
  changing the Activity row's resting geometry.
- Composer displays the selected target name and health. Transport type/location
  remain secondary details in the target menu, not duplicate labels in the toolbar.
- Ready is filled green, connecting/reconnecting amber, error red, idle hollow.
  Accessible labels accompany every dot; color is not the sole signal.
- Anonymous sign-in is an action and uses the shared login glyph without an
  avatar surface. Authenticated accounts are identities and may use a photo,
  initial or neutral user fallback inside the shared avatar container.

Do not override global button styling: new quiet controls explicitly opt into
the shared mixin, avoiding native button borders without changing primary actions.

## Folder picker ownership and themes

The folder picker is one reusable Workbench interaction, not a second Project
store. The active Server advertises a browse root and serves directory entries;
the picker keeps only transient path, loading and error state. On confirmation,
the Application registers or reuses a Project and binds the Draft. A browser
picker reads the Server filesystem; a native desktop adapter may use an OS
dialog, but it must return the same selected Server path rather than upload a
client folder or silently change execution target. A directory read error
clears stale entries and disables confirmation until a readable folder is
selected; a path merely appearing in the breadcrumb is not evidence that it
can be used as a Project root.

`ModalSurface` owns the dialog surface, scrim, focus and close behavior. The
shared `Button` owns confirm/cancel variants and their foreground/background,
hover, disabled, focus and loading states. Folder rows and breadcrumbs may own
navigation layout, but must consume semantic theme tokens and typography
roles. In particular, a primary action may not derive its foreground from a
general page background token: that token may be absent in an extension theme,
causing an invalid declaration and inherited unreadable text. Validate the
computed color pair and contrast in light, dark and extension themes, including
the enabled confirm state and long-path/error states, before claiming visual
completion.


## Expo design constraints

The mobile direction uses iOS interaction conventions and OpenCraft semantic roles. It is not a pixel copy of system Settings or a separate feature palette. Constrain implementation choices and observable behavior before changing local appearance. Importing HeroUI is not evidence that a control is correctly composed.

### Owners and composition

| Decision | Owner / constraint |
|---|---|
| Color, material, density and typography | Existing design-system semantic tokens and typography registry. mobile-visual-tokens is the mobile brand adapter; HeroUI CSS variables must project the same roles. A feature must not introduce another palette or font scale. |
| Ordinary editable field | HeroUI TextField, Label, Input, Description and FieldError as needed. The composition owns label, invalid/disabled semantics and its surface variant; the feature owns value, validation and submission. |
| Actions | HeroUI Button variants, or the existing shared Workbench button adapter after documenting its semantic mapping. One primary transaction per action group; navigation, cancellation and secondary actions do not compete with it. |
| Options and preferences | Switch for a boolean, RadioGroup for exclusive alternatives, Select for a collapsed option list, Tabs for sibling content. A checkmark inside a Button does not implement the complete control contract. |
| Identity, rows and feedback | Avatar, ListGroup, Spinner, Separator, Skeleton where applicable. Cache and failure fallback stay outside the component's visual state. |
| Menus and local dialogs | Library Menu/Dialog/BottomSheet composition owns overlay, dismiss and animation. The host owns available viewport, safe area and keyboard admission once. A navigation page or persistent multi-pane surface keeps its existing Shell owner. |
| Specialist editor / runtime content | Rich attributed native text, virtual lists and original embedded DOM retain their own adapters. Do not replace them with ordinary Input to improve a library-import count. |

Before implementation, record the semantic role, current owner, installed API, surface context and expected interaction states. Inspect the installed version instead of copying a newer demo. A missing capability may use a platform adapter with a stated responsibility and verification; it does not justify a new feature control family. Theme/background capabilities are opt-in and must not be inferred from a screenshot or component name.

### Override and state rules

- Feature styles may allocate layout, slots and content width. Color, typography, control radius, focus, pressed, selected, disabled and loading treatments belong to the shared primitive/theme adapter. If a repeated override is necessary, move the role mapping to that existing owner and migrate its consumers together.
- Do not combine a hand-painted border/shadow/pressed layer with the library's animated layer. Never override animation-owned opacity/transform with a second driver. Configure the library's supported variant/animation/background ports.
- Input focus, invalidity, disabled state and selected navigation are distinct. Decide the platform focus treatment centrally; preserve cursor, selection, VoiceOver semantics and Web/external-keyboard focus visibility. Do not globally remove focus indicators to make one iPhone screenshot quieter. The field's resting surface must not change geometry on focus or validation.
- Button optical size and touch capacity are separate. Touch controls must have at least the shared 44-point target; font scaling and long localized labels may enlarge it. Avoid fixed content heights and clipping. Icon roles use the shared OpenCraft glyph/size contract rather than feature-selected alternatives.
- Form presentation reads actual host capacity and keyboard occlusion, preserving field focus, selection and draft during resizing. Short editing/confirmation and navigation/persistent panels are different intents; do not implement every one as a full-width bottom sheet. No device-name thresholds or fixed keyboard height. The host selects sheet/dialog/panel geometry without remounting the form.
- Destructive and transaction commands retain their existing confirmation, validation, pending and failure contracts during component migration. A style change cannot replace domain behavior or hide an error.

### Acceptance and exceptions

For an affected control, inspect the actual mounted surface at rest, press, focus, invalid, disabled and pending states. For fields also check selection, submit, cancel, keyboard show/hide, long text, font scaling, and preservation of draft/focus under resize. On Expo Web include mouse, keyboard and coarse touch; on native include the system keyboard and accessible modal isolation. Check phone and a wide/short container separately; iPad floating/external keyboard and hardware motion require device evidence, not a typecheck or browser fixture.

Maintain the local audit as a migration baseline, not a retrospective blanket ban. For a justified exception, record the missing capability, semantic owner, scope of the override and observable acceptance in the Task Pack. Use that receipt to retire obsolete exceptions on library upgrades. Do not add a global visual test suite or require new screenshot artifacts for unrelated edits.

### Sidebar alignment

Labeled mobile navigation uses the same compact leading edge as section headings, dates and thread titles; the desktop application rail remains centered in its separate column. List actions and the filter share an inline-end inset and control center. Reserve one shared activity/action lane for pending, running, Goal, review, error, unread and idle rows, with or without Host menu capabilities. The content grid has only body and participant tracks; do not reserve an additional status column. Indicator or menu projection must not shift participant badges. One accessible activity renderer remains in that lane; activity and menu dots are mutually exclusive on every input path. At rest, activity replaces the dots; idle rows retain their normal action cue. Menu open or keyboard focus swaps activity paint for dots, as does fine-pointer hover. Touch keeps the existing44px transparent action target over the centered status glyph, so tapping it still opens the menu without an extra cue. Transient branch creation replaces both with its own spinner. Error, review and unread dots all use the existing5px tertiary neutral mark; keep their distinct accessible labels and auxiliary text. Menu descriptions reference that activity label rather than rendering a duplicate status. On two-line rows, avatar/status/menu paint aligns with the title center, with the offset derived from the existing label/metadata line height and body gap. Keep the full menu hit target centered in the row and retain accessible running state. Touch retains44px action targets; font roles, glyph artwork and plugin-owned badges remain unchanged.

The inline desktop New chat glyph also consumes the list row inline inset: Conversations, New chat glyph, group/date labels and conversation titles share the leading edge. Its text follows the glyph with the existing control gap. Mobile floating New chat retains its independent pill geometry; do not apply inline-list padding to that presentation.

Validate this alignment through `node scripts/smoke/shell/smoke-sidebar-alignment.mjs` (real Shell/Sidebar, narrow/wide, both themes, status/capability transitions) and the running-menu smoke; include a live participant badge consumer when changing row geometry.


## Informational type badges

The design-system theme engine owns opaque `--color-badge-{tone}-foreground` /
`background` pairs (blue, cyan, red, indigo, green, purple, orange, neutral).
They retain hue identity across brand accents, derive their background from the
theme panel surface, and resolve text to at least 4.5:1 contrast, including
extension surface overrides. Consume both roles together; do not tint a label
with an undefined generic background or use a brand accent as small body text.

Tasks maps feature to blue, improvement to cyan, bug to red, engineering/harness
to indigo, growth to green, research to purple and operations to orange.
Documentation, task, unclassified and unknown types use a visible neutral pair.
Type text remains the primary meaning; color does not encode workflow state or
priority. Forced-colors mode preserves a system-colored outline around badges.


### Tasks action hierarchy

Tasks has a single primary New task action beside its heading. Board/List,
search, My tasks and Filters form the browse toolbar; active filters have a
count and an explicit clear action. Expanded filters carry field labels.
My tasks is a shortcut to the same assignee filter, never a second task scope.
Desktop refresh is a quiet icon; More contains refresh and the capability-gated
Recycle bin. Compact layout keeps My tasks directly reachable and refresh in
More. Controls retain shared density, theme and keyboard focus behavior.
Recycle bin replaces the heading and offers Back to tasks plus refresh. Browse
controls and creation are hidden there; returning restores the mounted view,
query and editor session. Open conversation stays with its associated card or
detail, where the destination is known. Refresh only reads and does not discard
input, change task state, or navigate to a different view.


### Tasks card activation

Clicking any passive card region opens its detail; the title remains a native
keyboard button. Quick edit, menus and linked conversations retain independent
actions. Description and acceptance criteria remain in detail without ambiguous
card-face presence icons. Board and list have no drag gesture, handle or sorting
preview. Explicit status controls in detail, quick edit and list keep moving
items through the existing CAS command; stored order is preserved. Ordinary
text selection and touch scrolling remain native. The same detail and draft
owners serve every activation route.

### Tasks conversation shortcut

A board card presents its first linked conversation as a single compact, full-width
navigation row: message icon, truncated title, available native activity and an
entry arrow. The softly grouped surface uses existing theme tokens and metadata
text, without default button chrome or repeated count/status paragraphs. Unknown
activity is omitted, never reported as idle; a missing or raw-ID fallback title
uses the localized Open conversation label. Full human titles remain available in
the accessible name and hover tooltip. Additional relationships have a count and
View all action opening the same task details; no new relation or navigation
owner is introduced. Pointer and keyboard activation stay independent of the
card's detail click, and touch targets remain at least 44px high.

### Tasks card action visibility

On desktop, quick edit and more show while hovering, navigating
by keyboard, or using the card's open menu. A mouse click's residual focus does
not keep actions visible after leaving. Moving into a portalled menu keeps its
source actions visible. Touch/compact layouts keep the existing visible actions.

### Tasks detail close action

Task detail uses an X icon at every width, with the localized close action as
both its accessible name and hover title. Shared icon-button geometry owns the
hit target, including touch density; Radix retains closing, busy-state blocking
and focus restoration. No text-only desktop variant is rendered.

### Tasks archives

Archive lives under card More and saved task detail actions; Archives is a board
management destination under the heading More menu alongside Recycle bin. It
removes records from the active board without changing their workflow status.
The archive page searches retained records, opens read-only content/activity,
and restores them to their original column. Back returns to the existing board
projection and filters. Dirty content is saved explicitly before archival.
The actual storage capability gates all entry points; an old Host never gets a
frontend-only archive. This is distinct from the expiring recycle bin.


### Touch Newera floating conversation chrome

Conversation route eligibility is explicit on the shared Header. Touch density plus Newera projects only its existing left/right sidebar and more controls as circular glass surfaces; title/pencil are hidden. The direct preview button keeps its existing position and capability-gated command; the conversation menu retains Rename. Desktop, Newera-off and other route chrome remain unchanged. The shared mobile-glass mixin owns theme tint, blur, elevation and reduced-transparency/forced-colors fallback, including the stationary wide-touch portal. Safe-area spacing and 44px hit targets remain Shell-owned.
The existing Shell top-fade is enabled for this browser presentation, softly blending to transparent rather than painting a solid toolbar. It never accepts input. No duplicate menu, preference, scroll owner or editor is introduced.


Floating controls select the shared material's lighter tint and optical edge:
translucent theme fill, a subtle diagonal highlight, inset rim inside the button silhouette, without any outer shadow.
This makes the silhouette readable over flat surfaces as well as scrolling content.
Search/navigation retain the denser material. Unsupported filters and reduced
transparency/forced colors retain an opaque surface; decoration never changes
the control's geometry or adds another interactive layer.

## Conversation rename dialog

Header and sidebar rename actions share `ConversationRenameDialog`, whose form
stylesheet is imported with the component rather than through the lazy Settings
page. The compact surface uses the existing ModalSurface/Radix focus and dismissal
owner, shared typography, inputs and buttons: 384px maximum width, 20px padding,
full-width input and right-aligned actions. Palette, localization and title authority retain their current owners.
The caller owns the draft and save. Blank names, composition Enter and repeat
submits during saving do not write. Pending disables dismissal; failed writes
retain the draft and use the shared asynchronous notice without changing layout.


## Tasks initial loading

Tasks shows static board/list skeletons until its authority returns the first
successful snapshot. Capability discovery alone cannot reveal counts, empty
columns or filter totals, or enable creation. Skeletons follow the six-column desktop
and selected-column compact geometry, use existing theme surface/track tokens,
and expose one localized loading status with decorative contents hidden from
assistive technology. Cold failures replace the content with a retry action;
they cannot claim there are no tasks. A successful empty snapshot is a valid
loaded board. Background refresh, failure and view re-entry retain the last
successful snapshot, mounted cards, scroll and drafts. No artificial delay,
placeholder records, storage migration or additional persistent cache is needed.

Conversation row actions share the same semantic SVG icons in right-click and More
menus: pin/unpin, edit, fork, archive and delete at 16px, inheriting the
menu text color and existing icon spacing. Display-mode and filter rows retain
their reserved check-indicator column; action icons do not replace selection state.


### Contributed navigation icons

Common action artwork is owned by `design-system-web/action-icons`, including
close/add/check, edit/delete/copy, menu chevrons and more, loading and distinct
reset/refresh/rotate/replay controls. Static model/search/terminal/folder glyphs
consume the same family through the Workbench semantic registry. Supplemental
library icons and identity artwork remain available. The Shell and navigation
adapters retain their existing role sizes, selected fill/stroke, hit areas and
fallback behavior; sidebar/split-toggle artwork is explicitly preserved.
See [action artwork](../design/ui/composer-icons.md) for this shared owner and
its reduced-motion and busy-state boundaries. The optional async-question card
loads its component and stylesheet together on first use, within a boundary
around that card. Question state remains above the boundary, and unrelated
conversation content and draft/editor owners remain mounted. Its styles do not
occupy the startup CSS budget of conversations without a question.


Extensions declare semantic icon names for navigation and settings pages. The Web
adapter resolves every registered name in both standard and classic presentation;
classic sizing, stroke and explicit artwork variants remain presentation-owned.
Classic presentation must not replace a supported contribution icon with the
fallback glyph. Missing or unknown names retain the existing per-surface fallback.


## Neutral frosted glass

The design-system `material.web` mixins and theme-engine `--material-glass-*`
roles own floating materials. The backing is neutral white in light mode and
neutral charcoal in dark mode, never a brand-blue fill. Color comes from the
actual page behind the surface. Only the outer surface filters that backdrop:
32px blur, saturation 1.06. Do not blur the whole page or add another filter to
nested cards. Children separate with quiet tonal fills and existing theme text
roles, not independent palettes or opaque card stacks.

Use readable frost for panels: 64% neutral veil in light mode and 62% in dark.
Menus and search/navigation use the denser 82% veil for compact text. Floating
circular chrome keeps its lighter 32% optical layer and inset-only edge; it has
no outer shadow. Panels and menus may use the shared soft elevation. Their
radius, hit area, sizing, presence and focus stay with existing primitives.
This is a material hierarchy, not a requirement to make ordinary pages glass.
An explicit extension popover color remains authoritative and opaque.

The shared menu material, mobile search/navigation adapter and default
ModalSurface consume these roles. Modal scrims dim without blurring the page;
utility forms, full-screen surfaces and management Settings keep opaque
backings. Reduced transparency, forced colors and unsupported backdrop filters
use readable solid fallbacks. Theme window opacity still describes application
chrome; it does not silently disable popup material. Native Expo retains its
existing static semantic palette adapter; these Web rules do not claim native
blur support or new native appearance behavior.

Validate real portalled menus and ModalSurface in light/dark/custom palettes,
phone and desktop containers, with keyboard focus/dismissal, changing backdrops
and reduced-transparency/forced-colors/unsupported-filter fallback. The approved
reference is readable frost, not a nearly clear pane; background shapes should
be soft color, not readable competing text. Data accents and usage accounting
remain separate from material. A material update does not implement a usage
backend, historical trace or session dashboard.

Release material checks must exercise the minified CSS through the same real consumers. Keep prefixed backdrop-filter before the standard declaration so CSS optimization preserves both browser contracts.


## Utility panel style lifetime

Shared `SettingsPanel` geometry loads with the common Modal stylesheet, before
any account or other contributed utility window can open. The lazy Settings
route must not be the only importer: a fresh Workbench document can open these
windows directly. The panel retains its header spacing, content insets and
container-driven row layout without requiring a previous Settings visit.
Feature-specific Settings styles remain lazy; account providers supply content
and actions while Modal/Radix retains window, dismissal and focus ownership.
## Touch navigation glass groups

Touch Newera conversation chrome uses a leading circular sidebar control and one
trailing capsule for the existing conversation menu and preview action. The two
trailing targets remain independent, with no divider or nested glass. All Shell action densities use this same material; touch and pointer layouts
retain their own hit-target sizes and grouping. Shell owns placement and safe
areas; the design system owns LiquidGlassBackdrop, semantic material tokens and
opaque accessibility fallbacks. A supported live backdrop lens uses a small
geometry-dependent map updated on resize; it never captures content or runs a
scroll/frame loop. Unsupported lens engines retain tint, softened transmission
and curved highlights. Icons, focus rings and portalled menus are unfiltered.

### Shared shell action material

Phone, tablet, wide Web and Electron Shell actions share `LiquidGlassBackdrop`,
`material.liquid` and the same `material-liquid-*` tokens. Sidebar top/compact rail
icons, New chat, footer Settings/account/update entrances and navigation controls
use one backdrop per independent action. The header trailing group keeps one
shared backdrop, fitted to its existing compact action height on desktop and its
existing Newera capsule on touch; never nest glass under each grouped action.
The transcript return/working control and floating Composer change summary reuse
this same material. New chat retains its existing text capsule for emphasis.

Material does not branch by platform or density. Existing owners keep position,
size, labels, icons, actions and keyboard focus; touch retains at least 44px hit
targets while pointer layouts retain compact dimensions. Neutral hover/press
states remain separate from the optical plane. Lists, inline conversation actions,
Composer editing surfaces, dialogs, settings forms and menu items keep their own
semantic styles. Those content-layer controls are outside this Shell unification.

The shared tokens own light/dark tint, prefixed Safari CSS blur and readable opaque
fallbacks for unsupported blur, reduced transparency and forced colors. Safari
uses the existing CSS approximation; physical iOS rendering needs device evidence.

### Live navigation optics

Floating navigation glass uses a rounded shoulder height field. Its normals and a bounded Snell ray offset determine backdrop lookup; a clear curved edge blends into a softly scattered center. A local detail filter derives a theme-colored contrast veil from the current transmitted backdrop. These operations run on the live compositor input, including while content scrolls, without copying the page, polling content, or driving React on animation frames. The geometry lookup is rebuilt only on resize. This is a 2D optical approximation, not a volumetric renderer. Unsupported URL backdrop filters retain the shared blur/tint fallback; reduced transparency and forced colors remain opaque. Icons, focus rings and menus stay outside the filtered plane.

Prefixed backdrop engines retain the CSS blur/tint path even if a URL passes syntax checking; syntax alone does not establish SVG backdrop rendering support.

Navigation glass keeps a directional edge: a softened upper-leading light and a much weaker lower-trailing shade, without a uniform perimeter stroke. A short neutral contact shadow separates the surface from content, instead of a broad elevated oval halo. Live backdrop softening, neutral tint and a faint reflection across the face complete the material in ordinary and reduced-transparency appearance. Safari uses the CSS treatment as the supported approximation; it does not promise optical refraction. Forced colors retains a system-color boundary without the decorative shadow, and keyboard focus remains owned by the original controls.

### Application desktop

Overhome is the default Applications destination. Its responsive icon grid uses
rounded icon surfaces and localized labels, with one ordinary launch action per
app. Follow the existing neutral page and theme semantics; supply no store
ratings, downloads, promotional rows or placeholder apps. The first catalog
contains Scheduled tasks. Catalog/launch ownership and the retained Chat lifecycle
are defined in [Shell navigation](architecture/platform/shell-and-navigation.md#overhome-and-miniapps).
