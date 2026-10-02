#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mesh_dir=$(CDPATH= cd -- "$script_dir/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "$mesh_dir/lib.sh"
# shellcheck source=versions.env
source "$script_dir/versions.env"

wait_value() {
	local kubeconfig=$1 expected=$2 deadline=$((SECONDS + 180)) value
	while ((SECONDS < deadline)); do
		value=$(kubectl_for "$kubeconfig" -n actor-fdb-cell-system get configmap actor-gitops-state \
			-o jsonpath='{.data.ownership}' 2>/dev/null || true)
		[[ $value == "$expected" ]] && return 0
		sleep 2
	done
	return 1
}

assert_spoke_rbac() {
	local kubeconfig=$1 identity=system:serviceaccount:actor-fdb-cell-system:actor-argocd-static
	[[ $(kubectl_for "$kubeconfig" auth can-i create configmaps -n actor-fdb-cell-system --as="$identity") == yes ]] || \
		die "Argo identity cannot manage its allowed ConfigMap"
	[[ $(kubectl_for "$kubeconfig" auth can-i get secrets -n actor-fdb-cell-system --as="$identity") == no ]] || \
		die "Argo identity can read Cell Secrets"
	[[ $(kubectl_for "$kubeconfig" auth can-i patch statefulsets.apps -n actor-fdb-cell-system --as="$identity") == no ]] || \
		die "Argo identity can mutate runtime StatefulSets"
	[[ $(kubectl_for "$kubeconfig" auth can-i list rivetcells.fleet.actor.dev -n actor-fdb-cell-system --as="$identity") == yes ]] || \
		die "Argo identity cannot discover globally included RivetCells"
	[[ $(kubectl_for "$kubeconfig" auth can-i patch rivetcells.fleet.actor.dev -n actor-fdb-cell-system --as="$identity") == no ]] || \
		die "static Argo identity can mutate RivetCells"
	if kubectl_for "$kubeconfig" get crd machinesets.node.tke.cloud.tencent.com >/dev/null 2>&1; then
		[[ $(kubectl_for "$kubeconfig" auth can-i list machinesets.node.tke.cloud.tencent.com --as="$identity") == yes ]] || \
			die "Argo identity cannot discover globally included MachineSets"
		[[ $(kubectl_for "$kubeconfig" auth can-i patch machinesets.node.tke.cloud.tencent.com --as="$identity") == no ]] || \
			die "static Argo identity can mutate MachineSets"
	fi
	[[ $(kubectl_for "$kubeconfig" auth can-i delete configmaps -n actor-fdb-cell-system --as="$identity") == no ]] || \
		die "Argo identity can prune ConfigMaps"
}

assert_spoke_rbac "$RUNTIME_A_KUBECONFIG"
assert_spoke_rbac "$RUNTIME_B_KUBECONFIG"

management=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get applicationset actor-cells -o json)
jq -e '
	.metadata.name == "actor-cells" and
	.spec.generators[0].clusters.selector.matchLabels == {
		"fleet.actor.dev/desired-state":"published",
		"fleet.actor.dev/managed-cell":"true",
		"fleet.actor.dev/registration-scope":"production"
	} and
	.spec.syncPolicy.preserveResourcesOnDeletion == true and
	.spec.template.spec.syncPolicy.automated.prune == false
' <<<"$management" >/dev/null || die "generic Cell ApplicationSet policy drifted"
managed_secrets=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get secret \
	-l 'argocd.argoproj.io/secret-type=cluster,fleet.actor.dev/managed-cell=true,fleet.actor.dev/desired-state=published,fleet.actor.dev/registration-scope=production' \
	-o json)
[[ $(jq '.items | length' <<<"$managed_secrets") == 0 ]] || \
	die "local static targets were accidentally enrolled as managed Cells"
management_uid=$(jq -er '.metadata.uid' <<<"$management")

runtime_a_before=$(kubectl_for "$RUNTIME_A_KUBECONFIG" -n actor-fdb-cell-system get statefulset local-runtime-a-runtime-hosts \
	-o jsonpath='{.metadata.uid}:{.spec.replicas}' 2>/dev/null || true)
