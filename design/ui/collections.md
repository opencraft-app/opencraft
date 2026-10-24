# Collection and management pages

Use this pattern when the user needs to find an object, understand its state and
open or act on it: task catalogs, schedules and other management lists. A Settings
form instead helps the user edit configuration values. A collection may reuse
Settings components without adopting a label/control form for every object.
Start with the [design entry](../../design.md) for semantic tokens and typography.

This is composition guidance for implementation and review. Existing pages are
consumers to inspect, not certified visual examples. This document alone does not
migrate them or prove that an Agent will follow the rules.

## Inspect the owners before composing

| Concern | Existing owner / consumer to inspect | What to reuse or check |
|---|---|---|
| Page viewport, content inset and scrolling | [SettingsContent](../../apps/workbench-web/src/components/settings-page.tsx), [Workbench route styles](../../apps/workbench-web/src/styles/app.scss) | Inspect the final route selectors as well as the component. `document`, `master-detail` and `edge-to-edge` have different geometry contracts. |
| Headings, sections and object rows | [Settings controls](../../packages/extension-react/src/settings-controls.tsx) | `SettingsPageHeader`, `SettingsSection`, `SettingsGroup`, `SettingsListItem` supply reusable semantics; a header does not own page padding. |
| Collection integration | [Extension library](../../apps/workbench-web/src/components/extensions/extension-library.tsx) | Inspect how a real collection consumes object state and management actions; retain authority and capability boundaries. This consumer still needs a separate visual assessment. |
| State, focus and touch density | [Shared controls](../../packages/design-system/src/controls.web.scss), [Web tokens](../../packages/design-system/src/tokens.web.scss) | Select supported variants and preserve focus/disabled semantics; a small visible glyph still needs the shared touch target. |

Before coding, record the user's main task, selected pattern and consumer, page
container owner, and action priority in the existing task notes. Identify any
shared capability gap and its owner. No new document or user approval is needed.

## Build one reading order

1. Page title and a short supporting sentence when needed. Keep page-wide actions
   in a predictable header or toolbar slot. Let the title keep enough space for
   localized text; wrap actions deliberately when capacity is insufficient.
2. Group identity and relevant group state. Group by something that helps the
   user locate or operate on objects, such as their server. Repeated display
   names need an authorized, human-readable distinguishing label when available;
   do not expose private endpoints or invent identity metadata.
3. Object title, state and the next useful fact, such as next execution time.
   Use the existing body and metadata roles. Avoid a separate sentence for every
   property or a badge where ordinary supporting text communicates the state.
4. A clear opening destination and subordinate actions. Keep their relative
   positions consistent across rows. Provide accessible names and native
   keyboard behavior; do not nest action buttons inside another button.

Use section rhythm and alignment before adding surfaces. A group can have one
shared surface and row separators; every heading, status and action does not need
its own card. Empty space after a short list is natural and should not be filled
by enlarging controls or stretching the rows.

## Give actions scope and priority

| User intent | Default composition | Avoid |
|---|---|---|
| Open an object or conversation | An accessible title/destination or established navigable row; other row actions remain independent | Two equally prominent bordered buttons competing with the object title |
| Perform the main transaction | One emphasized action in the relevant action group, when a primary transaction exists | Inventing a primary action for a read-only catalog or emphasizing every row action |
| Refresh a catalog | One page-wide refresh with stable pending feedback | Repeating the same prominent refresh on the page, each group and each row |
| Recover one failed group | A quieter scoped retry when it has a distinct effect; preserve the page-wide action if useful | Removing needed recovery for visual simplicity or showing an unexplained disabled action |
| Manage or perform secondary actions | Supported quiet/ghost controls or an existing accessible menu when appropriate | Handwritten button styling, hover-only essential actions, or hiding everything behind a menu by default |

This is a priority rule, not a quota of one button per page. A destination is not
a primary transaction. Choose only variants actually implemented by the current
owner; if the needed quiet action or touch target is missing, extend that owner
and verify its real consumer rather than merely adding a variant class name.

