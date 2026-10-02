# Miniflare Counter recovery gate

This gate exercises the checked-in Miniflare v3 facade through the single public Workers API `/v1`
endpoint against the real Worker Registry, Engine, workerd Host, and Depot SQLite path. It uploads
a native `Counter extends DurableObject`, validates
the inactive immutable Version through a short-lived pinned prepare probe, and proves that identical
code with a different, missing Durable Object export creates a distinct Version but cannot replace
the active Deployment. It then increments to
one, sleeps the actor, replaces the Host Pod, and requires the same object to continue at two
and three. The Counter also asserts that `stub.fetch()` preserves the caller's original URL origin.
Finally it calls `stub.delete()` twice, requires both calls to succeed, and proves that a delayed
fetch receives terminal `410 object_deleted` instead of recreating the Actor.

Build the package and run against either local runtime Cell:

```sh
(cd runtimes/workerd/miniflare && npm run build)
infra/cells/deploy/local/mesh/workerd-miniflare-counter-e2e/run.py \
  --runtime-kubeconfig "$HOME/.local/state/rivet-local-mesh/runtime-a.kubeconfig" \
  --cell local-runtime-a \
  --api-endpoint http://9.134.163.40:6688/v1
```
