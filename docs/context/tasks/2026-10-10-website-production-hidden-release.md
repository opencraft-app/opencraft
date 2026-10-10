# Website production hidden release — 2026-10-10

## objective
Deploy the integrated persistent website backend using regional enablement and a show()-hidden frontend entry, with no account entitlement list. User authorized code fixes, reviewer mingyuxiao, review/merge and production hidden rollout. No replacement of production storage with test storage.

## non_goals
Do not change unrelated Argo drift, fleet-wide Agent installations or user credentials. Do not treat a closed preparation rollout as an enabled persistent-backend acceptance.

## context_receipt
Root and local AGENTS, site-runtime/AGENTS, .ci/AGENTS; agent-gateway-runtime/release-gitops domain packs and ctl/workers service context; argocd README and gitops-release-contract. Current lightvela-credentials delivery, access and website references. Existing !4938 reused and reviewer invitation mingyuxiao acknowledged without failures.

## source_audit
Old production CTL overlays only masked WEBSITE_BACKEND_BETA_USERS; the new regional gate requires explicit WEBSITE_BACKEND_ENABLED=0 and WEBSITE_BACKEND_DATA_ENABLED=0 during preparation. Update all six CTL consumers and explicitly close shared backend reads in both site gateways. Generated enable bindings override these defaults after regional acceptance. Correct remaining current release instructions referencing owner lists; preserve historical handoffs.

## live_audit
2026-10-10 protected local Kubernetes reads inspected resolved envFrom/configMap/Secret inputs in memory without printing values. SH/SG CTL 3/3, site-gateway 2/2, website-deployer 1/1 ready. All three consumer roles lack WEBSITE_RUNTIME_BASE_URL and their runtime role tokens. Neither observed operations cluster has deployments/statefulsets/services matching the native/runtime components. This is not an absence claim about all accounts or VMs. TKE main account inventory: Shanghai four clusters (operations, LLMGateway, Temporal worker and Vitess); Singapore three (operations, Vitess, sg1). cn_readonly Shanghai agrees; cn_readonly Singapore lacks CAM permission, not zero clusters. Old migration receipt is not a current schema check.

## release_gates
Freeze source after fixes and review; read production schema; inspect exact Argo leaf differences before promotion. Discover regional native infrastructure and private manager URL/TLS/single-writer persistence/role credentials. site-runtime has Dockerfile but no standard production bundle/leaf in this source: do not invent an endpoint or deploy manager without the native storage/executor prerequisite. Source default-closed changes and a compatible-code rollout alone do not finish the goal.

## validation
Regional binding source-render suite, diff check and design-impact guard. Existing source 1f5d22fe9 has CTL/worker/runtime race/vet/build, gateway integration/vet/build, wrapper 40/40 and frontend show tests/typecheck evidence. Rerun only checks affected by new configuration edits.

## checkpoint
Active: inspecting production release gates. No production write, Argo sync, schema change or infrastructure creation performed yet. Goal remains active until configured/verified hidden capability is available, or a recurring external blocker requires user decision.

## 2026-10-10 continuation checkpoint
!4938 source 954166d3d6af2893ea3823524cf20c74ffd4e147 passed CI; current identity
mingyuxiao review approve was executed under explicit user authorization. Standard
merge succeeded at 363154bde7ee09ca1b90f38f8496136fecaf330f; fetched master ancestry
verified. Latest regional render tests 20/20 and frontend gate tests 37/37 passed.
Both live migration tables report 32 / dirty=0. SH site kinds: static 1319 / legacy
empty 1122; SG static 179 / legacy empty 209; no fullstack site row reported.
Argo root cause: the sole Ready node has DiskPressure=True since 2026-10-10T02:55:50Z.
Application controller and repo-server are Pending with untolerated disk-pressure taint.
Node image filesystem shares /data: capacity 1056682070016, available 154147356672
bytes (~14.6%); native container images themselves use only ~397MB. /data is ~799GB
used; shared Docker tree scan timed out and was not treated as zero usage. No taint
removal, eviction-policy changes, restart or cache/worktree deletion was performed.
CVM actor-serverless tag inventory in the main account found 0 in Shanghai/Singapore;
untagged/all-account absence is unproven (unfiltered bounded samples incomplete).
Generic CI pipeline listing returned an empty catalog despite known accessible CTL
pipeline; use commit checks and exact IDs, not absence inference. Master merge starts
normal automated build channels; no manual production promote/sync executed.
Remaining: qualified production native region binding and release control-plane recovery,
then exact-source images/GitOps/Argo/hidden business acceptance. Goal remains active.

