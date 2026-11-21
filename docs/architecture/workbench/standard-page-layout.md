# Standard page layout

The standard page is not a chat-specific layout. Ordinary conversations, new
conversation drafts, Inbox and Assistants share the persistent Shell header.
Product-provided catalogs can consume the same public contract without importing
Workbench internals.

## Ownership

- Shell owns global navigation, safe areas, header placement and route chrome.
  `AppShellStandardPage` retains a single content root. Existing ordinary/new
  conversation routes use that frame; their existing Shell header remains the
  owner of conversation title and actions.
- Extensions use `StandardPage` with `regions`, `header` and their existing
  content. `PlatformViewRegions.Page` is optional. Older hosts use their Header
  region; unhosted views render an in-flow header instead of losing their title.
  `StandardPageTitle` supplies the shared compact heading typography.
- Features own scrolling, gutters, descriptions, filters, domain actions,
  selection, editors and drafts. The frame does not add another scrollport or
  move content when capacity changes. A header slot is real title/action content,
  not an empty registration used to hide the Shell title.
- A master/detail collection owns one route title. Its retained directory cannot
  also register route chrome. Without selection the master label occupies the
  global header; after selection the detail's Header occupies it, in both split
  and narrow presentations. The detail/editor subtree stays mounted in place.

## Applied design

The primary task is navigating a collection and reading/acting in its detail.
The reference patterns are the persistent conversation Header, existing Shell
master/detail capacity engine, and the existing Assistants collection. The
collection retains its search/filter controls and scroll position; Assistants
retains its description and hire/manage actions. No domain state moves to Shell.
The new contract is presentation-only and does not require additional bottom
slots until a consumer needs them; existing composer owners remain unchanged.

## Focused validation

Run `node --import tsx tests/shell/standard-page.browser.ts` from the repository
root with the normal Playwright browser installed. It uses the real Shell,
Router, route-family retention and IM renderers with synthetic account/channel
transport. It checks one visible global title, no duplicated body title,
Assistants, narrow/wide resize, exact editor identity, draft text, retained list
scroll, horizontal containment, light/dark and touch/mouse input. Screenshots and
results go to `.local/standard-page`.

`OPENCRAFT_STANDARD_PAGE_BASELINE=<old-ref>` substitutes only the previous
master/detail owner as a negative control; the selected-detail header assertion
must fail. `tests/shell/inbox-page-transition.browser.ts` covers retained routes
and shared page transitions separately.

These browser fixtures do not verify authentication, a real IM service, agent
execution, an installed application or native-device rendering. Source changes
are not evidence that a deployed client has been updated.
