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
spacing, control radius and connection status colors. `controls.web.scss` owns
the quiet-control reset, hover, keyboard focus, disabled state and status dot.
Sidebar actions, target headers, target creation, disclosure and Composer target
selection consume these primitives. Menus keep the existing `menu.web.scss`
geometry; dialogs retain their established surfaces rather than adopting navigation styling.

- Target headings have no permanent border or filled capsule, and no task count.
- Task rows are single-line; repeated usernames are omitted. Full identity stays in the tooltip.
- Only selected tasks get a persistent selection surface. Hover is transient.
- Target creation is revealed on hover/focus on fine-pointer devices; touch keeps it visible.
- Show more is a quiet text action, not a full-width outlined button.
- Composer displays the selected target name and health. Transport type/location
  remain secondary details in the target menu, not duplicate labels in the toolbar.
- Ready is filled green, connecting/reconnecting amber, error red, idle hollow.
  Accessible labels accompany every dot; color is not the sole signal.

Do not override global button styling: new quiet controls explicitly opt into
the shared mixin, avoiding native button borders without changing primary actions.
