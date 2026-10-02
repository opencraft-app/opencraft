# Beijing FoundationDB COS restore drill — 2026-08-14

## Result

Passed. A newly created, empty FoundationDB 7.3.79 cluster in `ap-beijing-6` restored the full user
keyspace from the dedicated Beijing COS continuous-backup generation. The restored key/value set
matched the source set exactly and the restored database accepted new writes.

This drill proves that the remote backup is readable and sufficient to rebuild user data. The
validation target was deliberately a single-node, isolated cluster; this is a recoverability test,
not an HA topology or production-capacity RTO benchmark.

## Inputs

| Property | Value |
| --- | --- |
| Source region | `ap-beijing` |
| Backup bucket | `actor-fdb-backup-prod-bj-a01-1388575217` |
| Backup generation | `actor/prod/ap-beijing/bj-a01/foundationdb/continuous/v1` |
| FDB version | `7.3.79` on source and target |
| Restore target | Isolated `actor-restore-drill` containerd namespace on the Beijing zone-6 builder |
| Restore version | `71462408029` |
| Restore tag | `drill-814T110420Z-3573735673a4` |

The builder could not reach Docker Hub. The validation image was therefore exported from a running
Beijing source node, transferred over the private VPC, verified as
`483582402a9563951dd8c3c96095ca148b8dcff0893d5531e7ea20d8871bd1f7`, and imported into the isolated
namespace. The temporary HTTP server, both 1,471,122,944-byte image tar files, and the namespace
image metadata were removed after use.

## Evidence

Before restore, the target reported:

```text
The database is available.
USER_KEYS_BEFORE=0
```

A 32-key sentinel range was committed to the source at version `71462408029`. The continuous backup
then reported a `MaxRestorableVersion` greater than that commit. Source evidence for the range was:

```text
SOURCE_KEYS=32
SOURCE_SHA256=64293a52c2453862c745d5e6db00d413f9d907298e984bc92ad33df516c39144
```

`fdbrestore` first passed a dry run for the exact version. The real restore then completed with:

```text
State: completed
Blocks: 64/64
Files: 101
BytesWritten: 62075594
CurrentVersion: 71462408029
LastError: None
Restored to version 71462408029
RESTORE_SECONDS=21
```

The target sentinel range matched exactly:

```text
TARGET_KEYS=32
TARGET_SHA256=64293a52c2453862c745d5e6db00d413f9d907298e984bc92ad33df516c39144
MARKER_MATCH=true
```

The stronger full-user-keyspace comparison also matched exactly on source and target:

```text
USER_KEYS=316704
FDBCLI_OUTPUT_BYTES=105200441
SHA256=5d3f390047a115d1be3cf11d507df8bbad6a2a3fd5f127c27d46da06ce6db2e3
```

After restore, the target successfully committed, read, and cleared a target-only probe key and
still reported `The database is available.`

## Cleanup and subsequent gate

The source sentinel range was cleared at version `72733590944` and verified to contain zero keys.
The target backup agent and temporary root COS credential file were removed, then the restored
container, data directory, image metadata, port `4600`, and `actor-restore-drill` namespace were
deleted. The restored clone is intentionally not retained; it can be reproduced from the live COS
generation.

After cleanup, the source FDB remained available, the COS backup remained `Restorable: true`, and
the continuous backup agent and seven-day expiry timer remained active.

The Beijing destructive-restore gate became green at this point. The then-remaining controller gate
was subsequently completed: the Engine controller ran against this exact backup base, issued a
fresh durable certificate, and proved periodic renewal. See the
[Beijing controller acceptance receipt](beijing-backup-fence-controller-2026-08-14.md). Physical
deletion remains a separate rollout switch and is still disabled until production online cold
storage is deliberately enabled.
