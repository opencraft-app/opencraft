# Workbench design language

The target sidebar and draft target picker use the existing workbench palette,
typography and surfaces, not a separate LightVela theme.

## Ownership

- Host identity groups tasks. Display names are labels, never identity keys.
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

Header toolbar controls consume `toolbar.web.scss` and the corresponding
`--*-toolbar-control` tokens. That contract owns control height, radius,
typography, inline padding, content gap, icon and chevron scale, bounded menu
width and list density. Feature adapters provide semantic values and visual
roles such as `local` or `remote`; they do not choose concrete icons or repeat
toolbar geometry in feature CSS.

- Target headings have no permanent border or filled capsule, and no task count.
- Task rows are single-line; repeated usernames are omitted. Full identity stays in the tooltip.
- Every current navigation destination gets one persistent selection surface;
  hover remains transient and must not double as location state.
- Target creation is revealed on hover/focus on fine-pointer devices; touch keeps it visible.
- Show more is a quiet text action, not a full-width outlined button.
- Composer displays the selected target name and health. Transport type/location
  remain secondary details in the target menu, not duplicate labels in the toolbar.
- Ready is filled green, connecting/reconnecting amber, error red, idle hollow.
  Accessible labels accompany every dot; color is not the sole signal.
- Anonymous sign-in is an action and uses the shared login glyph without an
  avatar surface. Authenticated accounts are identities and may use a photo,
  initial or neutral user fallback inside the shared avatar container.

Do not override global button styling: new quiet controls explicitly opt into
the shared mixin, avoiding native button borders without changing primary actions.
