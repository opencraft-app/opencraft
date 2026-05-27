# VFS Harness

This harness runs a prebuilt `juicefs` binary against real Tencent COS to validate the Litestream writable VFS path end to end.

It is intended to verify the Sprite-like durability contract:

- normal mount and file operations work against real COS
- `meta-barrier` creates a durable metadata cut
- crash before barrier may roll back recent changes
- crash after barrier must preserve recent changes
- deleting local SQLite metadata files still allows recovery from COS

## Prerequisites

- Linux host with FUSE available
- a prebuilt `juicefs` binary built with `-tags 'litestreamvfs vfs'`
- real COS credentials in environment variables

## Build

```bash
cd /home/skipzhang/code/newagent/workspace/juicefs
GOTOOLCHAIN=go1.25.8 GOFLAGS=-mod=mod \
go build -tags 'litestreamvfs vfs' -o /tmp/juicefs-litestream ./
```

## Required Environment

```bash
export JUICEFS_BIN=/tmp/juicefs-litestream

export COS_BUCKET=agentsessiongz-1388575217
export COS_REGION=ap-guangzhou
export COS_ENDPOINT=http://cos.ap-guangzhou.myqcloud.com

export TENCENTCLOUD_SECRET_ID=...
export TENCENTCLOUD_SECRET_KEY=...
```

The harness passes these credentials to the `juicefs` subprocess and uses real COS both for:

- JuiceFS data objects
- Litestream metadata replica objects

## Run

Run a single scenario:

```bash
cd /home/skipzhang/code/newagent/workspace/juicefs
GOTOOLCHAIN=go1.25.8 GOFLAGS=-mod=mod \
go run -tags 'litestreamvfs vfs' ./vfs_harness -scenario mount_smoke
```

Run multiple scenarios:

```bash
GOTOOLCHAIN=go1.25.8 GOFLAGS=-mod=mod \
go run -tags 'litestreamvfs vfs' ./vfs_harness \
  -scenario mount_smoke,barrier_cut,crash_before_barrier,crash_after_barrier,snapshot_restore
```

Run the soak profile:

```bash
GOTOOLCHAIN=go1.25.8 GOFLAGS=-mod=mod \
go run -tags 'litestreamvfs vfs' ./vfs_harness \
  -profile soak \
  -soak-duration 2h
```

## Scenarios

- `mount_smoke`
  - real mount and in-mount file operations
  - create, rename, symlink, xattr

- `barrier_cut`
  - write stable metadata
  - run `meta-barrier`
  - delete local `meta.db` and `.litestream`
  - remount and verify recovery from COS

- `crash_before_barrier`
  - write baseline data
  - force a durable cut
  - write volatile changes
  - kill mount process
  - delete local metadata
  - remount and verify only baseline survives

- `crash_after_barrier`
  - write data
  - force a durable cut
  - kill mount process
  - delete local metadata
  - remount and verify data survives

- `snapshot_restore`
  - shorten snapshot interval for the scenario
  - keep writing long enough for snapshot creation
  - verify snapshot level objects exist on COS
  - remount and verify restore plan selects a snapshot

- `tree_restore`
  - build a larger directory tree
  - include file payloads, symlink, xattr
  - barrier, delete local metadata, remount, verify

- `session_churn`
  - repeated mount/unmount cycles with file IO and `juicefs status`

- `fuzz_churn`
  - deterministic random mixed operations under a recorded seed
  - create/overwrite/append/partial-overwrite/truncate/rename/remove files and directories
  - cover regular-file hardlinks with shared-object verification
  - cover directory rename-overwrite cases and expected-failure state preservation
  - drive dedicated large-file multi-page writes on fixed targets
  - set xattrs and create symlinks
  - periodically force a durable cut, drop local metadata, remount, and verify the full modeled tree
  - verify file payloads using content length plus SHA-256 digests
  - emit replay schema plus checkpoint/final digests in `manifest.json`

- `chaos_crash_fuzz`
  - seeded random operation stream with seeded random crash injection points
  - keeps a durable model and a speculative model
  - crash events kill the live mount without a barrier, delete local metadata, remount, and verify rollback to the durable model
  - commit events force a barrier and advance the durable model
  - preserves reproducibility by recording replay inputs in `manifest.json`

