# IndexedDB database identity migration

Current owned Web database names use OpenCraft. The extension backend writes
`opencraft-extension-data`; Host profiles write `opencraft-host-connections`;
the Workbench sidebar writes `opencraft-sidebar-layout-v2`. The standalone sidebar
adapter default is `opencraft-sidebar-layout`. Replica storage defaults to
`opencraft-appserver-replica`, and Expo Web selects `opencraft-workbench-replica`.
Each owner supplies its exact former name, using the same product/server partition.
Explicit caller-provided database names remain opaque and do not infer an alias.

The shared browser adapter performs migration before the owner's normal open:

1. An existing current database is authoritative, including intentional deletions.
   Never merge historical rows into it or reimport a cleared cache on restart.
2. Probe only the specified names. A missing probe is aborted before database
   creation; no database-name enumeration or unrelated product discovery is used.
3. If only the former database exists, advance it beyond the known former writer
   version and record its destination. This version change releases cooperating
   old handles. A blocking old window produces a bounded failure, cancels a late
   upgrade and leaves startup recoverable after closing that window.
4. Snapshot all original stores in one read transaction. Create the destination's
   schema, indexes and rows in one version-change transaction. A failed copy
   creates no partially initialized destination; retry reads the retained source.
5. The owner then performs its normal schema open/upgrade and writes only the
   current database. Host IDs, recipes, observed machines, extension document/CAS
   revisions, sidebar ownership and Replica scopes/cursors are not renamed.

The source remains a historical recovery archive. Its handoff version prevents
known fixed-version old writers from reopening it as a second live authority.
An old application binary therefore cannot transparently resume writing that
archive after handoff. Recovery/downgrade requires an explicit, isolated export
or restore; startup neither deletes the archive nor silently chooses empty state.
Unknown newer source versions and unsupported auto-increment stores fail visibly.

The Web extension settings/installations databases from the earlier split layout
remain exact read-only import sources. Electron extension documents use their
existing private SQLite owner; this browser migration does not change it. Expo
native SQLite Replica storage is a separate platform owner. Published SQLite
migration SQL and checksums are unchanged.

Tests exercise real consumers with fake IndexedDB for deterministic failure and
concurrency cases, plus real Chromium IndexedDB and production Web startup. Local
source verification does not imply migration of an installed user profile.
