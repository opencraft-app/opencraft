---
id: website-minisandbox-integration-20261002
type: task
scope: Integrate reviewed minisandbox persistent Workers into both hidden website products.
owner: mingyuxiao
status: active
reviewed_at: 2026-10-02
review_due: 2026-10-09
revision: 1.0.0
precedence: task
derived: false
---

## goal
Reuse Skip's actual `minisandbox` runtime/storage implementation for shared persistent websites; verify Beijing/Korea, then hidden domestic/international production and the owner's Agent-created Todo.

## non_goals
- No new execution engine, browser localStorage substitute, fleet Skill rollout, frontend exposure, or other-user VM modifications.
- Do not infer production readiness from source documentation or mock tests.

## requirement_ids / requirement_refs / requirement_excerpt
User request in this thread on 2026-10-02 authorizes code, commits, MRs, hidden release and single-user Skill delivery; difficult decisions require clarification. Account: usr_143e96b636afd48b3addc752. Live instance must be re-resolved before mutation.

## interface_refs / data_structure_refs
- `minisandbox/infra/cells/internal/workersapi/model.go`: immutable Version modules, Deployment CAS, logical ObjectRef.
- `minisandbox/infra/cells/internal/workersapi/api.go`: upload/prepare/deploy, stable Object claim, terminal deletion.
- `minisandbox/runtimes/workerd/host/workerd/worker.js`: generated isolate/DO and SQL capabilities.
- `minisandbox/runtimes/workerd/host/src/sqlite_bridge.rs`: Actor generation-bound Depot SQL storage.
- `workers/internal/website/backend.go`, `ctl/pkg/logic/website/backend_runtime.go`: current paired release protocol.
- `site-gateway/internal/httpapi/fullstack.go`, `siteauth.go`: fresh site state, owner writes, share read authorization.

## history_context
Current: reviewed import e895c598a and source/builder update f06c5e0af. Imported subtree metadata explicitly identifies unpublished local history. Previous source 357477660/!4891 implements a limited stateless runtime, not Skip's design; it is retained only for compatibility and bounded rollback.

## acceptance
- Agent publishes real Todo using SQL-backed backend; browser A adds and independent authorized browser B reads.
- Browser/adapter/host replacement and redeploy preserve site data; different sites cannot see it.
- Failed candidate and explicit rollback preserve paired frontend/backend and data.
- Static sites unchanged; anonymous/share visitor mutations rejected; sharing revocation and expiry fail closed.
- Beijing and Korea public-path tests, followed by both production environments with hidden show() entry.
- New-machine built-in Skill plus targeted actual-owner-machine delivery and process environment verified.
- Immutable source/image/GitOps revisions, Argo Synced/Healthy, workloads and production business acceptance all required.

## affected_paths
site-runtime, site-gateway, ctl website logic/config, website Skill/delivery, scoped release configuration and formal runtime design.

## required_context / context_receipt
Read root AGENTS, release-gitops pack, CTL pack, service AGENTS, minisandbox CLAUDE, runtimes README, workerd-host README, Workers API model/handlers, worker registry model, fleet Workers API deployment.

## evidence
- Skip's actual source provides immutable Worker modules/versions, CAS Deployment, per-Actor SQLite, Depot/FDB commit ACK and generation fencing; source existence is not live verification.
- Existing facade accepts only active Deployment for durable Object fetch. A per-release Worker/Object would reset the site's database and is rejected as a design.
- Existing website gateway denies share API reads; original static share authorization already supports read-only signed share sessions.

## decisions
Proposed integration: trusted protocol adapter in site-runtime; one Worker and stable logical Object per environment/site. Each prepared Worker package retains the existing bounded backend module set and dispatches by the trusted immutable backend digest. Candidate preparation therefore keeps old release callable; CTL's existing single active-release commit remains the frontend/backend switch. User code receives only site SQL storage, not registry/Engine capabilities. Validate with the real runtime before enabling data capability.

## risks
- Persistent runtime endpoints, qualified images, regional access and authorization must be verified live before rollout.
- Readiness must exercise compile/activation without executing user application mutations.
- Retained versions/modules and SQL results/storage need explicit bounds.
- A lost local adapter revision store must fail closed; stable upstream Actor identity must not be regenerated.
- Upstream Worker deletion intentionally refuses historical DO inventory. Delete the stable Object with a terminal tombstone; do not invent force deletion or claim physical registry reclamation.

