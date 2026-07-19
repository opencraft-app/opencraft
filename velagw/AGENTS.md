# AGENTS.md — LLMGateway Agent Handoff

This file is the handoff guide for agents working inside `llmgateway/`.
Read the monorepo root `../AGENTS.md` first, then read this file before editing
code, deploying, or calling cloud resources.

## Project Purpose

`llmgateway` is the outer control plane and traffic adapter for a multi-Set
`new-api` deployment. It must not modify `new-api` source code. The goal is to
expose multiple `new-api` Sets as one stable platform while adding:

- Set/Sharding management.
- Control/traffic process separation.
- OpenAI-compatible traffic proxying.
- Tenant provisioning into new-api Sets.
- Channel bundle sync and drift detection across Sets.
- BYOK policy support.
- Worker-based background reconciliation.
- Kubernetes-native Set runtime via `LLMFleet` CRD.

LLMGateway does not understand or proxy any legacy gateway at runtime. Unknown
traffic keys return 401, control APIs never fall back to another service, and
unprovisioned tenants use `backend=pending`. Historical data import is an
external one-time workflow that calls the normal provisioning APIs.

## Current Beijing Cloud Test Environment

The current Beijing environment is for integration, load, migration, and
operator testing. It uses production-like topology and runtime parameters, but
Agents must not describe it as the formal production environment. It has two
independent public endpoints:

```text
Control plane: https://llmgw-control.lightvela.com
Traffic plane: https://llmgw-inner.lightvela.com
```

Traffic plane:

- Only serves `/v1/*` model calls plus health/readiness.
- Callers use their own model key, for example `Authorization: Bearer sk-...`.
- OpenAI-compatible base URL is `https://llmgw-inner.lightvela.com/v1`.

Control plane:

- Serves admin/control APIs and the operator console.
- Does not serve `/v1/*`.
- Does not use user model keys.
- Web UI: `https://llmgw-control.lightvela.com/admin`.
- An unauthenticated request to `/admin` redirects to `/admin/login`.
- An unauthenticated request to `/api/admin/*` returns HTTP 401.
- Web UI login writes an HttpOnly session cookie; use it only for browser
  console access.
- Web UI username: `cluster-admin`.
- Web UI password: `Qq373866172!`.
- Direct `/api/admin/*` calls use the test-environment management token below:

```text
7bbe050f825e0f12aebe5e80b1a196cbef852f9dfacdf484af36166c84b7ef27
```

- This management token is for operators and Agents controlling LLMGateway. It
  must never be given to ordinary model callers.
- The same token is stored in TKE Secret `llmgateway-control-runtime`, key
  `CLUSTER_ADMIN_TOKEN`. Retrieve it from TKE when checking whether the stored
  value has been rotated:

```bash
kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig-cluster-sni \
  -n llmgateway get secret llmgateway-control-runtime \
  -o jsonpath='{.data.CLUSTER_ADMIN_TOKEN}' | base64 -d
```

Example control call:

```bash
export LLMGATEWAY_CONTROL_TOKEN='7bbe050f825e0f12aebe5e80b1a196cbef852f9dfacdf484af36166c84b7ef27'

curl -sS https://llmgw-control.lightvela.com/api/admin/overview \
  -H "Authorization: Bearer ${LLMGATEWAY_CONTROL_TOKEN}"
```

Example traffic call:

