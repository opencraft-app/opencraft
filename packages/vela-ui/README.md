# vela-ui

Shared UI interaction primitives for Vela surfaces.

This package intentionally does not own product visuals. It provides reusable
behavior for layers, dismissal, and listbox-style selection so shell, chat, and
future surfaces can share interaction contracts without sharing the same skin.

## Agent notes

- Keep this package visual-agnostic: no CSS classes, icons, product copy, or
  shell/chat-specific DOM.
- Prefer hooks that expose explicit state and prop getters. This makes runtime
  integration obvious to future agents and keeps product components thin.
- Controlled props such as `checked` should always pair with callbacks such as
  `onCheckedChange`; uncontrolled defaults are for local preview state only.
- Floating layers should model viewport collision centrally here. Product
  components should pass estimated size and placement instead of hand-tuning
  popover `left` / `right` values.
