# Workers API HPA-safe HA and placement gate

This deterministic local gate requires the Hub Workers API Deployment to have at least three Ready
Pods. Three is the HA floor rather than a fixed ceiling: if an HPA has raised the replica target,
the gate exercises every currently Ready replica and requires replacement to restore that baseline.
It proves:

1. simultaneous first use through every exact API Pod consumes a fresh Fleet admission
   snapshot and immutable route, while Registry FDB persists one Cell UID and Actor binding;
2. normal deletion and replacement of one API Pod causes no control-request failures, and the
   replacement resolves the original ObjectRef to the same Actor;
3. concurrent object deletion through every replica is idempotent, destroys the Actor, and
   leaves a terminal tombstone observed by every replica after all Registry Pods restart;
4. a Worker with any Durable Object namespace is rejected by `DELETE` with
   `409 worker_has_durable_objects`;
5. ordinary Worker dispatch executes through the stateless plane without creating a persistent
   default Actor; after deleting that Worker, every API replica returns `404` instead of using a
   stale Deployment cache entry;
6. while all three Registry replicas are absent, a warm Object remains reachable from every
   API replica's bounded placement cache, a new placement miss fails closed without creating an
   Actor, and normal creation/deletion converges after Registry recovery.

The drill uses normal `kubectl delete pod --wait=false`; it never force-deletes runtime or API Pods.

```sh
infra/cells/deploy/local/mesh/workers-api-ha-e2e/run.py \
  --receipt /data/actor-qualification/receipts/local-workers-placement-$(date +%s).json
```
