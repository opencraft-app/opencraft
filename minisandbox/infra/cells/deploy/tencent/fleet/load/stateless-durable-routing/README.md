# Cloud stateless Worker-to-Durable-Object smoke

This bounded qualification publishes one temporary immutable Worker Version,
executes ordinary stateless fetch through the regional `/v1` endpoint, chooses
one deterministic Durable Object key for each requested placement-ready Cell,
and proves both the Worker binding and direct `ObjectRef` observe the same
serialized `1,2,3` state. It then deletes every Object before publishing an
immutable receipt.

The Worker name is a stable qualification fixture. It is intentionally retained:
the product's terminal Durable Object namespace inventory rejects Worker deletion
even after all Object records are deleted. Reusing the same Worker source is
idempotent at both Version and Deployment layers, so repeated qualifications do
not create a new Worker or Deployment history entry. The test must not bypass
that user-visible safety rule by clearing Registry FDB keys directly.

The Registry endpoint is used only to verify the authoritative immutable Cell
placement and Actor identity; user traffic remains on the public Workers API.
The test does not mutate Cell capacity, routes, admission state or Deployments.

```sh
./run.py \
  --endpoint http://10.160.0.3:6688 \
  --registry-endpoint http://10.160.0.15:8080 \
  --hub-kubeconfig /protected/management.kubeconfig \
  --cell actor-bj-a01 --cell actor-bj-b01 \
  --worker qualification-stateless-do-routing \
  --receipt /protected/receipts/stateless-do-smoke.json
```

`fault_matrix.py` is the bounded destructive companion qualification. It creates
one object in each of two placement-ready Cells, durably sleeps one object, and
then replaces exactly one Pod at a time: the sleeping object's workerd Host, one
central Workers API Pod, one Engine/Gateway Pod, and one stateless executor Pod.
It waits for the exact configured Ready replica floor after every replacement
and fails closed if the initial topology is ambiguous. The receipt proves that
the same Actor IDs and immutable Cell placements retain monotonically increasing
state throughout the matrix. It does not scale a workload, mutate a route, or
delete the retained qualification Worker.

Both replacement gates use Kubernetes UID-preconditioned DELETE and verify the
acknowledged UID. They preserve the configured termination grace period and
preStop hook. A name reused with another UID causes a conflict and aborts the
gate without deleting the replacement or choosing another victim. Recovery
requires one Ready snapshot proving the selected UID is gone, all unselected
peer UIDs remain, and exactly one new UID restores the original Ready floor.
An unrelated peer replacement is not evidence of recovery from this fault.

```sh
./fault_matrix.py \
  --endpoint http://10.160.0.3:6688 \
  --registry-endpoint http://10.160.0.15:8080 \
  --hub-kubeconfig /protected/management.kubeconfig \
  --cell-kubeconfig actor-bj-a01=/protected/a01.kubeconfig \
  --cell-kubeconfig actor-bj-b01=/protected/b01.kubeconfig \
  --host-replicas 4 \
  --receipt /protected/receipts/stateless-do-fault-matrix.json
```

Replica arguments are intentional safety assertions, not scaling controls. Set
them to the qualified topology (for example `--host-replicas 4` after an HPA
scale-out); the program never derives permission to delete a Pod from a
possibly stale desired count.

`termination_matrix.py` covers the separate in-flight boundary. A unique
delay Worker is invoked through the production regional `/v1` endpoint, while
read-only per-Pod metrics identify the exact executor selected behind the Cell
private CLB. The gate deletes only that Pod. Its graceful case proves the
public response completes and a new connection through the same private CLB
reaches a healthy peer. Its forced case exceeds the 45-second executor drain
budget and proves the public client receives `502 indeterminate_result` only
after that bounded drain window when headers have not started. The fixture
deliberately starts a large streamed response first, so its expected public
result is instead an aborted transport: an HTTP status cannot be rewritten
after headers, and a partial response must never be cleanly finalized or
automatically replayed. The receipt also
records the timeout-counter delta when the short increment-to-Pod-exit window
is observed; the public result and elapsed time remain authoritative if the
old Pod closes its metrics socket first. It restores the exact three-Pod Ready
floor after each case and deletes the temporary Worker.

```sh
./termination_matrix.py \
  --endpoint http://10.160.0.3:6688 \
  --cell-kubeconfig actor-bj-a01=/protected/a01.kubeconfig \
  --cell-kubeconfig actor-bj-b01=/protected/b01.kubeconfig \
  --receipt /protected/receipts/stateless-termination.json
```
