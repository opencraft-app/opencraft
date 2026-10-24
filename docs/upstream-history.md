# Upstream history and downstream consumption

GitHub `opencraft-app/opencraft` is the writable upstream for OpenCraft core.
Downstream products compose their own identity, branding, enterprise services
and build entries and consume immutable source revisions from this repository.

## Repository history

The canonical repository was re-established in October 2026 with a clean
history whose initial commit is
`527f579d95ff236739f8c09902db2728d86e7c7b`. Its tree
(`b1366cf67fa0bb02d21b7c5ecb087eb9cff7e19a`) contains the complete Web,
Electron and Expo clients. Third-party copyright, license and required notices remain in source and
artifacts. Redistribution rights are not inferred from dependency isolation or
from this repository being public.

## Downstream consumption

A downstream product consumes a pinned, immutable source revision and owns its
product composition outside the public core: account providers, enterprise
services, branding, native entries, deployment and business configuration.
The downstream product owns its pin, product assembly and recorded patches, so
its delivery does not depend on upstream pull-request acceptance. Upgrading the
pin must preserve those patches or stop on conflicts. Complete public clients
build independently without downstream siblings, credentials or private
registries.

Do not use a downstream checkout as a second writable copy of core or replace
an older snapshot over current product work.
Contributions from a downstream repository first land upstream through a normal
reviewed pull request; the downstream product then re-pins to the accepted
revision.

## Agent Console compatibility closure

The downstream product consumes a bounded closure of Agent Console source
generated from its own frontend service. The generated compatibility copy lives
in the downstream product workspace and is owned there together with its
generator, drift check and `UPSTREAM.json`. Generated files are never edited by
hand: change the downstream frontend source and regenerate. The public core has
no frontend or private snapshot prerequisite.

The shared product snapshots likewise live in the downstream `products/<product>/packages`
workspace with their generator and explicit verification commands. The Console
public asset output belongs to `products/<product>/public`; explicit product builds
select that directory with `OPENCRAFT_PRODUCT_PUBLIC_DIR`, and default core
builds do not copy it. Original asset URLs and bytes are preserved. This
ownership transfer does not clear historical provenance or complete a public
release.

Long term, move stable UI primitives, domain contracts and repository interfaces
into explicit workspace packages. Delete each vendored slice only after all
OpenCraft targets consume the package and the full gate passes.
