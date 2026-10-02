# Local Workers API

This deploys the Go `workers-api` façade into the Hub cluster. It is the only user-facing Workers
endpoint and exposes `/v1`; the private Worker Registry, Rivet namespace, runner selector, runtime
Cells, and Actor IDs are configuration details behind it.

The Hub deployment has a three-replica HA floor behind one Service, a `maxUnavailable: 1`
disruption budget, and the same QPS/in-flight/CPU/RSS HPA contract used in production. The local
Hub installs the production custom-metrics rules and can scale Router replicas above three;
three is not a ceiling. Replica memory is only a bounded routing cache. A Durable Object cache miss
falls back to Registry, while deterministic Engine create identity makes concurrent first requests
converge on one logical Actor. Immutable Cell and Pool UIDs prevent a rebuilt same-name Cell from
inheriting an old Object placement.

```sh
infra/cells/deploy/local/workers-api/up.sh
infra/cells/deploy/local/ingress/up.sh
```

The local ingress then serves the API at `http://<ingress-address>:<port>/v1`. The service validates
inactive Worker Versions through short-lived pinned Actors before publishing a Deployment and
routes logical Durable Object references to the A/B runtime mesh.

The public readiness budget is three seconds from the first object request through Registry claim,
Engine creation, and immutable Actor activation. A miss returns the retryable
`504 actor_ready_timeout`; an activation whose response is uncertain is not destructively cleaned
up because a retry may already observe the committed binding. This readiness deadline does not cap
Worker execution. Fetch responses may stream beyond 60 seconds and follow caller cancellation;
the 60-second client timeout applies only to control-plane calls.

Minimal public contract:

- `GET /v1/workers` and `GET|DELETE /v1/workers/{worker}`
- `POST|GET /v1/workers/{worker}/versions` and `GET .../versions/{version}`
- `POST /v1/workers/{worker}/deployments` and `GET .../deployment`
- `PUT /v1/workers/{worker}/objects/{class}/{id}` returns an `ObjectRef`
- `DELETE /v1/workers/{worker}/objects/{class}/{id}` permanently deletes one object
- any HTTP method on `.../objects/{class}/{id}/fetch` invokes that object
- any HTTP method on `/v1/workers/{worker}/dispatch` invokes the default Worker entrypoint

`DELETE /v1/workers/{worker}` succeeds only when Registry's append-only namespace inventory is
empty. If any current or historical Version introduced a Durable Object class, it returns
`409 worker_has_durable_objects`; this pre-launch API intentionally has no `force` compatibility or
partial cleanup path.

Object deletion first commits a Registry/FDB tombstone and then idempotently destroys the hidden
Actor. The tombstone is terminal for that Worker/class/ID generation: API replica replacement,
delayed fetch retries, and an interrupted repeated DELETE cannot recreate the object. SQLite and
cold-object reclamation continue asynchronously behind the Engine destroy fence.

Successful control responses use stable `Worker`, `Version`, `Deployment`, and `ObjectRef`
resources. Platform failures use one envelope:

```json
{
  "error": {
    "code": "worker_prepare_failed",
    "message": "workerd rejected Durable Object class Counter",
    "retryable": false,
    "request_id": "req_..."
  }
}
```

Worker `fetch()` responses remain raw HTTP responses, including application-defined non-2xx status
codes. Only responses carrying the façade-owned `X-Workers-Error: true` marker are platform errors.

Deployment creation accepts an optional `expected_deployment_id`. Miniflare sends the ID returned by
its previous successful update; the Registry compares it inside the same FDB transaction that moves
the active pointer. Concurrent identical updates converge, while a stale different update returns
`409 deployment_conflict` instead of silently overwriting another publisher.
