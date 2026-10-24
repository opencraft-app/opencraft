# Internationalization across OpenCraft

All first-party user interfaces in `apps/`, `packages/` and bundled `plugins/`
follow the [locale authority](architecture/platform/presentation-and-input.md#internationalization-authority).
This includes Web, Electron renderer and native menus, embedded surfaces, Expo,
settings, accessibility labels, empty/loading/error states and notifications.
A feature being a plugin does not make its UI exempt.

Use stable message IDs with English `defaultMessage` at the owning call site.
React consumes the application's existing Intl provider; imperative services use
its `IntlPort`. Use ICU parameters/plurals and Intl number/date formatting rather
than concatenating translated fragments. Do not create a global translator,
translate rendered DOM, remount an editor to change language, or derive language
from the product region. Keep drafts, selection, focus and pending actions intact.
Use existing system/host language resolution and the explicit application override.
Do not increase a client's advertised languages without providing its catalog.

User messages, generated content, entity names, filenames, URLs, credentials,
protocol/status codes and diagnostic logs retain their original values. Translate
presentation labels around them, including a human-readable projection of status,
without changing identity or persisted domain data. Server errors need an owning
presentation mapping; translating a generic fallback does not translate an
arbitrary `Error.message`. Deliberate brand names and technical examples still
need review when the literal checker reports them.

## Checks and existing coverage

Run `npm run check:i18n` and `npm run test:i18n`. The existing gate/release check
uses the same command. A downstream delivery service can run it in its normal
post-deployment test queue; this policy does not change deployment ordering.

The checker discovers all first-party workspace `src` directories, including new
workspaces. It validates extracted descriptors against the four Web/shared
catalogs and the separate Electron Main catalogs. Native Main does not acquire
Web language options. Tests, fixtures, generated output and locale directories
are excluded. IDs must agree on their English source and catalogs must preserve
ICU parameters. Extract the Web/shared descriptor handoff with
`node scripts/check-i18n.mjs --extract /tmp/opencraft-messages.json`.

It also detects direct JSX text, visible text/accessibility attributes, literal
rendered conditional/logical branches and interpolated templates. New occurrences
fail even if the same text was previously allowed in another file or another
position count. The legacy inventory is
[`config/i18n-copy-baseline.json`](../config/i18n-copy-baseline.json), keyed by
file, syntax kind, exact normalized text and occurrence count. Remove or decrease
the corresponding allowance as copy is migrated. Do not regenerate the inventory
to accept new hardcoded copy. New UI must use descriptors. Explicit intentional
literal exceptions require a narrow reason and review in the same change.

For a file/line inventory run:

```sh
npm run check:i18n -- --report /tmp/opencraft-i18n-coverage.json
```

A passing check reports remaining legacy occurrences and **does not mean the
entire project is translated**. The initial inventory contains feature settings,
plugins and native UI still awaiting migration, as well as names/units/code that
may intentionally stay literal. It is an inventory of candidates, not a confirmed
bug count. Do not count an English fallback as a completed translation.

Static syntax checks cannot follow every identifier, object map, helper return,
server message or imperative notification into the UI. Review those paths at
their owners; a clean syntax report cannot certify them. The checker does not
translate existing debt or supply an Intl provider to an unmigrated native root.
Before claiming a client or feature complete, exercise its actual entry point in
the advertised locales, including loading/error/empty states and a language switch
while work is in progress. Report browser simulation and physical-device testing
separately.
