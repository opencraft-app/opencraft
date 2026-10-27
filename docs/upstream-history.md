# Upstream history and downstream consumption

GitHub `opencraft-app/opencraft` is the writable upstream for OpenCraft core.
Downstream products compose their own identity, branding, enterprise services
and build entries and consume immutable source revisions from this repository.

## Repository history

On 2026-10-27, the canonical repository was re-established with one initial
commit. Its source baseline is commit
`b9b19483b4a16fc13e03b18a807120af3c9f06a4`, tree
`f8e5834558642c81c906ce7735687eec4c8acb3c`, from the
[read-only history archive](https://github.com/opencraft-app/opencraft-history-20261027).
Only the repository-history documentation changes during this cutover; the
complete Web, Electron and Expo implementations are retained. Old commits and
pull requests belong to the archive and are not part of the new Git ancestry.
Consumers pinned to the old history must retain the archive URL or explicitly
adopt a revision from the new repository.

The earlier 2026-10-18 source cutover and its initial commit
`527f579d95ff236739f8c09902db2728d86e7c7b` remain recorded in that archive;
the original private archive is retained separately. Third-party copyright,
license and required notices remain in source and artifacts. Resetting Git
history does not establish redistribution rights or change source ownership.

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
