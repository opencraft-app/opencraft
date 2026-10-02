# Workers API deployment-cursor qualification

This production gate measures active Deployment invalidation across the exact
three Ready Workers API replicas. It creates two immutable Versions of one
temporary stateless Worker, alternates the active Deployment for at least 20
rounds, and calls every API Pod through a read-only `kubectl port-forward`.

The timer starts only after the Deployment CAS response. Every replica must
then return the new revision within 30 seconds, and nearest-rank p99 across all
replica observations must stay within five seconds. The Worker is deleted on
success and best-effort cleanup also runs after failure. The gate never changes
replicas, Registry/FDB topology, Cell placement, or runtime capacity.

Run from the same-VPC builder after exporting `MINISANDBOX_REPO`:

```sh
python3.11 qualify.py \
  --hub-kubeconfig /data/actor-bootstrap/beijing-rebuild-20260915/input/management.kubeconfig \
  --receipt /absolute/new/deployment-cursor-qualification.json
```
