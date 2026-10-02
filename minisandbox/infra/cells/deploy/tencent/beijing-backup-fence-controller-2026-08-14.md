# Beijing Engine backup-fence controller acceptance — 2026-08-14

## Result

Passed. The dedicated Engine backup-fence controller is deployed on the Beijing zone-6 builder,
the one-shot controller completed against the production continuous-backup repository, and an
independent `backup-fence-show` read the resulting durable recovery certificate from the source
FoundationDB cluster. The systemd timer subsequently renewed the certificate multiple times,
including once after all temporary build and transfer material had been removed.

This closes the backup-fence hard gate. It does not by itself enable Depot physical deletion:
the FDB `ColdGcPolicy` remains disabled until the production online cold bucket, complete inventory,
and its Engine cold-tier configuration are deliberately qualified together.

## Deployment

| Property | Value |
| --- | --- |
| Region | `ap-beijing` only |
| Controller host | `ins-4z46pxcb`, Beijing zone 6 |
| Engine | `2.3.7`, build marker `actor-backup-fence-20260814`, x86_64 release |
| Engine SHA-256 | `42308582ae8df5224d779032099241f6e6cd1d12a3b756ec715f104ef1296d64` |
| `fdbbackup` | FoundationDB `7.3.79` |
| `fdbbackup` SHA-256 | `68ac161d410814e08dcae8e74fbd33c365a0a6894fb8675c2a685aba3dfd4157` |
| Backup repository | Dedicated `actor-fdb-backup-prod-bj-a01-1388575217` Beijing COS bucket |
| Retention command | Seven days with matching minimum-restorability guard; never `--force` |
| Renewal schedule | systemd oneshot, one minute after the preceding run, with 0–5 second jitter |

The controller-only configuration intentionally does not configure Depot workflow cold storage.
This lets recovery certification operate before the production online cold bucket is enabled. The
runtime uses the production copies under `/opt/actor/backup-fence`, configuration under
`/etc/actor/backup-fence`, and state under `/var/lib/actor-backup-fence-controller`.

The COS credential file is root-owned mode `0600`. Its values are absent from the repository,
backup URL, systemd unit, TAT command output, and this receipt. The currently installed credential
has broad root authority by explicit temporary operational choice; replace it with a bucket-scoped
CAM role or key before general production access is delegated.

## Certificate evidence

The initial run observed a restorable catalog with:

```text
MinimumRestorableVersion=69486212254
MaximumRestorableVersion=77745941578
generation_count=1
```

It performed the guarded seven-day expiry, listed the catalog again, and committed the certificate
to FoundationDB. A later catalog observation remained `Restorable: true` and had advanced to
`MaximumRestorableVersion=78185941578`.

The final post-cleanup durable readback was:

```text
minimum_restorable_version=69486212254
policy_fingerprint_sha256=8448c48451a59f733d73647c42eaa0b4417461a13c8873fbc0ba6f9bc75398d4
verified_at=2026-08-14 21:02:21.054 Asia/Shanghai
valid_until=2026-08-14 21:12:21.054 Asia/Shanghai
```

At that check the service result was `success`, its exit status was zero, the timer was `active`,
and three scheduled controller completions had occurred since 21:00. All five source FDB nodes
reported the database available. The three independently supervised backup agents in Beijing
zones 6, 7, and 8 remained active.

The former zone-7 `actor-fdb-backup-expire.timer` was disabled and stopped before the new timer was
enabled, leaving one retention/catalog owner. systemd also prevents overlapping executions of the
same oneshot unit. If this responsibility is later moved into long-running Engine replicas, first
disable this dedicated timer and retain one logical controller owner.

## Compatibility findings fixed during deployment

The live FDB 7.3.79/COS path exposed two issues that are now covered by tests:

- Every catalog command receives the configured TLS CA file; Tencent's internal certificate chain
  is not bypassed by disabling verification.
- `fdbbackup list` canonicalizes a Beijing base URL by omitting its redundant `region` query item.
  The parser permits only that exact omission while requiring the endpoint host, bucket, path, and
  every other query item to match. A changed bucket or changed region fails closed.

The config tests also cover a standalone controller before workflow cold storage is configured and
reject an empty CA path.

## Cleanup and retained state

Nine temporary transfer objects under the build prefix in `actor-soak-1388575217` were deleted by
exact key and the prefix was verified empty. The DevCloud and Beijing build staging directories,
the one-time transfer private key, the temporary containerd build namespace, and the extra build
copy of `libfdb_c.so` were removed. The SSH session holding in-memory credentials was closed.

No continuous-backup object, backup generation, source FDB data, or production controller file was
deleted. The production timer, runtime binary, pinned CLI/library, root-only configuration and
credential, durable FDB certificate, and three backup agents are intentionally retained.