## 2026-10-10 authorized disk-pressure cleanup
User explicitly authorized removal of useless control-plane-host artifacts. Protected
SSH inspection confirmed Docker /data/docker/lib shares the native k0s imagefs,
with imagefs.available eviction threshold 15% and transition period 5m. Reclaimed
5.328GB + 877.5MB of engine-reclaimable build cache, bounded by last-use filters
and excluding active/recent cache. Two stopped July 2 disposable build containers
were inspected (no mounts; writable changes limited to dependencies/caches) and
removed without force or volume deletion. Only untagged images older than 720h
were selected for image prune. Running anydev-agent preserved. No source tree,
shared pnpm/npm store, business volume, observability image, Argo recovery archive,
node taint, eviction threshold or service restart was changed. Last pre-watch
/data available 158868099072 bytes; recovery still needs fresh node/pod/Argo proof.

Frontend build blocker found in automatic production artifact CI: vendored
vela-chat-client-core lacked canonical messaging/platform export wildcards.
Canonical sync script updated only generated package manifest and UPSTREAM digest;
check passes, real embedded workbench build verification is running locally rather
than adding load to the pressured release host. No follow-up commit/MR yet.

Additional engine-reclaimable cache: 2.595GB. Removed 2,993,389,568 allocated
bytes of obsolete /tmp/lightclaw-frontend-preview-output: 55 hash-keyed static
out-cn/out-global trees, no Git markers, no recently changed files (7d), no
open process references or systemd references. Preserved the source-containing
/tmp/opencraft-build-Ly4oBe. Five inactive >12h transfer logs were truncated to
64KiB diagnostic tails, reclaiming 874,854,313 bytes. /tmp is a bind on /data.
/data available reached 160479711232 bytes; waiting for natural kubelet pressure
transition and controller recovery, not force-clearing taints.

Real local frontend build reproduction showed snapshot export sync alone is
insufficient: shared Collaboration sources are file-linked outside the npm
workspace and cannot resolve its installed dependencies. Vite deduplication now
resolves the workbench-owned chat contract and Tencent SDK/upload plugin.
Embedded production release build passes. Existing shared snapshot test passes.
Workbench typecheck still exits 2: current 48 errors / HEAD baseline 48 / new 0;
baseline and current were executed on the same installed dependencies, and the
candidate files restored. No standalone-mirror or whole-client acceptance claimed.

## 2026-10-10 final continuation evidence (in progress)
Build-compat source ad9ce8b5f4c4d0a4104c7fb897e389273e972971 pushed; !5162
(global 27621693) reviewer mingyuxiao approved under explicit authorization.
MR placeholder CI b-4e13db04545549978e3e6c937a622fb4 passed at this source;
standard merge succeeded at 7eee00805f1b698959f37775e7971640e31ea293,
fetch/ancestry verified. New frontend artifact build b-c9e7e4a0b65540929a7c2814280fb4af
is RUNNING at the merge source. Original CTL build b-60b8a67363474c9495197aaef0b1c408
is authoritatively CANCELED, not an observation timeout and not an image receipt;
no restart/rerun performed. Gateway/website worker original builds reached their
production approval stages; none approved yet. Concurrent master integration
contains unrelated CTL instance/desktop changes; freeze/review service source
explicitly instead of treating new master as identical to the qualified CTL image.

Additional old inactive (>72h, regular files, no open descriptor) compiler-cache
reclaim: tsx 768679936, Node 165969920, Go 163995648 and 445956096 allocated
bytes. Shared package stores, recent compiler caches and all source trees preserved.
Another engine-reclaimable unused >15min build-cache prune reports 3.926GB.
DiskPressure naturally became False at 07:35:49Z and core controller/server pods
became Ready; free space then dropped during concurrent builds/image pulls,
pressure returned at 07:36:40Z and repo-server/redis were evicted. This transient
recovery does NOT prove the control plane restored. Last 07:39:34Z node condition
was True; a bounded live recovery watch is running. Do not report Argo restored
until fresh repo-server/redis readiness and exact Application comparisons succeed.
Observability.img is sparse (268435456000 logical bytes, ~3GB allocated; loop
filesystem ~273MB used). It is not a 250GB cleanup candidate and was untouched.
No force-taint removal, eviction change or service restart performed.