```bash
curl -sS https://llmgw-inner.lightvela.com/v1/chat/completions \
  -H 'Authorization: Bearer sk-...' \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

The management token cannot replace `sk-...` on the traffic plane. Each Agent
calling a model receives its own user model key and calls only the traffic
endpoint. Conversely, do not send a user model key to `/api/admin/*`.

## Beijing Test Environment DNS and TLS

Current DNS:

```text
llmgw-control.lightvela.com CNAME lb-m2z2hu01-gc1pzodr6i4eyjq5.clb.bj-tencentclb.com
llmgw-inner.lightvela.com   CNAME lb-kmvdis9v-zjksm2601iqxwrvl.clb.bj-tencentclb.com
```

Both endpoints currently use Tencent Cloud SSL certificate `XCYa3P4e`, covering
`*.lightvela.com`. In Kubernetes this is represented as Opaque Secrets with the
`qcloud_cert_id` key:

- `llmgw-control-lightvela-com-cert`
- `llmgw-inner-lightvela-com-cert`

Do not write Tencent SecretId/SecretKey or additional secret values into
tracked files. The operator login and management token documented above are an
explicit project-owner exception so future Agents can operate this environment.

## Multi-Region Production Configuration

Production infrastructure uses one Terraform codebase with one explicit tfvars
and remote-state prefix per region. Before preparing any new region, ask the
user for and confirm all of the following instead of inheriting Beijing values:

- TencentCloud region and at least two currently available zones.
- A stable short region alias used in resource names.
- Independent control and traffic DNS names.
- TLS certificate IDs covering those names.
- A regional TCR instance and public domain.
- The COS backend bucket location and an unused state prefix.
- Admin CIDRs, database/Redis credentials, and desired capacity/spec changes.

Use `deploy/terraform/tencentcloud-prod/environments/<region>.tfvars.example`
and `backend/<region>.hcl.example`. A new region is bootstrapped with
`edge_dns_enabled=false`; after Kubernetes creates the two CLBs, write their
domains back to tfvars and enable DNS in a second plan/apply. Beijing must keep
the existing `llmgateway/prod` state prefix and `bj` alias unless an explicit
state migration is planned.

## Main Code Layout

```text
cmd/
  llmgateway-control/       control API and console process
  llmgateway-traffic/       traffic-only process
  llmgateway-worker/        background job worker
  llmgateway-set-manager/   LLMFleet CRD reconciler bridge
internal/gateway/           core service, store, tenant, capacity, channel logic
internal/httpapi/           HTTP routing and handlers
internal/newapi/            new-api client wrapper
internal/setmanager/        LLMFleet set-manager implementation
deploy/k8s/prod/            production TKE manifests and docs
docs/operator-p0.md         operator-facing API and P0 operations doc
docs/cloud-load-test.md     cloud load/e2e validation notes
```

## Runtime Model

Processes are intentionally split:

- `llmgateway-control`: management APIs, console proxy, set/channel/tenant operations. No `/v1/*`.
- `llmgateway-traffic`: model traffic proxy. No management APIs.
- `llmgateway-worker`: MySQL-backed background jobs and retries.
- `llmgateway-set-manager`: consumes control-plane provision requests and patches `LLMFleet.spec.sets`.

`llmgateway` still has an all-in-one command for local development, but
production uses the split processes.

## Embedded Console Routing Invariants

Every embedded new-api console shares the control-plane origin, so Set routing
must be explicit and fail closed:

- Canonical console URLs use `/_llmgateway_console/<set-id>/<path>`.
- Absolute new-api requests such as `/api/*` are rewritten by the site Service
  Worker using a mapping scoped to the requesting `FetchEvent.clientId`.
- The injected console bridge announces its Set to the Service Worker. There
  must never be one global `currentSet` shared by tabs or iframes.
- Server fallback may use the explicit path, `X-LLMGateway-Set`, the legacy
  query parameter, or a Set-bearing Referer. Multiple explicit identities must
  agree; disagreement returns HTTP 409.
- `llmgateway_console_set` cookies are never a routing source. Cookies are
  origin-wide and can route concurrent Set consoles to the wrong upstream.
- A request with no explicit Set identity returns 404 instead of guessing.

Required regression coverage includes two Set identities with an intentionally
wrong legacy cookie, cookie-only rejection, conflicting-signal rejection,
Service Worker client mapping, and legacy query redirect to the canonical path.

## CRD / LLMFleet Path

Production Set runtime must use the CRD path:

- `LLMFleet` is the source of desired new-api Set runtime.
- `llmgateway-set-manager` only has RBAC for `get` and `patch` on `llmfleets.llmgateway.io`.
- It must not create Deployments, Services, or Secrets directly.
- It patches `LLMFleet.spec.sets` with an optimistic `metadata.resourceVersion` guard.
- `llmfleet.yaml.template` is bootstrap-only. Reapplying it can delete dynamic Sets.
- For shard host/port updates, use `deploy/k8s/prod/patch-llmfleet-shards.sh`; it only patches `spec.shards`.

KRO version note:

- Current TKE Serverless validation uses KRO `0.8.5`.
- KRO `0.9.2` hit `field label not supported: spec.snapshot.name` on the current apiserver.

## Set Capacity and Runtime Lease Rules

Set capacity is a waterline selector, not a strict quota system:

- Each Set may have `max_users`, `warn_users`, and `reserved_users`.
- New assignment skips disabled/draining/unready/admission-failed Sets.
- `observed_user_count` is a projection refreshed by worker.
- Short-term over-allocation is acceptable; DB correctness is protected separately.
- Fleet owns default new-api database pool settings; Shards may override them, while Sets only project the effective values.
- Shard placement uses deduplicated Set capacity units divided by `max_sets`; database connection budgets are not placement scores.
- Production cloud load tests must set `LOAD_MAX_CONCURRENT_USERS` to at most 60.

Runtime leases protect Set resources:

- A runtime lease is scoped by `source + namespace + fleet`.
- Within one shard, the same Redis DB must not be assigned to multiple Sets.
- A database name must not be assigned to multiple Sets in the same fleet.
- MySQL has a `llmgateway_set_runtime_leases` table and unique constraints.
- In-memory store has matching validation for tests/local mode.
- A lease with neither a managed Set projection nor a non-terminal provision
  request is stale. The `cleanup_pending` worker job removes these orphaned
  leases; terminal request writes also trigger the same guarded cleanup.
- A non-terminal provision request always protects its lease. If the same
  runtime scope has provision history and every request is `error/cancelled`,
  the lease is terminal and must be released even when another scope reused the
  same global Set ID. A Set projection only protects fact/manual leases that
  have no matching provision request at all.

The daily `control_plane_outage_gate` is the canonical control-plane continuity
test. It suspends Set Manager, scales all five worker Deployments and control to
zero for 90 seconds, and proves existing traffic keys continue serving through
`llmgateway-traffic`. It must restore the exact original replica counts and may
never scale traffic or new-api runtime Deployments. Recovery passes only when a
pre-queued `refresh_set_capacity` job produces exactly one successful run and
releases its MySQL lease.

Set operation lease admission has one intentional bootstrap exception:

- Normal tenant, subscription, BYOK, and observation operations require a Set
  that has passed admission.
- `group_ratio_write` must be allowed after root bootstrap while admission is
  still `pending` or `failed`, because GroupRatio synchronization is itself an
  admission prerequisite. Applying the normal admission gate to this operation
  creates a permanent bootstrap deadlock.

The new-api runtime has one consistency and bootstrap constraint:

- `<fleet>-<set>-newapi-admin` selects the single `admin-master` Deployment.
- `<fleet>-<set>-newapi-traffic` selects both `admin-master` and every traffic
  slave, because both node types can relay model requests.
- There is no separate admin-slave Deployment. Traffic slaves already provide
  the new-api `NODE_TYPE=slave` role.
- A new Set starts with one master and zero traffic slaves. Control completes
  setup, compliance, channels, pricing, and plans before marking the provision
  request `configured`. Set-manager then scales slaves to the desired count and
  marks the request `managed` only after LLMFleet is Ready.
- Provision status describes runtime construction; admission status separately
  controls user assignment and traffic. Admission must not pass before the
  provision request is `managed`.
- Set traffic high availability is a declarative invariant. Production
  `LLMFleet.spec.availability.traffic` declares the replica floor, topology key,
  and PDB minimum. KRO projects Deployment and PDB observations into
  `LLMFleet.status`; set-manager must keep its CR-only RBAC boundary and derive
  Set health from that projection instead of listing child resources.
- A Set with a declared HA policy is eligible for new tenant assignment only
  while its runtime HA projection is `healthy`. Replica shortfall, stale
  Deployment generation, or unhealthy PDB must fail closed for new admission
  while existing traffic continues on the remaining replicas.
- Changes to the Set runtime topology must keep the
  `set_traffic_pod_failure_gate` regression: force-delete one active traffic
  Pod, preserve ordinary request continuity, allow SSE reconnect, and restore
  the declared replica and cross-zone contract.
- new-api Option updates mutate the receiving process immediately, while other
  processes reload them from MySQL on `SYNC_FREQUENCY`. Online configuration
  changes still require a propagation wait and verification barrier.

## Management API Semantics

Management APIs are for internal systems such as `ctl`, `trade`, and operator
tools. They are not generic public user APIs.

Important semantics:

- Do not use user model `sk-...` keys for management APIs.
- Direct `/api/admin/*` calls require cluster admin token unless an upper layer
  has already authenticated and authorized the caller.
- Current docs intentionally store only token retrieval instructions, not token values.
- Traffic keys are only for `/v1/*`.

Plan storage has two explicit tables and no Bundle relationship:

- `llmgateway_plans` stores immutable platform entitlement templates.
- `llmgateway_set_plans` stores each template's new-api plan ID and delivery state per Set.
- Rewriting an existing Plan ID with different entitlements returns conflict; create a new Plan ID instead.
- The `sync_plans` worker delivers pending/error templates. Subscription admission only uses `ready` Set Plans.
- New Set bootstrap must deliver every active Plan before Plan admission passes.
- Do not reintroduce `llmgateway_plan_mappings`, per-Set mapping JSON, `allowed_models`, `rate_limits`, or `token_multipliers` into LLMGateway Plans. new-api owns model and billing configuration.

Useful docs:

- `README.md` has the production caller surface.
- `docs/operator-p0.md` has operator API summaries and P0 operations behavior.
- `docs/desired-config-disaster-recovery.md` defines the secret-bearing single-file channel disaster recovery format.
- `deploy/k8s/prod/README.md` has current production endpoints, DNS, TLS, and deployment variables.
- `docs/openapi.json` is the machine-readable API reference.

## DesiredConfig and Channel Sync Invariants

`DesiredConfig` is the portable, secret-bearing disaster recovery format for
new-api model traffic behavior. It is intentionally narrower than a full
new-api site backup and broader than a channel list.

`golden-channels` is the single automatically effective DesiredConfig. Other
channel bundles are drafts or historical snapshots: they may be explicitly
planned/released, but Set bootstrap, admission, periodic drift checks, and the
operator overview must only evaluate `golden-channels` when it exists. A
single non-golden bundle remains supported for isolated tests and fresh local
environments. Remote global new-api options are part of the bundle's actual
state; a changed option is drift and must require an explicit force apply.

For production import and regional bootstrap, follow
[`deploy/k8s/prod/bootstrap/DESIRED_CONFIG_PLAYBOOK.md`](deploy/k8s/prod/bootstrap/DESIRED_CONFIG_PLAYBOOK.md).
The canonical local file path is
`deploy/k8s/prod/bootstrap/private/desired-config.json`; it is intentionally
ignored by Git. Agents must use the checked-in import script instead of
assembling ad hoc curl commands or printing the secret-bearing JSON.

The format and implementation must preserve:

- Every platform channel, including manually disabled channels.
- Plaintext provider keys. This is explicitly required for independent recovery.
- Multi-key channel mode (`is_multi_key` and `multi_key_mode`).
- Channel routing and provider fields: model mapping, priority, weight,
  auto-ban, tag, `other`, status-code mapping, `setting`, `settings`, parameter
  and header overrides, OpenAI organization, test model, and remark.
- Ratio and fixed-price billing, tiered billing expressions, group routing,
  `auto` groups, tool pricing, quota conversion, free-model pre-consumption,
  retry behavior, channel disable policy, and model adapter settings included
  by the explicit allowlist in `channel_bundle_engine.go`.

Do not broaden the allowlist to all new-api options. Payment, SMTP, OAuth,
registration, legal, branding, and other site identity settings do not belong
in the model traffic DesiredConfig and may contain unrelated secrets.

Channel status has exact new-api semantics:

```text
1 = enabled
2 = manually disabled
3 = automatically disabled runtime state
0 = unknown; never write this as disabled
```

Only status `2` is persisted as desired disabled state. Status `3` is runtime
health and exports as desired enabled, so a temporary provider failure is not
made permanent by a backup. Empty strings and numeric zeroes are meaningful
desired values; update DTOs must use explicit pointers so drift reconciliation
can clear remote fields and reset priority/weight to zero.

Runtime observations must not enter DesiredConfig: channel balance, used quota,
test/response timestamps, auto-disable reason/time, per-key disabled state, and
the current multi-key polling index. Multi-key size is derived from the
plaintext key material.

Export consistency rules:

- Read all ordinary new-api pages with overlap-safe ID de-duplication.
- Require stable complete channel scans; never stop at the first 100 rows.
- Read plaintext keys through one verified 2FA session per snapshot pass.
- Re-read channels, relevant options, and plaintext keys after the first pass.
- Return a file only when both passes match; retry the whole snapshot up to the
  configured limit instead of returning a mixed-time file.
- Strip per-tenant `byok_` groups from platform group options.

Import rules:

- A v1alpha1 file contains exactly one golden channel bundle.
- Validate the entire file before writing: API version/kind, plaintext keys,
  duplicate channel IDs, duplicate option keys, statuses, and multi-key modes.
- Import only saves an immutable revision/current desired state. It does not
  immediately overwrite remote Sets; operators must inspect the plan and
  release it through the existing drift-protected channel bundle workflow.
- The HTTP import body is capped at 64 MiB and export/import responses use
  `Cache-Control: no-store` because they handle plaintext provider keys.

When changing DesiredConfig or new-api channel DTOs, update every layer in the
same change:

```text
new-api client DTO
  -> ChannelBundleChannel / ChannelSpec / DesiredConfigChannel
  -> MySQL channel bundle and channel spec storage
  -> remote import and apply conversion
  -> desired and remote fingerprints
  -> OpenAPI and web TypeScript types
```

Required regression coverage includes full-field round trips, explicit
zero/empty clearing, manual versus automatic disable behavior, multi-key create
and replace, BYOK group filtering, key rotation during export, MySQL storage,
and channel release/traffic E2E. Do not modify new-api source to implement this
behavior; all compatibility belongs in LLMGateway.

## Testing

Run before committing:

```bash
go test ./...
```

Focused tests:

```bash
go test ./deploy/k8s/prod ./internal/setmanager ./internal/gateway -count=1
```

Optional MySQL integration tests require an isolated database named
`llmgateway_it_*`:

```bash
LLMGATEWAY_MYSQL_TEST_DSN='user:pass@tcp(host:3306)/llmgateway_it_agent?parseTime=true&loc=UTC&charset=utf8mb4' \
  go test -tags=integration ./internal/gateway -run MySQLSetRuntimeLease -count=1
```

Do not run destructive cloud tests unless the user explicitly asks for cloud
validation.

## External API Key Invariants

- Only issue v2 keys in the fixed 95-character `sk-<Base64URL payload>` format.
  The payload is one version byte, a 4-byte route slot, a 32-byte public Key ID,
  and a 32-byte Secret.
- Generate every route slot, Key ID, and Secret with `crypto/rand`. Entropy
  failure must fail issuance; never add a deterministic or constant fallback.
- Central MySQL is the identity and state authority. Reserve with a pure
  `INSERT`; retry only random primary/hash collisions, at most five times.
  User/purpose conflicts are business conflicts and must not retry.
- Central MySQL persists the full external key for fixed probe-key reuse and
  disaster recovery, alongside the Key ID, full-key hash, domain-separated
  Secret hash, route slot, upstream token, and issuance state. Protect database
  access and backups as key material. Redis, logs, metrics, and traffic caches
  must never persist or emit the full external key.
- Publish Redis only after the MySQL reservation and upstream token are durable.
  Return the full key only after route publication succeeds and the state is
  `active`. The route worker may retry `route_pending` records idempotently.
- The traffic process accepts strict v2 keys only and remains Redis-only. Do not
  restore v1 parsing or a MySQL fallback. The route slot is stable logical
  sharding input and must never encode a Set, Redis node, or MySQL instance.

## Cloud Operations

### Unified preproduction regression

Use `test/regression/` for release regression. It is the shared Go codebase for
local non-rollout checks, OrbStack, and the Beijing integration environment.
Do not add one-off curl loops when an existing Case can express the behavior.

- `preprod_release_gate` proves channel delivery, Plan-backed tenant
  onboarding, key issuance, ordinary chat, SSE, and a real
  `llmgateway-traffic` rollout with both Service-routed and Pod-pinned streams.
- Fleet-wide new-api rollout must use a Release Campaign, never a curl loop
  that creates Ring rollouts independently. The Campaign must remain one Ring
  and one Set at a time, persist the full soak window, stop on a failed health
  gate, and resume from MySQL after control/worker restarts. The single-Set
  continuity mechanics remain covered by `test/e2e/set-upgrade-soak/`.
- `fleet_release_campaign_gate` proves Ring ordering, one-Set-at-a-time
  progress, continuous traffic, exact generation increments, and final Release
  convergence. It requires an existing target Release and explicit Ring list.
- `set_upgrade_rollback_gate` and `set_manager_takeover_gate` are destructive.
  They require exactly one isolated Set and a digest-pinned new-api image. Only
  these Scenarios may use `llmgateway-regression-disruptive`; the default
  runner ServiceAccount must remain unable to create or delete Jobs.
- A Green new-api runtime is not eligible for probe accounting or traffic
  switching until a real inference request succeeds. Kubernetes Readiness does
  not prove that the new-api process has loaded pricing and channel caches.
- Controlled regression manager Jobs must use their Job name as the upgrade
  lease owner. Takeover cases must reject an ordinary CronJob or another
  reconciler completing the run, because that would be a false positive.
- Keep the normal set-manager CronJob suspended for the full destructive
  Scenario. Suspension readiness must inspect both CronJob `status.active` and
  actual Active Jobs owned by that CronJob; the status field can lag a Job
  created at a schedule boundary.
- The complete gate must run as an in-cluster Job. A developer machine cannot
  directly prove Pod-network continuity.
- `llmgateway-regression-pacer` controls the dedicated long-stream model and
  model-scoped upgrade-probe faults; ordinary regression traffic remains
  unaffected and model output still comes from `kagent-dev/mockllm`.
- The runner uses a fixed Kubernetes Lease and resourceVersion JSON Patch. It
  must fail when another actor changes the Deployment generation/template.
- Success deletes run-created tenants and ephemeral Job/report objects after
  report collection. Failure preserves business resources and Kubernetes
  objects for diagnosis.
- Failure must still execute `DeferSafetyCleanup` actions. CronJob suspension,
  fault injection and controlled manager Jobs are safety state, not diagnostic
  business resources; never register their restoration only with
  `DeferCleanup`.
- Tokens are injected only through environment variables or SecretKeyRef.
  Never put them in regression YAML, arguments, logs, or reports.
- Stable Plan/channel fixtures are registered with
  `test/regression/bootstrap-fixtures.sh`; global model pricing remains owned
  by the environment DesiredConfig and is never mutated by a regression run.

See `test/regression/README.md` and
`docs/superpowers/specs/2026-07-17-preprod-regression-framework-design.md` plus
`docs/superpowers/specs/2026-07-18-regression-p0-hardening-design.md`.

Kubeconfigs used in this workspace:

```text
/tmp/llmgateway-prod-kubeconfig              # Tencent response; source only
/tmp/llmgateway-prod-kubeconfig-cluster-sni  # required for TKE operations
```

Do not use `/tmp/llmgateway-prod-kubeconfig-refresh-sni` for production
operations. That legacy file uses a CLB hostname as TLS SNI and can return
intermittent `EOF` even when the API server is healthy.

Common read-only checks:

```bash
kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig-cluster-sni -n llmgateway get deploy,svc,llmfleet
kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig-cluster-sni -n llmgateway describe svc llmgateway-control-public
kubectl --kubeconfig /tmp/llmgateway-prod-kubeconfig-cluster-sni -n llmgateway describe svc llmgateway-traffic
```

### TKE API: IP endpoint with cluster TLS SNI is mandatory

Never put a hostname in `clusters[].cluster.server`. The TKE access path must
connect to the API IP while preserving certificate verification with the TKE
cluster hostname in `tls-server-name`. The SNI value must be the cluster domain
such as `cls-*.ccs.tencent-cloud.com`; a `*.clb.*.tencentclb.com` hostname is
not equivalent and is known to cause intermittent `EOF` on this environment.

Do not derive `tls-server-name` from the source kubeconfig `server` field. The
source can expose a CLB hostname. Obtain the cluster domain from the TKE cluster
endpoint metadata or an already verified cluster-SNI kubeconfig, then validate
it with `kubectl version` before any write operation.

Create a derived kubeconfig instead of overwriting Tencent's response:

```bash
SOURCE_KUBECONFIG=/tmp/llmgateway-prod-kubeconfig
SNI_KUBECONFIG=/tmp/llmgateway-prod-kubeconfig-cluster-sni
cp "${SOURCE_KUBECONFIG}" "${SNI_KUBECONFIG}"

# Supply these from the current TKE endpoint metadata. Do not use the CLB
# hostname from the source kubeconfig as CLUSTER_TLS_SERVER_NAME.
APISERVER_IP='<current API endpoint IP>'
CLUSTER_TLS_SERVER_NAME='<current cls-*.ccs.tencent-cloud.com hostname>'
CLUSTER_NAME="$(kubectl config --kubeconfig "${SOURCE_KUBECONFIG}" \
  view --minify -o jsonpath='{.clusters[0].name}')"

kubectl config --kubeconfig "${SNI_KUBECONFIG}" \
  set-cluster "${CLUSTER_NAME}" \
  --server="https://${APISERVER_IP}:443" \
  --tls-server-name="${CLUSTER_TLS_SERVER_NAME}"

kubectl --kubeconfig "${SNI_KUBECONFIG}" config view --minify \
  -o jsonpath='{.clusters[0].cluster.server}{"\n"}{.clusters[0].cluster.tls-server-name}{"\n"}'
kubectl --kubeconfig "${SNI_KUBECONFIG}" --request-timeout=15s version
kubectl --kubeconfig "${SNI_KUBECONFIG}" -n llmgateway get deploy,svc,llmfleet
```

The currently verified Beijing workspace kubeconfig is
`/tmp/llmgateway-prod-kubeconfig-cluster-sni`. Always inspect it before use;
endpoint IPs and cluster domains can change when the TKE endpoint is recreated.
The invariant is:

```text
server:          https://<API IP>:443
tls-server-name: cls-*.ccs.tencent-cloud.com
```

If a request returns `EOF`, first verify that `tls-server-name` is the cluster
domain rather than a CLB domain. Only after that validation may bounded,
idempotent retries be used; never normalize repeated `EOF` as expected behavior.

## Git and Handoff Rules

- Remote is `git@git.woa.com:wisp/velagw.git`.
- Current branch is usually `master`.
- Commit only the files relevant to the user request.
- Do not accidentally include temporary cloud outputs, kubeconfigs, or
  additional secret values. The explicitly documented test-environment
  management credential above is the only standing exception.
- Before final response after a commit/push:

```bash
git status --short
git log -1 --oneline
```

If there are unrelated uncommitted files, mention them explicitly instead of
silently committing or reverting them.
