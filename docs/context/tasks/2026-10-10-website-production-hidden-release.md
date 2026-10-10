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