Latest bounded recovery watch finished: DiskPressure True again since
2026-10-10T07:46:00Z; available 158467149824 bytes versus eviction threshold
158502316800 bytes. Application controller, ApplicationSet, dex, notifications,
repo-server, server and API server Ready; Redis replacement Pending. Repo-server
init steps completed exit 0, but control-plane/application comparison recovery
remains incomplete while pressure recurs. Do not declare stable recovery or
production release. No build cancellation, runner disablement, expansion, force
sync or further infrastructure write was done to overcome shared-host churn.
Goal remains active; broader shared-runner interference needs explicit scope.

## 2026-10-10 regional prerequisite read-only continuation
Previous goal turn made authoritative progress (build fix merged and authorized
idle artifacts reclaimed). Automatic continuation is not consent to disable a
shared runner. Fresh 07:49:33Z node DiskPressure=True; all active Argo core Pods
Pending again, /data available 155888812032 bytes. The exact new frontend build
b-c9e7e4a0b65540929a7c2814280fb4af remains RUNNING, not stopped/failed.

Main-account live CVM DescribeZones: Shanghai available zones 2/5/8/10;
Singapore available 1/2/3/4. Both pass the source production three-AZ count gate.
Main-account VPC reads validate operations clusters' VPCs: Shanghai
vpc-2y7p1lk6 and Singapore vpc-253zjh0f both use 10.0.0.0/12. They do not overlap
source-planned regional Actor aggregates 10.176.0.0/12 and 10.224.0.0/12,
but this is only the operations-VPC comparison, NOT an all-network collision
clearance. The identical operations CIDRs reinforce the required independent
regional routing/CCN design; do not attach both to a common Beijing route domain.

Live CVM hourly instance-configuration reads expose a real Singapore portability
constraint: committed Beijing intent control/builder SA9.4XLARGE32 and FDB
SA9.LARGE16 are offered only in Singapore AZ2/AZ4. Four available physical AZs
alone do not qualify these instance pools for three-zone production. Shanghai's
SA9.4XLARGE32 is SELL in AZ2/5/10 and SOLD_OUT in AZ8 at this observation.
Singapore alternative FDB-size SA5.LARGE16 is SELL in AZ2/3/4; 16CPU/32GB
candidate alternatives do not close three-zone control coverage. 16CPU/64GB
configurations exist across AZ2 (SA5), AZ3 (S5), AZ4 (SA9), but that changes
reviewed capacity/cost and is merely planning input, not an approved substitution
or reservation. No instance purchase, Terraform apply, pool configuration or
Beijing fleet-intent mutation performed. Availability is a time-bounded offer,
not a quota, Native-node compatibility, storage, qualification or runtime receipt.

Existing source fleet rebuild explicitly keeps foundation/management/whole-Cell
Terraform at a human-reviewed boundary. Actual production Workers API/manager
bindings, independent storage identities and complete regional receipts remain
unresolved; do not replace those with test URLs or fabricate a production intent.

Frontend build b-c9e7e4a0b65540929a7c2814280fb4af is now terminal FAILED.
Authoritative error identifies Cloudflare artifact staging publish, not the fixed
OpenCraft build: current upload reported a 20000-file limit. Exact source
7eee00805 manifests/extracted dist show global CF 20363 files, including 10183
under .edgeone; public remainder 10180. CN CF 5597, including 2800 under .edgeone.
No node_modules/.git/.next/.vite markers were found. EO global artifact is also
archived/verified at this source; its publisher selects its required .edgeone
format. Old OCI references/archive digests were not rewritten or deployed anew.

Follow-up branch codex/frontend-cf-artifact-boundary-20261010 fixes provider-only
packing: remove generated .edgeone only from CF output before content hashing
and OCI archiving, preserve EO and all public pages/RSC/search/embedded resources.
Two isolated regression cases (separate output and in-place out) fail on the
previous implementation; affected artifact/release suites now pass 51/51.
Full producer rebuild/staging deployment at the new reviewed source still needed.

CF-boundary verification: 4 affected suites / 51 tests pass, including explicit
EO preservation and both CF output layouts with public-content byte assertions.
Full frontend pnpm check passes: i18n structure 0 errors (47 existing warnings),
630 doc metadata entries valid, MDX generated, TypeScript 164 current / 171
baseline / 0 new. Node syntax and diff checks pass. No source/public UI edits;
the Agent Console copy boundary is not changed by this packaging-only fix.

## 2026-10-10 CF provider-boundary MR checkpoint