## validation
Focused Go tests/race/vet/build for modified services, controlled JS adapter tests, Skill/package contracts, docs impact, scoped Kustomize/render/placeholder checks; real persistent runtime and both regional/public/prod acceptance.

## handoff
Active source analysis and implementation. No production application deployment, GitOps, user-machine Skill delivery or frontend release in this task. One uniquely scoped source fixture Version was uploaded to Skip's Beijing fleet; its Deployment preparation returned 503 and current deployment lookup remains 404. No durable object or user application data was created. Do not call ready or complete until acceptance evidence exists.

## stage
Adapter implementation and runtime availability diagnosis. Production remains closed.

## verified
- 2026-10-02 current source base remains f06c5e0af; worktree branch codex/website-minisandbox-integration-20261002; shared dirty checkout untouched.
- Cloud identity/current inventory binds Beijing management cls-b2lt3ed9 and operator ins-55ry1kb1 to VPC vpc-2e07jlai. The current Workers API CLB is lb-61ahe91p / private 10.160.0.3:6688, not the historical 10.160.0.17 address. Private API readiness returned 200 via that operator's native VPC path.
- Actual source fixture Version v_9f05eafcbc8797f6873575a9d780a9a06f6833ad87a09b30c2c63ff273ec6ed8 uploaded successfully. Deployment returned 503 executor_unavailable before pointer activation. Later GET deployment is 404; no object PUT/SQL ran. Preserve invocation inv-d9d3fi0i28 and exact failed receipt; no blind redispatch.
- Current management Workers API has 3/3 ready replicas at image sha256:964c7386040fc486ee651e1bffe8022b9a27de5efe15211b0cebb5cd2fbe8df5. ShardPool actor-beijing-kubernetes admission is closed: 1 ready Cell, minimum 2. A reports health/placement false; B true in current read-only sample. API readiness alone does not mean an executor is available.
- Adapter/Go tests and five controlled Node/SQLite wrapper tests passed, including readonly SQL mutation/prototype-tampering rejection and transactional rollback on result quota. These are NOT Depot/FDB/pod-restart or user-browser acceptance.
- Fresh repository code now chooses stable per-environment/site DO identity, retains bounded immutable backend modules, uses deployment CAS, validates compiled package identity, and stores exact active-version receipts locally. Gateway share reads are default closed and send trusted readonly metadata only for valid unexpired generation-bound sessions. Writes remain owner-only.
- Data capability is an independent default-closed release flag plus user/backend gate. Skill has SQL contract and shared-Todo template; image Skill bundle includes the template. None has been delivered to a user machine.
- Current domestic credential Skill was replaced during this work by a credentials.json + access.py protected loader. Private scripts now use the current loader; no credential values retained in task docs or outputs.

## unverified
- Root cause and safe recovery of Cell A health gate; do not reduce pool minimum readiness, forge reports, bypass admission, or patch shared workloads to make qualification pass.
- Real wrapper linking/custom DO storage on the pinned deployed fork, commit ACK, data across generation/redeploy/restart, site/environment isolation, full deletion fence.
- Legitimate consumer connectivity from Beijing/Korea and both production environments. Regional cloud inventory found no Actor-named international clusters; this does not prove no reusable runtime exists. Do not route international data into a domestic fleet silently.
- Scoped CTL/workers/gateway race/vet/build, image Skill tests, formal docs and placeholder/config render, code review, MR/build/release and user Agent/browser acceptance.

## discard
Historical endpoint 10.160.0.17 and root/.kube/config on the management operator are not usable current access paths. The latter points at 169.254.128.4 and rejects credentials. Use cloud-issued current private cluster credentials via the approved protected TAT channel; never print configs or disable TLS.

## restore
Local evidence/ledgers: .tmp/minisandbox-integration/. TAT invocations: inv-d9d3fi0i28 (failed source fixture), inv-c9d3tw0ap7 (pool/config inspection), and fleet-current-cluster/health ledgers. Resume existing invocations rather than issuing new writes. Existing acceptance fixture owns worker lv-1aa4db268f8ddf77d87d7924e2b009c062442d7685a3bbdaeaf09ed8; it has no active Deployment. Keep the full Goal active.

## next_action
Read current RivetCellReport health booleans to identify Cell A's exact failed safety input, then follow the reviewed narrow recovery path. In parallel with source readiness work, keep persistence and production gates closed until real qualification succeeds.


## checkpoint_20261002_native_progress