## Keep page geometry with its owner

The route/Shell owns the available viewport, safe areas and scrolling. The shared
document container owns the content width, horizontal gutter and page rhythm.
The feature owns grouping and row composition within that capacity. An explicitly
edge-to-edge table or canvas must still inset its text and toolbar appropriately.

Check the computed layout in the actual route: a later tool-route selector can
cancel a document container's responsive width even when the component imports
are correct. Repair the shared owner when the contract is broken and check its
affected consumers. Do not scatter compensating feature margins or copy pixel
measurements from a screenshot into a new token scale.

In a narrow container, preserve the reading axis and content inset. Reflow metadata
and secondary actions while keeping the title readable. Do not simply turn every
action into a separate large button row. Wider windows may expose more metadata;
they must not stretch a short reading list across the full window without purpose.
Use actual container capacity, not a device-name branch, and preserve selection,
scroll position, focus and drafts when the layout changes.

## Put feedback at the level it describes

- Server connection state belongs beside the group identity. Task state belongs
  beside the task. Disconnected, empty, unsupported and failed are different facts;
  do not report an unavailable server as having no tasks.
- Cold loading may use the existing structural placeholder or status treatment.
  Cached refreshing retains the rows and uses a stable pending slot. A failed
  refresh retains last-known data when valid and uses the existing notification
  owner; do not append an error card that shifts the whole list.
- Keep persistent unavailable context understandable without competing with object
  titles. Offer only recovery actions that are actually supported. A group-level
  failure must not obscure healthy groups or reset the list's scroll position.

## Compare a complete composition

The text sketches describe hierarchy, not fixed typography, dimensions or a new
widget API. They do not change which actions the product actually supports.

```text
Prefer                                     Avoid
Page title                 Refresh         Page title                 [Refresh]
Short supporting copy                      Long instructions taking the main space

Server A · Connected                       Server                      [Refresh]
  Task title                                [Full-width status card]
  Paused                  Open · Manage     [Task card]
                                              Task title
Server B · Disconnected                        Paused
  Last-known data, if available                [Open conversation] [Manage]
```

The preferred version still needs real controls, touch targets, text wrapping and
state verification. Replacing borders with text does not by itself make it pass.

## Verify the composition

For a new or materially changed collection, review the rendered page in its real
Shell and route with narrow and wide capacities, light/dark themes, long localized
titles and meaningful mixed states. For a small fix, cover the affected subset and
the shared consumers at risk; do not turn this into a global screenshot gate.

Use multiple groups, duplicate labels and active/paused/unavailable examples when
those states exist in the product. Include empty, cold loading, cached refreshing
and refresh failure as applicable. A single online group does not represent a
multi-server page. Keep fixture data synthetic and state the external boundaries.

Check these observable outcomes:

- Title, group and object text align to the intended reading axis. Content has the
  container's expected inset, and toolbar actions do not crowd out the title.
- Object names and useful state remain readable. The visible hierarchy reflects
  user priority; repeated buttons, cards or large instructions do not dominate.
- Relevant actions stay reachable with touch and keyboard, including visible focus
  and independent secondary actions. Test touch with a touch-enabled browser
  context and touch input; changing viewport width alone tests only layout.
- Refresh and failures preserve valid rows, focus, scroll and stable geometry.
  Navigation and return preserve the existing state contracts.

Add objective assertions to the existing consumer smoke when fixing a measurable
layout defect: expected container insets, title/action bounds, target capacity or
state geometry. Demonstrate that the previous implementation fails the relevant
assertion. Derive expectations from the current owner and user requirement,
not arbitrary screenshot pixels. No-overflow checks alone cannot catch missing
gutters, poor emphasis or redundant actions.

Inspect the rendered composition or its captured images for hierarchy and rhythm;
merely writing PNG files is not a visual review. Record what was inspected and
which assertions ran. A screenshot alone cannot prove touch behavior, keyboard
accessibility or state continuity. Distinguish source/document checks, browser
fixtures, installed-product checks and physical-device evidence in the handoff.
