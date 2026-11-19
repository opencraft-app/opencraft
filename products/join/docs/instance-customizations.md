# Instance customizations survive standard images

The standard image supplies generic loaders and the versioned, administrator-only
`trusted-react-v1` renderer bridge. Vela source, branding assets, plugin selection,
and public presentation configuration are persistent instance data, not build-time
product registration. No Vela factory is added to `products/join/web.ts`.

## Persistent inputs and trust

- Frontend: `OPENCRAFT_USER_PLUGIN_DIRECTORY` contains operator `plugins.json` and
  `public/<plugin-id>/plugin.mjs`/assets. Ordinary approved `user.*` craft remains
  separate (`crafts/`), disabled until user consent, without internal/branding access.
- Backend: the independent `runtime-plugins` selection/VFS and executor contract
  remains unchanged. Frontend installation never starts Python, SMTP, a backend
  plugin or a Hands owner. Executor/Hands run root in the agreed deployment;
  Gateway/Brain stay non-root and Chromium retains its separate drop in privilege.
- Private credentials and business ledgers never belong in frontend configuration,
  JS, package receipts or image layers. `configuration` is a public JSON object.
- This is trusted renderer code, not an isolation sandbox. SHA256 checks integrity,
  not authorship. Browser exceptions are isolated by the existing manager/supervisor;
  arbitrary synchronous code, DOM effects or CPU exhaustion are not contained.

## Frontend failure policy

Runtime catalog reads use `loadUserPlugins(...,{isolate:true})`: bad packages are
omitted individually, malformed indices skip operator plugins, and a failing craft
root does not remove healthy operator plugins. A cold optional failure yields a
usable core page and fixed-code diagnostics, never rewritten selection/data.
Duplicate IDs and multiple brand owners fail closed for those plugins, not the core.
Strict default reads remain available to operator validation/compatibility checks.
Craft immutable snapshot/last-known-good behavior remains its original separate
contract. Browser bootstrap also skips invalid descriptors before manager restore;
code verification/import/activation still belongs to the original manager.

## Restoring retained Vela source as data

The offline tool consumes the retained Join product directory, not an entire old
release and not its live data. Review the source provenance and all dependencies
before approving trusted code. Run from the assembled workspace with pinned deps:

```
node products/join/tools/package-vela-instance-cli.mjs \
  /absolute/preserved-join-product /absolute/new-output FULL_SOURCE_COMMIT \
  /private/public-presentation-config.json
```

The optional last file maps plugin IDs to public presentation configuration.
Output contains `user-plugins/` and a receipt. Mount the former outside the image at
the configured operator directory; keep its owner writable only by deployment
administrators. Do not copy the package into the standard image.

Restored packages: `join.server` (brand), `join.support-review` (native review View),
`join.lightvela-test-environments` (native test-environment View). Project overview
is already a standard Join product pack and is not duplicated. MCP Apps are excluded
from migration entirely; do not read/rewrite their database as part of this tool.

The factory bridge shares the host's React, JSX runtime, selected existing Settings
controls/icons, abort combiner and legacy Host projection; `getClient` comes from
current Host registry, not a recreated connection. CSS is installed for activation
and removed on disposal/failure. A package declares its ABI; unsupported ABIs fail
that plugin only. This is a versioned compatibility commitment: keep the bridge or
explicitly migrate data packages before retiring an ABI. It is not blanket
compatibility for arbitrary old source, internal imports or future React majors.

Known source adaptations are explicit in receipts: original mascot share image in
place of a separately generated missing thumbnail; badge queries the approved base
review GET endpoint rather than an unavailable `/count` route. Existing business
review requests, same-origin intent checks and server-side actor authorization are
not replaced by mocks in production. Backend availability is a separate rollout.

## Acceptance and rollback

Use isolated copies, fixed candidate image IDs, no host network/production mounts,
no production identities/worker/SMTP, and a persistent private plugin volume.
Verify desktop/touch rendering of original Views, real logo bytes/manifest/icons,
healthy core under broken plugin/index/root, and admission under denial.
Recreate with a second fixed image using the unchanged instance volume. Compare
plugin configuration/JS/assets by SHA256 and confirm entries/brand remain active.
A synthetic business API proves UI/package wiring, not real Vela provider or email
acceptance. Rollback pairs code with compatible plugin ABI; do not roll back a
migrated core database without its matching backup.
