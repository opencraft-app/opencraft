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
  or dismiss the row hover surface. Touch suppresses transient hover while
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
