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

## Retiring a development deployment

A stopped deployment's current databases, credentials and installed release are
recovery state. An absent process reference does not make that state disposable.
Before stopping services, inspect Codex home and BB routing configuration, live
TCP/Unix clients, reverse systemd dependencies and each nginx instance's config.
Stop if another application consumes the deployment. A dedicated OpenCraft nginx
unit can be stopped independently of shared preview, BB HTTPS or other sites.

Record the exact units, enabled state, effective entry points and retained
dependencies in ignored `.local/maintenance/retirement-<date>/README.md`. Keep
private unit snapshots there with restricted permissions. Disable persistent
units before stopping consumers, routers, generation workers and providers in
that order. Stop transient Codex and PTY units explicitly; they have no persistent
enable links and are recreated by their owner after restart. Check that all
recorded PIDs exited, listeners disappeared and no enabled socket, timer or
external unit will reactivate them.

Retain one current release per deployed role and its actual transitive runtime
dependencies. Preserve databases, keys, private configuration and admin/daemon
tokens. Archive superseded deployment pointers, clear rollback references to
deleted releases, and check retained symlink targets before deleting history.
Measure allocated bytes before and after using the same roots. Verify preserved
database and credential hashes after cleanup.

For an existing installation, restore only the selected role with
`systemctl start <recorded-unit>`; use `systemctl enable <recorded-unit>` separately
only when boot startup is wanted. Do not replay every historical unit or restore
archived configuration over a newer deployment. Reinstalling into an external
state root remains the preferred path for a new deployment.

## Compose releases and completed acceptance artifacts

A source build's temporary-output default does not control an operator's explicit
copy/download destination. Compose release trees and acceptance copies therefore
need their own lifecycle, even inside an otherwise retained owner directory.

The cleaner inspects `.local/<owner>/compose/releases` (and the equivalent under
an audited root) separately from the owner's configuration. It keeps `current`
and `previous` symlink targets. Before publishing a new `current`, record the old
current as `previous`; run cleanup after acceptance. For older installations
without `previous`, the newest other release is retained as a rollback fallback.
A missing, invalid or broken pointer keeps all releases until the owner repairs
it. An uninspectable or symlinked release root also keeps its owner directory. Other symlink targets, credentials, process references, Docker bind mounts (including stopped/created containers)
and explicit protected roots also keep a release. The containing owner directory
is retained. Within a managed release's `artifacts/dsh-runtime/node_modules`,
SDK implementation/type/source-map filenames containing `token` or `credential`
and the bundled provider token-plan data are dependency source, not private
credential files. `.env`, key/PEM files, other credential/token data files and
protected directory names retain their protection there too. This bounds ordinary deployment history to two copies without
relocating a live bind mount or invalidating a stopped deployment's recovery.
New deployments should still use an external state root.

A workbook is not disposable. The cleaner only reclaims acceptance artifacts
explicitly listed by their owner after acceptance has finished. In a direct
child stage of `.local/steward`, write `.opencraft-disposable.json`:

```json
{"version":1,"paths":["official-image/container-amd64-REVISION.zip","ready-package","reviewed-package"]}
```

List only re-downloadable archives and reproducible staging copies. Keep the
verification receipt (artifact ID, source revision, digest and acceptance result),
workbook, requirements, Git history, recovery data and credentials outside these
paths. Do not declare unfinished acceptance or the sole rollback copy disposable.
Relative paths cannot escape the stage or traverse symlinked parents; missing
paths make repeated cleanup harmless. The usual credential, protected-directory,
process, container and operator-root checks still apply. A protected parent root
also protects these children: narrow an obsolete blanket operator root to the
actual recovery dependencies before expecting granular cleanup to reclaim them.
Owner pointers, declarations and process references are checked again before
removal. An inaccessible Docker daemon retains candidates rather than assuming
its mounts are absent; a host without Docker uses `/proc` alone.

Prefer a temporary workspace for new downloads and acceptance copies:

```sh
node scripts/maintenance/artifact-workspace.mjs -- sh -eu -c '
  archive="$OPENCRAFT_ARTIFACT_WORKSPACE/container-amd64.zip"
  gh api "repos/$REPOSITORY/actions/artifacts/$ARTIFACT_ID/zip" > "$archive"
  printf "%s  %s\n" "$EXPECTED_SHA256" "$archive" | sha256sum -c -
  # Run acceptance here; save the small verification receipt outside this workspace.
'
```

The command exports `OPENCRAFT_ARTIFACT_WORKSPACE` in the OS temporary directory
and removes it on success, command failure, or a handled SIGINT/SIGTERM. Build
preview/ready/reviewed copies there too and keep all their consumers inside the
command's lifetime. Installed releases and asynchronous installers must retain
an independently owned copy before this command exits. SIGKILL or a host crash
cannot run cleanup; abandoned temporary directories can be removed after checking
references. No service is restarted or stopped by either maintenance command.