- Admission recovered without any pool/health/FDB mutation by this task. Current
  management snapshot observed 2 ready Cells, valid fresh projected reports,
  matching route identities/digests and Workers API service-account read access.
- R3 (`inv-e9d5b106pf`) progressed from executor_unavailable to a native compile
  rejection. Sanitized exact Workerd TypeError: string modules require `.js` or
  `.py`, not `.mjs`. Adapter now uses internal `.js` names; source artifacts and
  the user's `backend/app.mjs` contract are unchanged. Added failing-then-passing
  native-module-name regression.
- R4 (`inv-a9d5u4gbmr`) passed real version upload/CAS deployment, exact stateless
  package linking, stable Object creation, empty share SELECT, owner SQL POST,
  independent read and old-digest read after code deployment. New-digest warm
  reads returned 409 for the bounded six-second window: this is a failed overall
  fixture, not Ready or a production acceptance receipt. It has NOT been deleted.
- Scoped read-only follow-up `inv-e9d6130326` read both digests successfully after
  idle and returned the original Todo ID/title/created_at. This proves retained
  data across this observed code transition; it does NOT prove Pod/host replacement
  or actual independent browser/Agent acceptance.
- Retained fixture: scope cn-accept-20261002-r4, site ws-minisandbox-20261002,
  Worker /v1/workers/lv-e76147ed7aa571e47d41a6a6c620011db645bd4c2db86bb66357f1ab.
  V1 v_077d124ca5129dd3b4754761f36a74b600ddb0d5e48a512c61c10fea6122bbca;
  V2 v_8c46cd3ca187e7573a08464c7651199757fc1a1e7be733cbe1099a8a5e47bb76.
  Latest recorded active deployment d_57eb458a69aa1c4a4f81c939681ae7ae.
  Re-read current state before any follow-up mutation; preserve all issuing ledgers.
- Runtime now requires actual durable package-ID probes as well as active-version
  and local receipt checks. Stale durable code fails preparation and compensates
  only its own activation via CAS; canceled callers cannot cancel bounded rollback.
  Receipt includes expected package ID. Timeouts now reserve compensation time:
  prepare 60 s, rollback 40 s, manager write 105 s, worker context/client 110 s,
  shutdown 110 s and candidate systemd stop 120 s.
- Skill text now consistently treats backend and SQL as separate fail-closed
  capabilities. Added template packaging directory creation/fsync and old two-file
  bundle upgrade/rollback compatibility. Skill delivery regressions: 19 passed.
- Reviewer fixed Todo replay/concurrency/UUID defects in its bounded template/test
  write set; final template result and warm-version source analysis remain pending.
- Added independent CTL data-gate and gateway stale-cache fresh-revocation/expiry
  regressions. Runtime/gateway race/vet/build and scoped CTL/workers gates are being
  rerun; confirm process exit/logs rather than assuming completion.
- Local normal-TLS HTTP checks at 2026-10-02 11:52 +08:00 returned 200 for
  lightvela.ai `/` and `/agents/chat/`, and lightvela.com `/agents/chat/`.
  This is current local reachability, not a concluded historical outage root cause.
- No source commit/push/MR, production application/GitOps rollout, Skill TAT
  delivery or user Agent mutation has occurred in this resumed phase.

## next_action_20261002_native_progress

Finish the source trace of floating Worker references/warm durable version changes;
qualify the durable readiness probe against the live image and fix version propagation
via the smallest reviewed upstream/adapter route, not a new JS engine/database. Keep
all release gates closed. Then actual regional adapter/SQL/isolation/host restart,
Korea connectivity/storage and public-site tests; only after all gates pass perform
hidden domestic/international rollout and owner Agent/browser Todo acceptance.


## checkpoint_20261002_1408_progress_refresh

- Goal remains active; this minisandbox integration has not been committed, pushed,
  merged, or deployed to production. No owner Skill/Agent mutation in this phase.
- Native owner SQL write and independent HTTP read passed in R4/R5 fixtures.
  Data survived an observed version transition after idle. This is not browser,
  Agent, host-restart or dual-region acceptance.
- R5c continued hot traffic: stateless dispatch converged in 31 ms, but durable
  Object kept executing the previous package for 12 seconds (122 observations,
  77 warm pulses). Overall receipt FAILED; do not replace this gate with idle
  success or a larger timeout. Receipt: native-warm-r5c-receipt.json.
