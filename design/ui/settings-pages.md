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


## Model connection authentication

The existing Model Services connection form presents an explicit no-authentication
switch only when its Host advertises support. It uses the shared Settings row and
switch, alongside the endpoint and key fields. Selecting it clears unsaved key
input and hides the key editor; switching back requires an explicit credential
choice. Save and cancel keep their existing roles. The shared Settings Shell owns
scrolling and page gutters; narrow/touch presentation keeps the description and
switch reachable without a second configuration page.

## Settings as a peer sidebar destination

Settings categories occupy their own sidebar list, alongside the separate
conversation list and application catalog. The application catalog must not be
prepended to Settings. Choosing Applications hides retained Settings context and
suspends its bottom action portal; choosing Settings restores its categories.
Touch settings shares `SidebarReturnToApp` with Applications in the bottom-left
Shell action host. The persistent Header keeps the sidebar trigger and omits the
redundant return arrow. Direct entry can open the drawer and return through the
existing navigation transaction without relying on browser history; independent
management dialogs retain their own close controls.

The Settings footer entrance is list selection, not page navigation. It keeps the
current main page visible in the split and publishes only the categories and bottom
return action. Before a category is selected, no category claims to be the active
page. Explicit category selection uses the normal Router transaction and dismisses
the touch sidebar. Shortcut and direct-route entry remain route navigation.

## Shared sidebar reading inset

Applications and Settings category lists use `NavigationList inset="sidebar"`.
The shared list owns `--padding-sidebar-content-inline`; app/settings wrappers
must not add another horizontal gutter or a width-specific substitute. Touch
Shell brand, conversation roots and bottom action edges consume that same token.
Rows retain the shared navigation row padding, leading glyph slot and content gap.
The list exposes `--offset-navigation-content-inline` from those current row
metrics so Settings headings align with the leading glyph. Dialog/standalone
navigation retains the default list inset. Check actual row, glyph and label
coordinates across both destinations, plus changing the shared inset once.

Sidebar rows reserve `--size-sidebar-navigation-leading-slot` for artwork of
different semantic sizes; a shared grid keeps label starts independent of SVG
width. Leading glyphs are start-aligned without a consumer-specific margin.


## Model capability review

A model action opens an inline capability section in the existing Model Services
Detail; it does not create another Settings destination or scroll owner. The
section uses shared Settings inputs/buttons for context/output limits, a primary
metadata lookup and a separate optional inference verification action. Verification
states its possible cost before activation. Source, suggested value, and whether an
existing declaration will be retained are readable together. Unknown stays unknown;
parameter acceptance is distinguished from actual image/text verification.

Lookup results are a preview. Filling only compatible blank fields is explicit;
manual values and negative declarations are retained. Length edits have their own
save action. Responses arriving after a connection edit cannot replace that draft.
On narrow/touch layouts, inputs and actions wrap within the Detail's existing
insets; the metadata value and source wrap independently without horizontal scroll.

## Image model services

The existing provider creation form offers image generation when the Host declares it. An image provider uses the same Detail, credential form, model rows and menus, with an explicit full-endpoint label. A quiet notice explains that this default applies to non-subscription Codex image tools. Image defaults are separate from chat defaults; image rows do not show chat context/reasoning controls or issue implicit discovery/inference checks. Existing Settings page insets, scrolling and touch controls remain the owners.