- `periodic_commit_chaos`
  - seeded random operation stream with seeded random crash injection points under a `1s` sync interval
  - keeps a durable model and a speculative model
  - settle events wait for the periodic commit window, crash, and verify that state older than the sync window survives
  - crash events without a settle window must recover to some coherent previously observed snapshot, not a torn speculative state
  - preserves reproducibility by recording replay inputs in `manifest.json`

- `metadata_restore_matrix`
  - exercise graceful remount, crash-after-barrier recovery, and crash-before-barrier rollback in one fixed metadata tree
  - delete local `meta.db` and `.litestream` between each restore step
  - verify files, xattrs, symlink, and hardlink semantics survive as expected

- `rename_semantics_matrix`
  - exercise file-overwrite, dir-to-missing, dir-to-empty-dir, dir-to-non-empty-dir, dir-to-file, file-to-dir, and hardlink rename cases
  - use raw rename syscall for directory-overwrite-sensitive checks
  - verify both success-path state transitions and expected-failure unchanged-state guarantees

- `xattr_restore_matrix`
  - exercise multi-key xattr create, overwrite, delete, hardlink-visible updates, and rename-visible preservation
  - restore after barrier, local metadata deletion, and crash-after-barrier recovery

- `cross_mode_restore`
  - write one fixed metadata tree once, then remount and restore it under multiple runtime maintenance modes
  - verify the same metadata semantics under `full`, `snapshot_only`, `compaction_only`, and `off`

- `local_meta_write_failure_recover`
  - mount through a local file-size-limited wrapper to force SQLite metadata writes to fail
  - create a durable baseline, then keep mutating metadata until the constrained mount errors or dies
  - discard local metadata and verify the next fresh mount can still read the durable baseline from remote state

- `soak`
  - repeated mixed operations across a configurable duration

## Flags

- `-juicefs-bin`
  - path to prebuilt `juicefs` binary
  - default: `JUICEFS_BIN`

- `-workdir`
  - root directory for run artifacts
  - default: `vfs_harness/runs`

- `-profile`
  - `quick` or `soak`
  - default: `quick`

- `-scenario`
  - comma-separated scenario list
  - default: all scenarios in the selected profile

- `-keep-success`
  - keep successful local and remote artifacts
  - default: false

- `-soak-duration`
  - soak run duration
  - default: `30m`

- `-fuzz-seed`
  - seed for the `fuzz_churn` scenario
  - default: `0` which picks a time-based seed and records it in `manifest.json`

- `-fuzz-ops`
  - number of random operations for `fuzz_churn`
  - default: `40`

- `-fuzz-checkpoint-every`
  - durable barrier/remount verification interval for `fuzz_churn`
  - default: `8`

## Output

Each run creates an isolated directory under `vfs_harness/runs/<run-id>/`:

- `logs/`
- `meta/`
- `mnt/`
- `manifest.json`

On failure, the harness keeps local artifacts and remote COS prefixes for debugging.

On success, the harness deletes them unless `-keep-success=true` is set.

## Hidden Barrier Command

The harness relies on a hidden CLI command implemented in the main `juicefs` binary:

```bash
/tmp/juicefs-litestream meta-barrier /path/to/mountpoint
```

This command sends a control message to the mounted process and forces a durable metadata cut inside the live mount process.

## Notes

- This harness is not part of the default `go test ./...` flow.
- It is designed for real COS validation, not mocked object storage.
- Successful validation of `mount_smoke`, `barrier_cut`, `crash_before_barrier`, and `crash_after_barrier` is the current minimum confidence baseline.
- The default quick profile now includes `snapshot_restore`, `metadata_restore_matrix`, `rename_semantics_matrix`, `xattr_restore_matrix`, `cross_mode_restore`, `chaos_crash_fuzz`, and `periodic_commit_chaos` so snapshot, restore, rename, xattr, cross-mode, seeded chaos crash, and periodic-commit crash compatibility are part of the regular validation set.
- `fuzz_churn` is opt-in rather than part of the default quick profile because it is broader and intentionally more variable; use the recorded seed to reproduce failures exactly.
- `fuzz_churn` clears its owned `fuzz/` subtree at start so replay on a reused workspace does not inherit prior path collisions.
- Directory-overwrite checks use the raw rename syscall instead of Go's `os.Rename`, because Go rejects an existing directory target in user space before the filesystem sees the request.
