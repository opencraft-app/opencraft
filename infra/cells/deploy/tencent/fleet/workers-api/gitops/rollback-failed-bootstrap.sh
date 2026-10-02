#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 3 ]] || {
	echo "Usage: rollback-failed-bootstrap.sh FAILED_PUBLICATION_RECEIPT PRIOR_CONVERGENCE_RECEIPT ROLLBACK_RECEIPT" >&2
	exit 2
}
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG must name management cluster C kubeconfig}"
failed_publication=$1
prior_convergence=$2
receipt=$3
python=${PYTHON:-python3.11}
for path in "$HUB_KUBECONFIG" "$failed_publication" "$prior_convergence"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "rollback input must be an absolute regular file: $path" >&2; exit 2; }
done
[[ $receipt == /* && ! -e $receipt && -d $(dirname -- "$receipt") ]] || {
	echo "rollback receipt must be a new absolute path with an existing parent" >&2
	exit 2
}
for command in kubectl jq sha256sum "$python"; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

failed_revision=$(jq -er '
  select(.schema == "actor-management-workers-api-desired-publication/v1" and .verdict == "passed") |
  .gitRevision | select(test("^[0-9a-f]{40}([0-9a-f]{24})?$"))
' "$failed_publication")
prior_revision=$(jq -er '
  select(.schema == "actor-management-workers-api-argocd-convergence/v1" and .verdict == "passed") |
  .gitRevision | select(test("^[0-9a-f]{40}([0-9a-f]{24})?$"))
' "$prior_convergence")
[[ $failed_revision != "$prior_revision" ]] || { echo "failed and prior revisions must differ" >&2; exit 2; }
deployment_uid=$(jq -er '.adoptedResources.deploymentUid' "$prior_convergence")
service_uid=$(jq -er '.adoptedResources.privateServiceUid' "$prior_convergence")

temporary=$(mktemp -d /data/tmp/workers-api-bootstrap-rollback.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
kube=(kubectl --kubeconfig "$HUB_KUBECONFIG")

"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application-before.json"
"${kube[@]}" -n workers-api-system get deployment workers-api -o json >"$temporary/deployment-before.json"
"${kube[@]}" -n workers-api-system get service workers-api-private -o json >"$temporary/service-before.json"
"${kube[@]}" -n workers-api-system get pods -l app.kubernetes.io/name=workers-api -o json >"$temporary/pods-before.json"
"${kube[@]}" -n workers-api-system get hpa workers-api -o json >"$temporary/hpa-before.json"
"${kube[@]}" get nodes -o json >"$temporary/nodes-before.json"
jq -e --arg failed "$failed_revision" '
  .spec.source.targetRevision == $failed and .status.sync.revision == $failed and
  .status.sync.status == "Synced" and .status.health.status == "Degraded"
' "$temporary/application-before.json" >/dev/null || {
	echo "Workers API Application is not at the exact failed revision" >&2; exit 1;
}
[[ $(jq -er '.metadata.uid' "$temporary/deployment-before.json") == "$deployment_uid" ]] || {
	echo "failed rollout replaced the admitted Deployment" >&2; exit 1;
}
[[ $(jq -er '.metadata.uid' "$temporary/service-before.json") == "$service_uid" ]] || {
	echo "failed rollout replaced the admitted private Service" >&2; exit 1;
}
failure_class=
if jq -e '
  ([.items[] | select(
    .status.phase == "Running" and
    ((.status.containerStatuses // []) | length > 0) and
    all(.status.containerStatuses[]; .ready == true)
  )] | length) >= 1 and
  ([.items[] | .status.containerStatuses[]? | .state.waiting? |
    select(.reason == "CreateContainerConfigError") |
    select((.message // "") | test("couldn.t find key .* in Secret workers-api-system/workers-api-internal-token"))
  ] | length) >= 1
' "$temporary/pods-before.json" >/dev/null; then
	failure_class=immutable-secret-same-name-cache-aba
elif jq -e '
  .status.conditions[]? |
  select(.type == "ScalingActive" and .status == "False") |
  select(((.reason // "") + " " + (.message // "")) |
    test("workers_api_routing_requests_per_second"))
' "$temporary/hpa-before.json" >/dev/null && "$python" - \
	"$temporary/deployment-before.json" "$temporary/pods-before.json" "$temporary/nodes-before.json" <<'PY'
import json,sys
deployment,pods,nodes=(json.load(open(path)) for path in sys.argv[1:])
replicas=deployment.get("spec",{}).get("replicas")
ready=[item for item in pods.get("items",[]) if not item.get("metadata",{}).get("deletionTimestamp") and item.get("status",{}).get("phase")=="Running" and item.get("status",{}).get("containerStatuses") and all(
    value.get("ready") for value in item["status"]["containerStatuses"])]
node_zones={
    item.get("metadata",{}).get("name"):item.get("metadata",{}).get("labels",{}).get("topology.kubernetes.io/zone")
    for item in nodes.get("items",[])
    if any(value.get("type")=="Ready" and value.get("status")=="True" for value in item.get("status",{}).get("conditions",[]))
}
ready_nodes={item.get("spec",{}).get("nodeName") for item in ready}
ready_zones={node_zones.get(name) for name in ready_nodes}
if not isinstance(replicas,int) or replicas<3 or len(ready)!=replicas:
    raise SystemExit("failed rollout does not have a fully Ready routing plane")
if len(ready_nodes) >= 3 and None not in ready_zones and len(ready_zones) >= 3:
    raise SystemExit("failed rollout already satisfies the reviewed topology floor")
PY
then
	failure_class=workers-routing-metrics-and-topology-incomplete
else
	echo "failed rollout does not match a reviewed bootstrap failure class" >&2
	exit 1
fi

patch=$(jq -cn --arg revision "$prior_revision" '{spec:{source:{targetRevision:$revision}}}')
"${kube[@]}" -n argocd patch application actor-management-workers-api --type=merge -p "$patch" >/dev/null
"${kube[@]}" -n argocd annotate application actor-management-workers-api \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	"${kube[@]}" -n argocd get application actor-management-workers-api -o json >"$temporary/application-after.json"
	"${kube[@]}" -n workers-api-system get deployment workers-api -o json >"$temporary/deployment-after.json"
	if jq -e --arg revision "$prior_revision" '
	  .spec.source.targetRevision == $revision and .status.sync.revision == $revision and
	  .status.sync.status == "Synced" and .status.health.status == "Healthy" and
	  ((.status.conditions // []) | length == 0) and
	  (.status.resources | length > 0) and all(.status.resources[]; .status == "Synced")
	' "$temporary/application-after.json" >/dev/null && jq -e '
	  .spec.replicas >= 3 and .status.readyReplicas == .spec.replicas and
	  .status.updatedReplicas == .spec.replicas and .status.availableReplicas == .spec.replicas
	' "$temporary/deployment-after.json" >/dev/null; then
		break
	fi
	sleep 5
done
jq -e --arg revision "$prior_revision" '
  .spec.source.targetRevision == $revision and .status.sync.revision == $revision and
  .status.sync.status == "Synced" and .status.health.status == "Healthy" and
  ((.status.conditions // []) | length == 0) and
  (.status.resources | length > 0) and all(.status.resources[]; .status == "Synced")
' "$temporary/application-after.json" >/dev/null || { echo "Workers API rollback did not converge" >&2; exit 1; }
jq -e --arg uid "$deployment_uid" '
  .metadata.uid == $uid and .spec.replicas >= 3 and .status.readyReplicas == .spec.replicas and
  .status.updatedReplicas == .spec.replicas and .status.availableReplicas == .spec.replicas
' "$temporary/deployment-after.json" >/dev/null || { echo "Workers API rollback did not restore the admitted Deployment" >&2; exit 1; }
"${kube[@]}" -n workers-api-system get service workers-api-private -o json >"$temporary/service-after.json"
[[ $(jq -er '.metadata.uid' "$temporary/service-after.json") == "$service_uid" ]] || {
	echo "Workers API rollback replaced the private Service" >&2; exit 1;
}

jq -cn \
	--arg failed_revision "$failed_revision" --arg prior_revision "$prior_revision" \
	--arg failed_publication "sha256:$(sha256sum "$failed_publication" | cut -d' ' -f1)" \
	--arg prior_convergence "sha256:$(sha256sum "$prior_convergence" | cut -d' ' -f1)" \
	--arg application_uid "$(jq -er '.metadata.uid' "$temporary/application-after.json")" \
	--arg deployment_uid "$deployment_uid" --arg service_uid "$service_uid" \
	--arg failure_class "$failure_class" \
	'{schema:"actor-management-workers-api-bootstrap-rollback/v1",verdict:"passed",
	  failedRevision:$failed_revision,restoredRevision:$prior_revision,
	  sourceReceipts:{failedPublication:$failed_publication,priorConvergence:$prior_convergence},
	  identities:{applicationUid:$application_uid,deploymentUid:$deployment_uid,privateServiceUid:$service_uid},
	  failureClass:$failure_class,
	  gates:{exactFailedRevision:true,reviewedFailure:true,priorHealthy:true,identityPreserved:true}}' >"$temporary/receipt.json"
ln "$temporary/receipt.json" "$receipt"
chmod 0644 "$receipt"
printf 'workers_api_bootstrap_rollback=passed restored_revision=%s receipt=%s\n' "$prior_revision" "$receipt"
