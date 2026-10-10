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