- Native CAS ownership and stateless package-fence regressions are implemented
  and verified. Native transactional adapter focused race tests passed; the
  Service/journal implementation is still undergoing worker validation and
  requires joint review plus full-module race/vet/build before any merge claim.
- Latest native admission evidence at 13:51 CST: admissionOpen=false; A/B Cells
  Qualifying with PlacementReady=False, reason QualificationMissing. No shared
  fleet, FDB or safety gate changed by this task. Re-read live state before any
  further deployment attempt; no bypass/forged qualification is permitted.
- International runtime/storage/public-path qualification remains unverified.
  Prior regional inventory errored with the wrong TKE API version; use verified
  2018-05-25 helper, not the errored empty arrays, on the next read-only query.
- Source task record has been refreshed; terminal self-created secret-bearing
  payload files were removed without touching evidence, ledgers or credentials.

## next_action_progress_refresh

Collect transaction worker result; jointly review adapter/service recovery and
run complete source gates. Reconcile native admission read-only, investigate
continuous-hot durable source versus actually executing package, and complete
regional inventory/qualification. Keep production and per-user Skill gates
closed until real runtime acceptance succeeds.


## checkpoint_20261002_1443_joint_gates_and_runtime_provenance

- Service transaction worker completed its bounded write set. Main full runtime
  race tests PASS (75.847 s), vet/build PASS; full gateway race/vet/build PASS;
  scoped CTL/workers race/vet PASS. Wrapper + Todo Node tests PASS 33/33 with the
  required --experimental-vm-modules flag; Skill delivery Python tests PASS 19/19.
  These are source gates, not runtime qualification or release evidence.
- Correct TKE API 2018-05-25 found and reached Korea cluster cls-62u28nhn
  (tke-kr1) using its authorized public endpoint with normal TLS. Namespace and
  Deployment/StatefulSet inventory is saved. No native minisandbox workloads
  discovered in this cluster. Main-account CVM name/tag inventory is complete
  for Seoul (9) and Singapore (1596); no explicitly native-labeled candidates
  discovered. This does not prove absence in every account or unnamed service.
- Native admission re-read inv-c9d9a50jat still closed, qualification missing.
- Live native host re-audit inv-d9d9wkgj5a: A and B now both use digest
  3185052ffd502857f347f6d779288142c47d8ed0725b8c9eca342fdd4527919c,
  source a2f68ea8bc521958a539522a74b063ea4f65889e. Earlier B digest 4aeb...
  is historical, not current. No shared runtime/fleet change by this task.
- Read the locked fork bundle (tree matches lock). ActorNamespace.getActorContainer
  retains the first dynamic class via findOrCreate; unsafe.evict drops the live
  Actor but deliberately keeps ActorContainer in the namespace map. This is
  a concrete candidate explanation for stale hot class replacement, not yet
  a verified actual-path root cause or a fix.
- Isolated tests use actual Workerd binary read from the exact runtime Pod, run
  only on the operator in a temporary directory with CPU/time limits; no fleet
  or user data mutation. Binary hash 9b82d8c0895ff173aa0ed1788ab4e6b5d56efef31e4a1e9b7993711d332dab3b.
  Initial attempts stopped at image/config compatibility checks before ABI tests
  ran; do not report them as runtime test passes/failures. Test config now uses
  flags consistent with the selected compatibility date, and unsafe_module.

## next_action_joint_gates

Finish isolated actual-binary hot-swap repro; choose the smallest safe fix only
from that evidence, preserve database/Actor identity and exact version fences.
Collect bounded adapter review, recheck native admission and establish an
actual regional runtime before any release. Full Goal stays active.


## checkpoint_20261002_1518_direct_fixes_and_live_gate

- User instruction: stop expanding synthetic test matrices; directly fix proven
  issues and retain necessary regressions and actual acceptance only.
- Isolated actual Workerd binary repro confirms ordinary native eviction retains
  the old dynamic DO class; breaking the container with native state.abort permits
  class replacement. This alone is not Depot/FDB persistence acceptance.
- Implemented private stale-marker-only DO reset, complete versioned wire-package
  fingerprint and exact pointer fences. Managed GET readiness is now exclusive
  with same-site invocation, preventing reset during in-flight app requests.
  Native transactional receipts without endpoint identity fail readiness, invoke
  and PUT closed rather than silently rebinding old state.
- Current source: focused reset/fingerprint/legacy regressions PASS; wrapper/Todo
  Node PASS 34/34. Full runtime race PASS (71.959 s), vet/build PASS after these
  fixes. Linux exact binary/source artifact hashes recorded for actual adapter
  acceptance. No production, GitOps or user Skill mutation.
