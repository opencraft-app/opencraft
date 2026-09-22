# Workbench design language

The target sidebar and draft target picker use the existing workbench palette,
typography and surfaces, not a separate LightVela theme.

## Ownership

- Activity chronology groups tasks. Host identity remains per-task provenance;
  display names are labels, never identity keys.
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

Header toolbar controls consume `toolbar.web.scss` and the corresponding
`--*-toolbar-control` tokens. That contract owns control height, radius,
typography, inline padding, content gap, icon and chevron scale, bounded menu
width and list density. Feature adapters provide semantic values and visual
roles such as `local` or `remote`; they do not choose concrete icons or repeat
toolbar geometry in feature CSS.

- Activity sections use Today, Yesterday, weekday or date headings derived from
  the canonical Thread recency timestamp; presentation never parses relative-time copy.
- Task rows use a shared two-line contract: title first, then project identity and
  an optional remote Host label. Local is not repeated on every row; full Thread
  identity stays in the tooltip.
- Every current navigation destination gets one persistent selection surface;
  hover remains transient and must not double as location state.
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
