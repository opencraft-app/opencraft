#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG must name management cluster C kubeconfig}"
: "${CELL_KUBECONFIG:?CELL_KUBECONFIG must name the one-time Terraform Cell kubeconfig}"
: "${CELL_INVENTORY:?CELL_INVENTORY must name cell_inventory JSON}"
: "${CELL_HANDOFF_RECEIPT:?CELL_HANDOFF_RECEIPT must name handoff-receipt.json}"
: "${CELL_PUBLICATION_RECEIPT:?CELL_PUBLICATION_RECEIPT must name the immutable Git publication receipt}"
: "${CELL_PLATFORM_RECEIPT:?CELL_PLATFORM_RECEIPT must name the immutable Cell platform receipt}"
: "${CELL_DESIRED_ROOT:?CELL_DESIRED_ROOT must name the rendered desired-state root}"
: "${CELL_REGISTRATION_RECEIPT:?CELL_REGISTRATION_RECEIPT must be a new absolute receipt path}"
ACTOR_ARGOCD_REGISTRATION_SCOPE=${ACTOR_ARGOCD_REGISTRATION_SCOPE:-production}
ACTOR_ARGOCD_UPDATE_REGISTRATION=${ACTOR_ARGOCD_UPDATE_REGISTRATION:-false}
[[ $ACTOR_ARGOCD_REGISTRATION_SCOPE =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "ACTOR_ARGOCD_REGISTRATION_SCOPE must be a Kubernetes label value" >&2
	exit 2
}
[[ $ACTOR_ARGOCD_UPDATE_REGISTRATION == false || $ACTOR_ARGOCD_UPDATE_REGISTRATION == true ]] || {
	echo "ACTOR_ARGOCD_UPDATE_REGISTRATION must be true or false" >&2
	exit 2
}

for command in base64 jq kubectl "$python" sed sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
for path in "$HUB_KUBECONFIG" "$CELL_KUBECONFIG" "$CELL_INVENTORY" "$CELL_HANDOFF_RECEIPT" "$CELL_PUBLICATION_RECEIPT" "$CELL_PLATFORM_RECEIPT"; do
	[[ -s $path ]] || { echo "required registration input is missing: $path" >&2; exit 2; }
done
[[ -d $CELL_DESIRED_ROOT ]]
[[ $CELL_REGISTRATION_RECEIPT == /* && ! -e $CELL_REGISTRATION_RECEIPT ]] || {
	echo "CELL_REGISTRATION_RECEIPT must be a new absolute path" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-cell-registration.XXXXXX)
receipt_stage=
cleanup() {
	[[ -z ${receipt_stage:-} ]] || rm -f -- "$receipt_stage"
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

"$python" "$script_dir/verify-publication.py" \
	--inventory "$CELL_INVENTORY" \
	--handoff-receipt "$CELL_HANDOFF_RECEIPT" \
	--publication-receipt "$CELL_PUBLICATION_RECEIPT" \
	--desired-root "$CELL_DESIRED_ROOT" >"$temporary/publication.json"
cell_id=$(jq -er '.cellId' "$temporary/publication.json")
cluster_id=$(jq -er '.clusterId' "$temporary/publication.json")
expected_server=$(jq -er '.privateEndpoint' "$temporary/publication.json")
inventory_digest=$(jq -er '.terraformInventoryDigest' "$temporary/publication.json")
handoff_digest=$(jq -er '.handoffReceiptDigest' "$temporary/publication.json")
publication_digest=$(jq -er '.publicationReceiptDigest' "$temporary/publication.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/publication.json")
profile_digest=$(jq -er '.profileDigest' "$temporary/publication.json")
repository_url=$(jq -er '.repository.url' "$temporary/publication.json")
repository_branch=$(jq -er '.repository.branch' "$temporary/publication.json")
repository_path=$(jq -er '.repository.path' "$temporary/publication.json")
git_revision=$(jq -er '.gitRevision' "$temporary/publication.json")
[[ $cell_id =~ ^actor-[a-z]{2}-[a-z][0-9]{2}$ && $cluster_id =~ ^cls-[a-z0-9]+$ ]]

platform_test_fixture=${ACTOR_CELL_PLATFORM_TEST_FIXTURE:-false}
case "$platform_test_fixture:$ACTOR_ARGOCD_REGISTRATION_SCOPE" in
	false:*) platform_fixture_args=() ;;
	true:registration-e2e|true:applicationset-e2e) platform_fixture_args=(--allow-test-fixture) ;;
	*) echo "test-only Cell platform evidence is forbidden for this registration scope" >&2; exit 2 ;;
esac
"$python" "$script_dir/verify-platform.py" \
	--platform-receipt "$CELL_PLATFORM_RECEIPT" \
	--publication-verification "$temporary/publication.json" \
	--receipt-only "${platform_fixture_args[@]}" >"$temporary/platform-plan.json"
platform_digest=$(jq -er '.platformReceiptDigest' "$temporary/platform-plan.json")
platform_cluster_uid=$(jq -er '.clusterUid' "$temporary/platform-plan.json")
platform_profile=$(jq -er '.profile.name' "$temporary/platform-plan.json")
platform_class=$(jq -er '.profile.className' "$temporary/platform-plan.json")

if [[ $platform_test_fixture == false ]]; then
	kubectl --kubeconfig "$CELL_KUBECONFIG" get namespace kube-system -o json >"$temporary/kube-system.json"
	kubectl --kubeconfig "$CELL_KUBECONFIG" -n actor-fdb-cell-system get deployment \
		fdb-kubernetes-operator-controller-manager -o json >"$temporary/fdb-operator.json"
	kubectl --kubeconfig "$CELL_KUBECONFIG" -n fdb-operator-actor-fleet-controller-system get deployment \
		fdb-operator-actor-fleet-controller -o json >"$temporary/cell-controller.json"
	kubectl --kubeconfig "$CELL_KUBECONFIG" get rivetcellprofile "$platform_profile" -o json >"$temporary/profile.json"
	kubectl --kubeconfig "$CELL_KUBECONFIG" get shardclass "$platform_class" -o json >"$temporary/shard-class.json"
	"$python" "$script_dir/verify-platform.py" \
		--platform-receipt "$CELL_PLATFORM_RECEIPT" \
		--publication-verification "$temporary/publication.json" \
		--kube-system "$temporary/kube-system.json" \
		--fdb-operator "$temporary/fdb-operator.json" \
		--cell-controller "$temporary/cell-controller.json" \
		--profile "$temporary/profile.json" \
		--shard-class "$temporary/shard-class.json" >"$temporary/platform.json"
else
	"$python" "$script_dir/verify-platform.py" \
		--platform-receipt "$CELL_PLATFORM_RECEIPT" \
		--publication-verification "$temporary/publication.json" \
		--allow-test-fixture >"$temporary/platform.json"
fi

kubectl config view --raw --kubeconfig "$CELL_KUBECONFIG" -o json >"$temporary/kubeconfig.json"
current_context=$(jq -er '."current-context"' "$temporary/kubeconfig.json")
cluster_name=$(jq -er --arg context "$current_context" '.contexts[] | select(.name == $context) | .context.cluster' "$temporary/kubeconfig.json")
server=$(jq -er --arg cluster "$cluster_name" '.clusters[] | select(.name == $cluster) | .cluster.server' "$temporary/kubeconfig.json")
ca_data=$(jq -er --arg cluster "$cluster_name" '.clusters[] | select(.name == $cluster) | .cluster."certificate-authority-data"' "$temporary/kubeconfig.json")
tls_server_name=$(jq -r --arg cluster "$cluster_name" \
	'.clusters[] | select(.name == $cluster) | .cluster."tls-server-name" // empty' "$temporary/kubeconfig.json")
[[ $server == "$expected_server" ]] || {
	echo "Cell kubeconfig endpoint does not match Terraform inventory" >&2
	exit 1
}
printf '%s' "$ca_data" | base64 --decode >"$temporary/ca.crt"
ca_digest=$(sha256sum "$temporary/ca.crt" | cut -d' ' -f1)

kubectl --kubeconfig "$CELL_KUBECONFIG" create namespace actor-fdb-cell-system \
	--dry-run=client -o yaml | kubectl --kubeconfig "$CELL_KUBECONFIG" apply -f - >/dev/null
kubectl --kubeconfig "$CELL_KUBECONFIG" create namespace actor-stateless-system \
	--dry-run=client -o yaml | kubectl --kubeconfig "$CELL_KUBECONFIG" apply -f - >/dev/null
sed "s/__CELL_ID__/$cell_id/g" "$script_dir/spoke-rbac.yaml" >"$temporary/spoke-rbac.yaml"
kubectl --kubeconfig "$CELL_KUBECONFIG" apply -f "$temporary/spoke-rbac.yaml" >/dev/null

token=
for _ in $(seq 1 60); do
	token=$(kubectl --kubeconfig "$CELL_KUBECONFIG" -n actor-fdb-cell-system \
		get secret actor-argocd-cell-token -o jsonpath='{.data.token}' 2>/dev/null | base64 --decode || true)
	[[ -n $token ]] && break
	sleep 1
done
[[ -n $token ]] || { echo "Argo Cell service-account token was not issued" >&2; exit 1; }
printf '%s' "$token" >"$temporary/token"
printf '%s' "$ca_data" >"$temporary/ca-data"

auth=(--kubeconfig "$CELL_KUBECONFIG" --as system:serviceaccount:actor-fdb-cell-system:actor-argocd-cell)
[[ $(kubectl "${auth[@]}" auth can-i patch machinesets.node.tke.cloud.tencent.com) == yes ]]
[[ $(kubectl "${auth[@]}" -n actor-fdb-cell-system auth can-i patch rivetcells.fleet.actor.dev) == yes ]]
[[ $(kubectl "${auth[@]}" auth can-i delete machinesets.node.tke.cloud.tencent.com) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-fdb-cell-system auth can-i delete rivetcells.fleet.actor.dev) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-fdb-cell-system auth can-i get secrets) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-fdb-cell-system auth can-i create deployments.apps) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i patch deployments.apps) == yes ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i list rivetcells.fleet.actor.dev) == yes ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i patch rivetcells.fleet.actor.dev) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i patch services) == yes ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i get secrets) == no ]]
[[ $(kubectl "${auth[@]}" -n actor-stateless-system auth can-i delete deployments.apps) == no ]]

secret_name=actor-cell-$cell_id
apply_args=(--server-side --field-manager=actor-cell-registration)
if kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get secret "$secret_name" -o json >"$temporary/existing.json" 2>/dev/null; then
	existing_cell=$(jq -er '.metadata.labels["fleet.actor.dev/cell-id"]' "$temporary/existing.json")
	existing_scope=$(jq -r '.metadata.labels["fleet.actor.dev/registration-scope"] // empty' "$temporary/existing.json")
	existing_cluster=$(jq -er '.metadata.annotations["fleet.actor.dev/cluster-id"]' "$temporary/existing.json")
	existing_server=$(jq -er '.data.server | @base64d' "$temporary/existing.json")
	if [[ $existing_cell != "$cell_id" || $existing_scope != "$ACTOR_ARGOCD_REGISTRATION_SCOPE" || $existing_server != "$server" || $existing_cluster != "$cluster_id" ]]; then
		[[ ${ACTOR_ARGOCD_REPLACE_CLUSTER:-false} == true ]] || {
			echo "existing Argo target has a different Cell, scope, cluster, or endpoint; explicit replacement is required" >&2
			exit 1
		}
	fi
	existing_revision=$(jq -er '.metadata.annotations["fleet.actor.dev/git-revision"]' "$temporary/existing.json")
	if [[ $ACTOR_ARGOCD_UPDATE_REGISTRATION == true ]]; then
		expected_revision=${ACTOR_ARGOCD_EXPECTED_REVISION:-}
		[[ $expected_revision =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ && $existing_revision == "$expected_revision" ]] || {
			echo "existing Argo registration revision differs from the reviewed update CAS" >&2
			exit 1
		}
		apply_args+=(--force-conflicts)
	elif [[ $existing_revision != "$git_revision" ]]; then
		echo "Argo registration update requires ACTOR_ARGOCD_UPDATE_REGISTRATION=true and ACTOR_ARGOCD_EXPECTED_REVISION" >&2
		exit 1
	fi
elif [[ $ACTOR_ARGOCD_UPDATE_REGISTRATION == true ]]; then
	echo "reviewed Argo registration update target does not exist" >&2
	exit 1
fi

config=$(jq -cn --rawfile token "$temporary/token" --rawfile ca "$temporary/ca-data" \
	--arg server_name "$tls_server_name" \
	'{bearerToken:$token,tlsClientConfig:({insecure:false,caData:$ca} +
		(if $server_name == "" then {} else {serverName:$server_name} end))}')
printf '%s' "$config" >"$temporary/argo-config"
jq -cn \
	--arg name "$secret_name" --arg cell "$cell_id" --arg cluster "$cluster_id" \
	--arg server "$server" --rawfile config "$temporary/argo-config" --arg revision "$git_revision" \
	--arg inventory "$inventory_digest" --arg handoff "$handoff_digest" \
	--arg publication "$publication_digest" \
	--arg images "$image_inventory_digest" --arg platform "$platform_digest" \
	--arg profile "$profile_digest" \
	--arg cluster_uid "$platform_cluster_uid" --arg scope "$ACTOR_ARGOCD_REGISTRATION_SCOPE" '{
	apiVersion:"v1",kind:"Secret",type:"Opaque",
	metadata:{name:$name,namespace:"argocd",labels:{
		"argocd.argoproj.io/secret-type":"cluster",
		"fleet.actor.dev/managed-cell":"true",
		"fleet.actor.dev/desired-state":"published",
		"fleet.actor.dev/registration-scope":$scope,
		"fleet.actor.dev/cell-id":$cell
	},annotations:{
		"fleet.actor.dev/cluster-id":$cluster,
		"fleet.actor.dev/git-revision":$revision,
		"fleet.actor.dev/inventory-digest":$inventory,
		"fleet.actor.dev/handoff-receipt-digest":$handoff,
		"fleet.actor.dev/publication-receipt-digest":$publication,
		"fleet.actor.dev/image-inventory-digest":$images,
		"fleet.actor.dev/profile-digest":$profile,
		"fleet.actor.dev/platform-receipt-digest":$platform,
		"fleet.actor.dev/cluster-uid":$cluster_uid
	}},stringData:{name:$cell,server:$server,namespaces:"actor-fdb-cell-system,actor-stateless-system",clusterResources:"true",config:$config}
}' >"$temporary/cluster-secret.json"
kubectl --kubeconfig "$HUB_KUBECONFIG" apply "${apply_args[@]}" \
	-f "$temporary/cluster-secret.json" >/dev/null
kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get secret "$secret_name" -o json >"$temporary/created.json"
secret_uid=$(jq -er '.metadata.uid' "$temporary/created.json")
secret_rv=$(jq -er '.metadata.resourceVersion' "$temporary/created.json")

mkdir -p "$(dirname -- "$CELL_REGISTRATION_RECEIPT")"
jq -n \
	--arg cell "$cell_id" --arg cluster "$cluster_id" --arg server "$server" \
	--arg inventory "$inventory_digest" --arg handoff "$handoff_digest" \
	--arg publication "$publication_digest" \
	--arg images "$image_inventory_digest" --arg platform "$platform_digest" \
	--arg platform_cluster_uid "$platform_cluster_uid" \
	--arg repository_url "$repository_url" --arg repository_branch "$repository_branch" --arg repository_path "$repository_path" \
	--arg revision "$git_revision" --arg ca "sha256:$ca_digest" --arg scope "$ACTOR_ARGOCD_REGISTRATION_SCOPE" \
	--arg secret "$secret_name" --arg uid "$secret_uid" --arg rv "$secret_rv" '{
	schemaVersion:3,cellId:$cell,clusterId:$cluster,server:$server,
	terraformInventoryDigest:$inventory,handoffReceiptDigest:$handoff,publicationReceiptDigest:$publication,imageInventoryDigest:$images,gitRevision:$revision,
	platformReceiptDigest:$platform,platformClusterUid:$platform_cluster_uid,
	publicationRepository:{url:$repository_url,branch:$repository_branch,path:$repository_path},registrationScope:$scope,
	caDigest:$ca,argoClusterSecret:{name:$secret,uid:$uid,resourceVersion:$rv},
	permissions:{machineSetDelete:false,rivetCellDelete:false,secretRead:false,
	             fdbWorkloadCreate:false,statelessSecretRead:false,statelessWorkloadDelete:false}
}' >"$temporary/registration-receipt.json"
receipt_stage=$(mktemp "$(dirname -- "$CELL_REGISTRATION_RECEIPT")/.cell-registration-receipt.XXXXXX")
install -m 0644 "$temporary/registration-receipt.json" "$receipt_stage"
ln "$receipt_stage" "$CELL_REGISTRATION_RECEIPT"
rm -f -- "$receipt_stage"
receipt_stage=
printf 'cell_registration=passed cell=%s cluster=%s receipt=%s\n' \
	"$cell_id" "$cluster_id" "$CELL_REGISTRATION_RECEIPT"
