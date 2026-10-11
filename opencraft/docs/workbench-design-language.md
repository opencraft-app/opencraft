# Workbench design language

The target sidebar and draft target picker use the existing workbench palette,
typography and surfaces, not a separate LightVela theme.

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
`--codex-main-surface-elevation`: soft shadows, thin strokes and flat variants
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

Hover capability and the last input are separate facts. The Web document marks
touch/pen contact until a real mouse move; shared controls and menus apply
transient hover only when a fine pointer is active. This is document-level so
Radix portals consume the same signal. Keyboard focus-visible and persistent
selected/open states remain independent, including after touch input. Coarse
or touch-only devices receive 44px Settings action and menu targets; theme
identity changes semantic colors, not this interaction contract. The Codex
account disclosure stays separate from its actions trigger: touch scrolling
does not paint a mouse-hover row, while actions remain visible and reachable.

Primary Sidebar routes also share one leading icon slot and text axis. A route
group may retain its own accessible navigation landmark without rendering a
visual heading; section separation comes from the Shell spacing tokens rather
than stacked feature margins.

The persistent desktop titlebar rail mirrors Codex's disclosure rule: while the
Sidebar is open, Start is the single new-task affordance; while it is hidden, a
16px Write action appears immediately after the Sidebar toggle and dispatches
the same `navigateToHome` intent. The transient floating Sidebar never renders a
second Write action. Dynamic registration participates in the rail's measured
width and macOS safe-area geometry instead of overlaying window chrome.
On narrow viewports, the conversation identity starts immediately after that
measured rail; the rail's trailing inset already provides separation, so the
desktop context inset is not added a second time. Action hit targets and the
native drag region remain unchanged.

Right Panel visibility and width mode are separate controls. The global Header
toggle owns open/close. The panel toolbar owns explicit maximize/restore width;
when the Shell must auto-expand the panel because split space is unavailable,
it renders no duplicate `Back to chat` or ineffective width action.

Frost is an optional core palette for the translucent desktop treatment. Its
light Sidebar uses the fixed material `rgb(226 244 250 / 35%)`; this constant is
intentionally independent of Codex's 70% client material. Theme identity remains
orthogonal to Light/Dark/System appearance mode.

Lavender is an optional opaque core palette derived from LightVela frontend's
quiet purple vocabulary. It supplies a complete window, Sidebar, panel, input
and popover hierarchy through the same semantic theme contract. It does not
change component geometry, typography or density, and feature CSS must not
special-case its theme ID.

Header toolbar controls consume `toolbar.web.scss` and the corresponding
`--*-toolbar-control` tokens. That contract owns control height, radius,
typography, inline padding, content gap, icon and chevron scale, bounded menu
width and list density. Feature adapters provide semantic values and visual
roles such as `local` or `remote`; they do not choose concrete icons or repeat
toolbar geometry in feature CSS.

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
