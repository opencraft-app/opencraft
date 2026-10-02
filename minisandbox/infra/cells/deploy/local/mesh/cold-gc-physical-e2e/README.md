# Cold GC physical deletion qualification

This gate runs one isolated, short-lived Engine against a dedicated local
FoundationDB cluster and a dedicated bucket in the persistent local S3 protocol
double. It exercises the production backup-fence controller protocol before it
allows the production cold-GC workflow to issue an exact-key `DELETE`.

The qualification Engine is the only build that enables `rivet-engine/test-faults`.
That feature adds a process-local, per-branch short-grace route so the test does
not wait the production minimum recovery window of 24 hours. The route is absent
from normal builds, and the repository's production fault-leak check is part of
the gate.

Run from the repository root:

```sh
infra/cells/deploy/local/mesh/cold-gc-physical-e2e/run.sh
```

Receipts are written beneath
`$XDG_STATE_HOME/rivet-local-mesh/receipts/cold-gc-physical/`.