- Fresh read-only native admission inv-e9dat8gt8w: admissionOpen=true, 2 Ready
  Cells, both PlacementReady=true. Earlier closed-gate evidence is historical.
- Fresh native runtime inv-c9daxi0cja: A/B hosts Running at unchanged digest
  3185052ffd502857f347f6d779288142c47d8ed0725b8c9eca342fdd4527919c,
  executing source a2f68ea8bc521958a539522a74b063ea4f65889e and wrapper
  9fe08ff8e2e4a93c9204fc15fba12b39c9e204f733372e355dd7e23ab0f9cb29.
  Operator current source checkout has moved independently; no shared fixture
  deployment will be reused or claimed by this task.
- Actual Go adapter/native shared SQL hot-update/restart/site-isolation acceptance
  is being dispatched to an isolated loopback-only process with a new unique
  scope. No shared Host restart or fleet safety-gate mutation. International
  regional runtime/storage and final browser/Agent/public path remain unqualified.


## checkpoint_20261002_1529_actual_native_adapter_pass

- Actual isolated Go Service -> native Workers/Durable Object/Depot/FDB path
  PASS, immutable TAT invocation inv-d9db8b0f0p, scope
  cn-adapter-20261002-r6-151740. Executing gated Linux binary
  d9bd704a6df89d02d2ccce04504f5c2b93058308a4a2bac1eb88125d3c0833c7,
  production-source tree hash
  46e370f467a0cbdfcac0ffa733de4d9a79d8b3cbf2c87ad49568570459b45cbe.
- Real owner SQL write and independent HTTP read succeed. Under warm traffic,
  release two preparation completed in 1.932 s; new and retained backend digests
  read the same committed Todo. Six warm reads remained 200 and saw the row.
- Restart of only our isolated adapter process preserved bound receipt/readiness
  and native data. Another site in the same scope saw an empty database. Native
  host UIDs/image IDs stayed identical before/after. No shared Host restart.
- This is not Agent, browser/public path, native Host restart, native deployment
  rollback or international/production acceptance. Keep those gates explicit.
- Signed binary relay used one unique object in an existing private qualification
  relay bucket; after successful download, that exact owned object was removed.
  Temporary credential-bearing dispatch payload and remote kubeconfigs were
  removed. Scoped test database/artifact evidence is retained.
- Current Beijing website consumers still use the old readiness images and
  existing TLS runtime origin https://10.15.225.38:8090. Actual consumer network
  path to native API is now being checked before updating any deployment.
  No production, GitOps, owner Skill or Agent mutation.


## checkpoint_20261002_1548_accelerated_release_path

- User requests fastest hidden launch. Stop extended discovery and new synthetic
  test matrices; prioritize scoped domestic consumer wiring/build/deploy/owner
  acceptance, keeping international parallel and unreleased status explicit.
- Actual Beijing CTL Pod -> native private /readyz HTTP200. Earlier empty probe
  did not forward stdin and is not connectivity evidence. The corrected probe
  uses kubectl exec -i; no ACL/TLS/route mutation was needed.
- Fixed the final local identity gap: missing receipt with existing release
  artifacts now blocks invoke/readiness/PUT; an absent or empty site still allows
  first publication. Existing focused transaction/native regressions race PASS
  (76.888 s), current runtime vet/build PASS. No new test matrix added.
- Current Linux binaries for CTL API, website-deployer, site-gateway and runtime
  are compiled. Source hash 2f780e7a27153aea33a962af6634e3aa5b9798b4aae4bbf6698bd3c07a44c9bd.
  Scoped Beijing test image publication is underway using pinned existing bases
  and credential-private temporary registry auth. This is not production release.
- International read-only discovery: complete Pod/Service/workload/CRD inventory
  in cls-j350bwok and cls-249ml7cq found no identifiable native service. The
  cls-agq89bfe Pod LIST is blocked by SSLError; do not infer absence there or
  worldwide. No qualified international native route yet; never silently route
  overseas data into Beijing. Evidence index:
  .tmp/minisandbox-integration/international-runtime-discovery-sg-20261002-summary.json.
- Formal design impact check and staged whitespace checks PASS. Production,
  GitOps, owner Skill and Agent mutations have not begun in this phase.


## checkpoint_20261002_1645_parallel_consumers_deployed

