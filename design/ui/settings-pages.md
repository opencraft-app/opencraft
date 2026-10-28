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

## Switch targets

Settings switches keep their original 36px by 20px painted track and centered 16px thumb. The shared density preference expands the transparent button target to at least 44px by 44px in touch presentation, independent of viewport width. Enlarging a hit area must not stretch the visible track.

## Narrow width

- At phone width the navigation is the shell's. Page content keeps the same header, section, card, and stacked rows. Buttons wrap instead of sharing a line with a long value.
