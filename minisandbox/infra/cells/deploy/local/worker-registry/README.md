# Worker registry

The Worker registry is the code control plane for the local multi-Cell environment. It runs in Hub cluster C and models the user-facing lifecycle as:

`Worker name -> immutable Versions -> active Deployment -> stable per-Object Version assignment`

It is not on the steady-state actor request path. Runtime Cells A and B fetch immutable Version
content only when starting a workerd isolate and may cache it by digest. Deleting a Worker removes
its active Deployment but retains immutable Versions for explicit pins and rollback; a cold
deployment-bound Object intentionally cannot activate without an active Deployment.

## Run locally

Start the three-cluster mesh first, then run:

```bash
./infra/cells/deploy/local/worker-registry/up.sh
```

The Hub deployment follows the production storage split instead of using a Registry-local data
directory:

- three stateless Registry replicas;
- one dedicated `worker-registry-code-plane` FoundationDB cluster for Version summaries,
  Deployment history, and active-pointer CAS;
- immutable Version content through the Tencent COS client into a persistent local COS protocol
  double.

The Code Plane FDB is independent of both runtime Cell FDB clusters. The local COS double has one
PVC only to make the three-k3d demonstration self-contained; it validates conditional immutable
PUT, exact GET, CRC64, and restart persistence but is not a production object store. Production
uses the real private Tencent COS endpoint and no Registry-local volume.

The NodePort is reachable by Cells A and B on the private k3d mesh as
`http://k3d-rivet-mesh-hub-server-0:30081`.

`verify.sh` exercises uploads, immutable old-Version reads, three-replica Registry replacement,
local COS replacement, Deployment recovery, and safe deletion.

Normal Durable Object creation follows the Worker Deployment:

```json
{
  "name": "hello-actor",
  "runner_name_selector": "workerd",
  "crash_policy": "sleep",
  "worker": {
    "worker": "hello"
  }
}
```

An explicit `version_id` remains available for previews and reproducible jobs. A gradual Deployment
contains one or two Versions whose percentages sum to 100. The Host hashes the stable Actor ID with
the Deployment ID, so one Object runs exactly one Version for that Deployment across requests,
sleep/wake, reschedule, and Host replacement.

On actor admission, workerd-host fetches the immutable private endpoint, verifies the exact raw
Version-content SHA-256, and stores it in a bounded memory cache plus a disposable 512 MiB local
disk cache. Disk entries are verified again after host restart. The dynamic WorkerLoader endpoint
is authenticated and generation-fenced: workerd can request only the Version already assigned to
that active actor generation. Registry credentials, host tokens, and Worker routing headers are
never exposed to user code.

## API

- `PUT /v1/namespaces/{namespace}/workers/{worker}` creates a Version and deploys it.
- `POST /v1/namespaces/{namespace}/workers/{worker}/versions` uploads a Version without changing traffic.
- `GET /v1/namespaces/{namespace}/workers/{worker}/versions?page=1&per_page=20` lists Versions with five-Version deployability and report-only GC status.
- `POST /v1/namespaces/{namespace}/workers/{worker}/deployments` publishes one or two uploaded Versions using percentage weights.
- `GET /v1/namespaces/{namespace}/workers/{worker}/deployments?page=1&per_page=20` lists newest-first immutable Deployment history.
- `GET /v1/namespaces/{namespace}/workers/{worker}/deployments/{deployment}` reads one historical Deployment.
- `DELETE /v1/namespaces/{namespace}/workers/{worker}/deployments/{deployment}` deletes an inactive history record; the active Deployment is protected.
- `GET /v1/namespaces/{namespace}/workers/{worker}` reads the active Deployment.
- `GET /v1/namespaces/{namespace}/workers` lists deployed Workers.
- `DELETE /v1/namespaces/{namespace}/workers/{worker}` removes only the active Deployment.
- `GET /internal/v1/namespaces/{namespace}/workers/{worker}/versions/{version}` returns immutable runtime content. This endpoint must stay private to trusted runtime Cells.

Rollback is a client convenience over ordinary Deployment creation: post a new
single-Version Deployment with the selected still-deployable Version at 100%.
Set `annotations.workers/triggered_by` to `rollback` and optionally attach a
bounded `annotations.workers/message`; history records also expose `source=api`.
There is intentionally no separate rollback storage operation.
