# Web text selection ownership

`@opencraft/design-system/selection.web` owns the shared selection policy.

- Application shell and settings surfaces declare `data-selection="chrome"`.
  Their headings, navigation and incidental labels are not selectable.
- Document/message owners declare `data-selection="text"`. Nested prose inherits
  selection; authors do not annotate every paragraph. File `pre` and alert
  diagnostics also remain selectable. Mark read-only paths/identifiers explicitly
  when they are content rather than navigation labels.
- Native buttons and ARIA interaction controls remain non-selectable inside
  content and outside the shell (including portalled menus).
- Inputs, textareas and editable hosts retain native text selection. Editors and
  terminals retain ownership of their internal selection implementation.
- Plugins use these same surface capabilities; settings services and runtime
  protocols have no selection responsibilities.

Do not implement this with universal descendant rules, copy/selectstart handlers,
pointer cancellation, or Electron drag-region changes. Selection is independent
of keyboard focus, accessibility, clipboard commands and window dragging.

Run `node --test tests/text-selection.test.mjs`. Set `OPENCRAFT_TEST_CHROMIUM` to a
Chromium executable to run the browser cascade test outside the default dev host.
