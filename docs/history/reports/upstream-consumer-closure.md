# Upstream consumer and build closure review

Review baseline: public main `bfa1f784c4ca5778e0ef5d6df63346a86036be4a`,
with the developer-tool portability change in [PR #39](https://github.com/opencraft-app/opencraft/pull/39).
This is a source/build boundary review, not an OS, external-account or production
deployment acceptance record.

## Ownership and inputs

The public workspace owns the shared domain packages, full Web/Electron/Expo
clients, local execution and public build tools. Trusted local product entries
compose private providers, accounts, brand assets and product behavior outside
that workspace. No product is selected by the default entries.

At this baseline, all 425 script/test path references in root npm commands resolve
to tracked files or matching file globs. The root, DSH and companion-client
lockfiles contain only public npm registry URLs and local workspace links; the
one explicit `file:` manifest dependency stays inside the public repository.
These checks establish input closure, not dependency security or runtime correctness.

Legacy package, route and persisted identity names remain compatibility contracts.
Their spelling alone is not an import or a reason to migrate user data.

## Validation boundaries

- Public gate: workspace types, platform boundaries, runtime tests, Web build,
  startup cache budget, Expo Web export and iOS JavaScript bundle. DSH's separately
  locked runtime is prepared before tests; the final startup suite also includes
  the new developer-input subprocess checks.
- External products: the existing tests actually bundle and execute external Vite,
  Headless, Relay and managed-server fixtures, preserve product-owned dependency
  resolution and share the core React instance. Desktop tests inspect real
  Main/Preload bundle closure and execute the generated preload in a VM. Expo's
  resolver/configuration tests cover explicit entries, routes and shared SDK
  ownership; they do not establish native product/device acceptance.
- Portability probes: real Chromium checks navigation-avatar states in light/dark,
  12 sidebar Goal scenarios and 32 adaptive Goal scenarios, including mouse/touch
  completion. Goal evidence was also written under a system temporary directory
  outside the former hardcoded root. One cold browser load timed out; its retry
  passed the interaction sequence.

## Separate follow-up work

Downstream pin upgrades, replay/retirement of recorded product patches, product
snapshot drift and deployment validation remain downstream work. This review
does not integrate pending downstream MR candidates or deploy a product. Native
installers, physical devices and real account/model services require their own
acceptance runs. npm publication remains deferred, and source inventories and
third-party notices retain their existing review status.