runtime_b_before=$(kubectl_for "$RUNTIME_B_KUBECONFIG" -n actor-fdb-cell-system get statefulset local-runtime-b-runtime-hosts \
	-o jsonpath='{.metadata.uid}:{.spec.replicas}' 2>/dev/null || true)

kubectl_for "$RUNTIME_A_KUBECONFIG" -n actor-fdb-cell-system patch configmap actor-gitops-state \
	--type=merge -p '{"data":{"ownership":"drift-injected-a"}}' >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd annotate application actor-runtime-a-static \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null
wait_value "$RUNTIME_A_KUBECONFIG" static-only || die "Argo CD did not self-heal runtime-a drift"

controller_name=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get pod \
	-l app.kubernetes.io/name=argocd-application-controller -o jsonpath='{.items[0].metadata.name}')
controller_uid_before=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get pod "$controller_name" -o jsonpath='{.metadata.uid}')
kubectl_for "$HUB_KUBECONFIG" -n argocd delete pod "$controller_name" --wait=true >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout status statefulset/argocd-application-controller --timeout=5m
controller_uid_after=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get pod "$controller_name" -o jsonpath='{.metadata.uid}')
[[ $controller_uid_after != "$controller_uid_before" ]] || die "Argo application controller Pod was not replaced"

kubectl_for "$RUNTIME_B_KUBECONFIG" -n actor-fdb-cell-system patch configmap actor-gitops-state \
	--type=merge -p '{"data":{"ownership":"drift-injected-b"}}' >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd annotate application actor-runtime-b-static \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null
wait_value "$RUNTIME_B_KUBECONFIG" static-only || die "Argo CD did not self-heal runtime-b after controller replacement"

runtime_a_after=$(kubectl_for "$RUNTIME_A_KUBECONFIG" -n actor-fdb-cell-system get statefulset local-runtime-a-runtime-hosts \
	-o jsonpath='{.metadata.uid}:{.spec.replicas}' 2>/dev/null || true)
runtime_b_after=$(kubectl_for "$RUNTIME_B_KUBECONFIG" -n actor-fdb-cell-system get statefulset local-runtime-b-runtime-hosts \
	-o jsonpath='{.metadata.uid}:{.spec.replicas}' 2>/dev/null || true)
[[ $runtime_a_after == "$runtime_a_before" && $runtime_b_after == "$runtime_b_before" ]] || \
	die "Argo CD changed controller-owned runtime identity or replicas"

apps=$(kubectl_for "$HUB_KUBECONFIG" -n argocd get applications -o json)
jq -e '(.items | length) == 2 and all(.items[]; .status.sync.status == "Synced" and .status.health.status == "Healthy")' \
	<<<"$apps" >/dev/null

receipt_dir=${RECEIPT_DIR:-/data/actor-qualification/receipts}
install -d -m 0750 "$receipt_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
receipt=$receipt_dir/local-argocd-desired-state-$timestamp.json
jq -n --arg version "$ARGOCD_VERSION" --arg before "$controller_uid_before" --arg after "$controller_uid_after" \
	--arg runtimeA "$runtime_a_after" --arg runtimeB "$runtime_b_after" --arg managementUID "$management_uid" '{
		schemaVersion:"actor-argocd-desired-state-qualification/v1",verdict:"passed",argocdVersion:$version,
		applications:["actor-runtime-a-static","actor-runtime-b-static"],
		genericCellManagement:{applicationSet:"actor-cells",uid:$managementUID,selectedCells:0},
		driftSelfHeal:{runtimeA:true,runtimeBAfterControllerReplacement:true},
		controllerReplacement:{beforeUID:$before,afterUID:$after},
		dynamicOwnershipPreserved:{runtimeA:$runtimeA,runtimeB:$runtimeB},
		rbac:{configMapWrite:true,inventoryDiscovery:true,rivetCellPatch:false,machineSetPatch:false,secretRead:false,statefulSetPatch:false,configMapDelete:false},prune:false
	}' >"$receipt"
echo "argocd_desired_state_qualification=passed receipt=$receipt sha256=$(sha256sum "$receipt" | cut -d' ' -f1)"