- Committed and pushed source HEAD 8b02b4f23522a2ea54209d504742a3b2d43c8a1d.
  Source MR !4938 opened, target master; not merged or production-released.
  The desktop artifact tool rejected the Gongfeng MR URL; MR itself exists.
- Beijing manager ctl/website-minisandbox-runtime-readiness created with a
  dedicated 20 Gi RWO PVC, Recreate single replica and stable scope
  cn-bjtest-minisandbox-v1. Native shared hosts were not restarted.
- Startup initially failed because a Kubernetes Secret projection is a symlink
  with group-readable mode, rejected by the existing private-key Lstat check.
  Fixed only the scoped deployment: nonroot init materializes regular 0600
  TLS files into a private memory volume; runtime mounts it read-only. TLS
  protection was not relaxed. Runtime is Ready, zero restarts on the new Pod.
- Certificate-verified TLS and separate deploy/invoke role checks passed.
  Raw busybox nc stdin-EOF probes returned upstream_unavailable/503 while
  normal Pod wget HTTP clients returned ready/200; operator read-only TAT
  inv-a9dde9g1ie also confirms ready/200, admissionOpen=true, readyCells=2.
  Do not classify the raw probe alone as a native outage or bypass admission.
- Beijing CTL API, site gateway readiness candidate and website-deployer
  now use the exact four-component build source hash
  2f780e7a27153aea33a962af6634e3aa5b9798b4aae4bbf6698bd3c07a44c9bd.
  All three rollouts passed, new imageID and Ready observed. Retiring old Pods
  may still appear in the rollout snapshot; validate settled endpoints next.
- Consumer runtime origin is HTTPS on the new manager Service. Dedicated
  public CA maps preserve old trust roots and current system roots (151
  certificates including the new test CA). Existing deploy/invoke bindings
  matched the manager values; no credentials changed.
- Persistence/shared-read flags opened only on these controlled Beijing test
  consumers; existing Beta account scope preserved. The candidates have no
  observed Argo ownership, so unrelated Argo applications were not paused.
- User explicitly requested parallel acceleration: Euclid handles concrete
  international runtime/deployment path; Volta reviews current transaction,
  pointer/fingerprint/concurrency and capability boundary release blockers.
  Main path moves on Beijing true consumer-chain acceptance.
- Source/GitOps/production/user Skill/Agent/browser final acceptance remains
  incomplete. No production, GitOps or owner-machine mutation in this phase.


## checkpoint_20261002_1712_sql_lifetime_fix

- Parallel review identified a real P1: an application can cache the owner SQL
  capability and reuse it during a later share GET, bypassing per-request readonly
  enforcement. Integrated the one-file repair: scoped capability revocation,
  per-DO handler serialization and private-reset busy guard.
- Added a bounded 3.5-second wrapper handler deadline so a suspended async
  application cannot keep the per-DO queue permanently held after the outer
  five-second HTTP deadline. Expired SQL capabilities remain revoked for late
  continuations. Existing VM harness now supplies the real platform timer APIs.
- Minimal offline before/after proof: old wrapper permits one cached-capability
  write from share, fixed wrapper rejects it and leaves zero rows. A permanently
  suspended handler returns 500 after 3503 ms and the queued share recovers with
  200. This is a repair proof, not native or production qualification. No new
  committed test matrix added.
- Current wrapper/Todo existing regressions PASS 34/34; runtime focused race
  PASS (2.606 s), current vet/build and Linux r7 build PASS. A new immutable
  Worker package must carry the wrapper repair; retrying an existing PUT does
  not rewrite an old native package. No real test publication was dispatched
  before rebuilding/updating the runtime manager.
- Actual existing controlled Beijing test VM ins-ndkqrlhp freshly verified
  RUNNING. Read-only credential-authenticated public capability/site preflight
  passed, TAT inv-c9de1n0xsm: fetch-v1 and rivet-sql-v1 both enabled; quota 1/1.
  Its existing isolated website ws-38f6d001b70a3d7b will be used for the real
  CTL -> worker -> runtime -> gateway publication, not a newly forged account.
- Prepared a deterministic 3020-byte shared Todo artifact and explicit
  publish/upload/operation ledger script, not dispatched yet. Existing user
  production machine and Skill are unchanged.
- Review follow-up worker stopped on a tool error after returning its initial
  patch; main performed the bounded lifetime/deadline proof and took over.
  International concrete deployment path remains delegated to Euclid.
