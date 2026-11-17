# Local runtime cleanup

The source checkout is not a deployment state directory. Packaging defaults use
the OS temporary directory, and local source updates delete their temporary
package after the managed updater has reached a terminal state. A deployment
must set `OPENCRAFT_WEB_STATE` (for example `/var/lib/opencraft/web`) and keep
release trees outside the checkout. `OPENCRAFT_WEB_PACKAGE_OUTPUT` remains an
explicit escape hatch when an operator needs to retain an archive.

The cleanup command is for historical files left by older workflows. It scans
every immediate child directory of `.local` and `.runtime`, reports its size,
newest descendant mtime, credentials, and current `/proc` references, and
removes only directories with no process reference and no credential material.
There is no seven-day grace period: an unreferenced historical directory is
eligible immediately. If `/proc` cannot be read completely, the directory is
kept. `team-credentials`, `credentials`, and `private` path components are
always kept and must be handled separately by their owner. `.local/steward` is
the bb-steward workbook root: the workbook, its requirements ledger, and its
local Git history. It is owner data rather than a runtime artifact, so the tool
always keeps the `.local/steward` path (including under an audited root), keeps
any candidate that contains it, and reports it as `reason=protected-steward`
instead of treating an unreferenced workbook as historical runtime data.

```sh
node scripts/maintenance/prune-local-runtime.mjs       # report only
node scripts/maintenance/prune-local-runtime.mjs --apply
```

Set `OPENCRAFT_LOCAL_RUNTIME_ROOTS` to a comma-separated list when auditing a
different pair of roots. On a container or sandbox that cannot see the host
service PIDs, set `OPENCRAFT_LOCAL_RUNTIME_PROTECTED_ROOTS` to the
comma-separated absolute roots named by live units before applying cleanup.
Apply mode appends one JSON record per removal to
`.local/maintenance/local-runtime-retention.jsonl`; the record uses the
`unreferenced` policy and does not contain file contents.

Before applying cleanup on a host with services outside the current process
namespace, inspect their units and `/proc` from that host. Keep every directory
named by a live service, deployment pointer, current symlink, or open file
descriptor. Credentials are reported separately and are never removed by this
tool.