Source 70c6b0a7b4b31ea65dae4724896b0ae7922121f1 is pushed; MR !5168
(global ID 27624176) created against master. Authenticated mingyuxiao was
explicitly invited and submitted the authorized approval after reviewing the
provider-specific pre-hash exclusion. AI review reports SUCCESS, no comments.
MR CI p-4ed28a7f9b6a4468a10dcfa92d3f9fe4 /
b-fd9238e9052645189b604e4cc43c4628 is freshly verified RUNNING; no merge
or override while that required gate is pending. Desktop artifact attachment
rejects Gongfeng URLs; the MR remains available in Gongfeng.

Current-turn checks: four affected suites 51/51 PASS; Node syntax and git diff
checks PASS. Full frontend pnpm check exits 0: i18n zero errors / 47 warnings,
630 doc metadata checks, TypeScript 164 current / 171 baseline / zero new.

Fresh Argo host read: /data free 159329878016 bytes (barely above the
158502316800-byte eviction threshold), node Ready=True / DiskPressure=True;
active Argo control-plane replacements are Pending. Terminal historical Pods
are not recovery evidence. No further cleanup, runner pause, infrastructure
provisioning, production approval or GitOps sync was executed this turn.
Separate Shanghai/Singapore runtime identity and human-reviewed regional
capacity inputs remain unresolved. Production hidden release is not achieved.

## 2026-10-10 authorized Argo-only restart and postcheck

User explicitly authorized restarting Argo. Issued standard kubectl rollout
restart for six argocd-* Deployments and argocd-application-controller StatefulSet
in namespace argocd; command exit 0, all seven acknowledged. Did not restart
k0s/host/shared CI or the tkex-csig-api-server Deployment. Acknowledgement does
not mean replacement Pods became Ready. Fresh scheduler messages show the
node.kubernetes.io/disk-pressure NoSchedule taint blocking replacements.

Bounded watch 08:33:11Z through 08:38:32Z: DiskPressure=True and zero of seven
Argo workloads Ready on all eleven observations. Fresh /data free
151747805184 bytes, below the 158502316800-byte threshold. Six production
website-related Applications remain sync Unknown / ComparisonError; stored
health Healthy is not fresh deployment/reconciliation proof. No force taint,
eviction-threshold change, production sync or backend enablement performed.

In parallel, !5168 MR CI succeeded (build b-fd9238e9052645189b604e4cc43c4628),
mingyuxiao approval confirmed; standard merge succeeded at
57f22da784f0a9d16efe1c4f1983bd24c6c7eab2, fetched ancestry verified.
New frontend producer build b-a54ff1a2603d418fa8f3968ded6f6693
(p-d7b21a8b85b2495683c8afd1d806f763) was observed RUNNING at this merge.
Tokyo build b-631edd372837458e9b939a48c2ffe5bc also RUNNING. These are new
artifact validation, not production release. Goal remains incomplete.

## 2026-10-10 frontend image dependency closure and authorized CI drain

Frontend producer b-a54ff1a2603d418fa8f3968ded6f6693 now reports STAGE_SUCCESS:
construction stage SUCCEED; formal-site candidate confirmation PAUSE. No
production candidate approval executed. Tokyo image build b-631edd... is FAILED
at pnpm install: missing /shared/vela-collaboration-web. Root cause confirmed
against the Dockerfile and its context allowlist: five direct/transitive file:
packages were omitted (collaboration, chat core, mobile account/bot SDKs and
workbench panels). Added an automatically recursive dependency-closure test;
old Docker contract fails on five packages, repaired contract passes all 25
build-image tests. Dockerfile adds only those packages; context allows only
those package trees, excludes host node_modules/local credential patterns.
Actual container rebuild is not yet verified (local Docker daemon unavailable;
shared runner is being paused, not used for another build).

User explicitly authorized temporary suspension of shared runner new intake.
Confirmed project git_1731878 / agent prowgrgm / node mbkkaqrp on the Argo host.
Verified official BK-CI implementation: zero parallelism means unlimited,
not pause. Original normal/docker concurrency 4/4 recorded; changed both to
1/1 while the single existing frontend task drained, not canceled. After the
producer reached its approval wait, node RUNNING task count became zero;
no worker Java process remained. Under a guarded child-process absence check,
stopped only devops_agent_prowgrgm.service and its two dispatcher processes.
Service inactive, daemon PID 1307 and agent PID 1338 absent; no task/group kill,
no shared pnpm/npm store cleanup and no build cancellation. Original 4/4 must
be restored when explicitly resuming service after stable disk recovery.
