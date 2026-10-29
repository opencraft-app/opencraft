# Settings pages

Settings routes use the shared controls in `@opencraft/extension-react`. A page does not invent its own title, card, row, or notice chrome.

## Page

- One `SettingsPageHeader`: a title, and at most one subtitle line.
- Then one or more `SettingsSection`s. A section has a title and at most one description line. Its action, if any, sits on that title row.
- Each section contains one `SettingsGroup` card. Rows inside the card place the name and optional description on the left and the control on the right. When the row is narrower than both, the control moves under the name. Do not clip a description to a fixed number of lines.
- Actions that apply to the whole section sit in `SettingsActions` after the card, not between two cards.
- A status or error uses `SettingsNotice` inside the section. A success notice is for the action just finished. Do not leave a success box up after the version rows already show the result.
- Every input has a visible name, wired with `htmlFor` / `id` or an accessible name that matches that label.
- Copy follows the active language. A description that is not in that language is omitted, not shown in another language.

## List and master-detail

- A list page uses the same header and one card of `SettingsListItem` rows. The primary action is on the section title row; row actions stay quiet.
- A master-detail page still starts with the same page header. The list and the detail are the section body, not a second visual system.

## Spacing, type, and targets

- Space only on the 4px scale: 0, 4, 8, 12, 16, 20, 24, 32, 40. That is `--spacing` (4px) times 0, 1, 2, 3, 4, 5, 6, 8, or 10.
- Type uses the existing settings roles: `settingsTitle`, `settings-section-title`, `body`, `metadata`, and `control`.
- Metadata text uses `--color-text-secondary`, not tertiary, so 12px copy stays above the contrast minimum.

## Switch targets

Settings switches keep their original 36px by 20px painted track and centered 16px thumb. The shared density preference expands the transparent button target to at least 44px by 44px in touch presentation, independent of viewport width. Enlarging a hit area must not stretch the visible track.

## Names that stay in the active language

These are names, not sentences. A Chinese page may show them as written:

- Product and plugin names: OpenCraft, OpenCraft Theme Pack, OpenCraft Voice Input.
- Package and channel identifiers, such as `@tencent/opencraft-web · latest`.
- Names the user or another system stored, such as a conversation title.

Any other visible sentence that is not in the active language is omitted.

## Narrow width

- At phone width the navigation is the shell's. Page content keeps the same header, section, card, and stacked rows. Buttons wrap instead of sharing a line with a long value. Do not ellipsize a value that the user needs to read, such as a reset time.
- A value that no longer fits beside its name moves under that name and aligns to the same left edge. It does not stay stuck to the right.
- A version, build id, or other identifier uses the registered `mono` family
  (`--font-family-mono`), not a local font stack, and wraps only after `.` or `-`.
  A Latin word or digit run is not split across lines. Family is the only override;
  size, weight, and line-height stay with the row role.
- A list row keeps its action on the name line, at the right, with at least a 44px target. The action does not take a line of its own.

## Environment variable editor

The shared `EnvironmentVariablesEditor` composes these Settings primitives. It
keeps the account/project selection, object rows and a single add/edit form in
one document. Scope changes are disabled while a draft is open, secret values
stay masked after saving, and cancel releases the draft without browser storage.
A secret is replaced through a blank password field; changing it to an ordinary
value requires re-entry. Products provide localized labels and the authenticated
management port. Async failures use the host notice port; input validation has a
stable reserved slot. Runtime availability is owned by the launch adapters, not
by the existence of this editor.
