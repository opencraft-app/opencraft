# actor-bj-k01 backup and restore qualification — 2026-08-17

This receipt records the first live backup and restore qualification for the
Beijing production Cell. It contains no credentials.

## Outcome

- `actor-bj-k01` remained configured, available, healthy, and fully replicated
  throughout the backup and restore work (`FoundationDBCluster` generation 7).
- One-time backup tag `actor-bj-k01-q-20260817t0520z` completed and remained
  restorable in COS. `fdbbackup describe` observed a 194-byte snapshot with
  minimum restorable version `8156981906` and maximum restorable version
  `8176739192`.
- A dry-run and a real user-keyspace restore were submitted with the isolated
  add-prefix `actor-qualification-restore-20260817t0612z/`. Restore tag
  `actor-bj-k01-qrestore-20260817t0612z` progressed through queued, starting,
  and running to completed at version `8176739192`, with no last error. The
  qualification backup contained no user keys, so the restore wrote zero user
  bytes and did not alter an existing key.
- Continuous backup `actor-bj-k01-continuous` is running differentially with
  three agents, a six-hour snapshot interval, and a restorable point in COS.
  At the final check it had an 11-second log lag and an empty error list.
- The completed one-time backup is retained as a receipt with `backupState:
  Stopped` and `agentCount: 0`; its temporary agent Deployment was removed.

## Credential decision

The production Secret is named `actor-bj-k01-backup-credentials`. At the
operator's direction it currently contains the Tencent Cloud root access key in
FoundationDB blob credential format. The key is never committed, and all local
temporary credential files plus the previous two-hour STS Secret were removed.

This is an explicitly accepted security debt: compromise of the Operator or a
backup-agent Pod can expose account-wide cloud authority. Replace it with a
COS-scoped CAM role or TKE OIDC workload identity before treating the credential
boundary as least-privilege production-ready.
