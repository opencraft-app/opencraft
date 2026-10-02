#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mesh_dir=$(CDPATH= cd -- "$script_dir/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "$mesh_dir/lib.sh"
# shellcheck source=versions.env
source "$script_dir/versions.env"

for command in curl docker git jq k3d kubectl sha256sum; do require_command "$command"; done
[[ -s $HUB_KUBECONFIG && -s $RUNTIME_A_KUBECONFIG && -s $RUNTIME_B_KUBECONFIG ]] || \
	die "run local mesh up.sh before installing Argo CD"

cache_dir=${ARGOCD_CACHE_DIR:-/data/build-cache/argocd/${ARGOCD_VERSION}}
manifest=$cache_dir/install.yaml
install -d -m 0755 "$cache_dir"
if [[ ! -s $manifest ]] || ! echo "$ARGOCD_INSTALL_SHA256  $manifest" | sha256sum -c - >/dev/null 2>&1; then
	temporary=$(mktemp "$cache_dir/install.yaml.XXXXXX")
	trap 'rm -f -- "${temporary:-}"' EXIT INT TERM
	curl -fsSL "$ARGOCD_MANIFEST_BASE/$ARGOCD_VERSION/manifests/install.yaml" -o "$temporary"
	echo "$ARGOCD_INSTALL_SHA256  $temporary" | sha256sum -c - >/dev/null
	mv -Tf "$temporary" "$manifest"
	trap - EXIT INT TERM
fi

kubectl_for "$HUB_KUBECONFIG" create namespace argocd --dry-run=client -o yaml | \
	kubectl_for "$HUB_KUBECONFIG" apply -f - >/dev/null
mapfile -t upstream_images < <(python3 - "$manifest" <<'PY'
import sys, yaml
images = set()
for document in yaml.safe_load_all(open(sys.argv[1])):
    if not isinstance(document, dict):
        continue
    template = document.get("spec", {}).get("template", {})
    pod = template.get("spec", {})
    for container in pod.get("initContainers", []) + pod.get("containers", []):
        if container.get("image"):
            images.add(container["image"])
for image in sorted(images):
    print(image)
PY
)
for image in "${upstream_images[@]}"; do
	docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
	k3d image import "$image" --cluster "$HUB_CLUSTER" >/dev/null
done
kubectl_for "$HUB_KUBECONFIG" -n argocd apply --server-side --force-conflicts -f "$manifest" >/dev/null
kubectl_for "$HUB_KUBECONFIG" apply --server-side --field-manager=actor-argocd-bootstrap \
	-f "$script_dir/resource-inclusions.yaml" >/dev/null
kubectl_for "$HUB_KUBECONFIG" apply --server-side --force-conflicts --field-manager=actor-argocd-bootstrap \
	-f "$script_dir/controller-parameters.yaml" >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd wait deployment --all --for=condition=Available --timeout=10m
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout status statefulset/argocd-application-controller --timeout=10m

repo_context=$(mktemp -d /data/tmp/actor-argocd-repo.XXXXXX)
cleanup() { rm -rf -- "$repo_context"; }
trap cleanup EXIT INT TERM
cp -a "$script_dir/desired/." "$repo_context/desired/"
git -C "$repo_context/desired" init -q --initial-branch=main
git -C "$repo_context/desired" add runtime-a runtime-b
GIT_AUTHOR_NAME=actor-gitops GIT_AUTHOR_EMAIL=gitops@actor.invalid \
GIT_COMMITTER_NAME=actor-gitops GIT_COMMITTER_EMAIL=gitops@actor.invalid \
	git -C "$repo_context/desired" commit -q --allow-empty -m "actor local desired state"
git clone -q --bare "$repo_context/desired" "$repo_context/repo.git"
cp "$script_dir/repository/Dockerfile" "$repo_context/Dockerfile"
docker build -q -t "$ARGOCD_REPO_IMAGE" "$repo_context" >/dev/null
k3d image import "$ARGOCD_REPO_IMAGE" --cluster "$HUB_CLUSTER" >/dev/null
kubectl_for "$HUB_KUBECONFIG" apply -f "$script_dir/repository/deployment.yaml" >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout restart deployment/actor-gitops-repository >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout status deployment/actor-gitops-repository --timeout=5m

register_cluster() {
	local name=$1 kubeconfig=$2 server=$3 token ca config secret
	kubectl_for "$kubeconfig" apply -f "$script_dir/spoke-rbac.yaml" >/dev/null
	for _ in $(seq 1 60); do
		token=$(kubectl_for "$kubeconfig" -n actor-fdb-cell-system get secret actor-argocd-static-token \
			-o jsonpath='{.data.token}' 2>/dev/null | base64 --decode || true)
		[[ -n $token ]] && break
		sleep 1
	done
	[[ -n ${token:-} ]] || die "service-account token did not become ready for $name"
	ca=$(kubectl config --kubeconfig "$kubeconfig" view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
	[[ -n $ca ]] || die "kubeconfig has no CA data for $name"
	config=$(jq -cn --arg token "$token" --arg ca "$ca" \
		'{bearerToken:$token,tlsClientConfig:{insecure:false,caData:$ca}}')
	secret=$(jq -cn --arg name "$name" --arg server "$server" --arg config "$config" '{
		apiVersion:"v1",kind:"Secret",
		metadata:{name:("actor-"+$name),namespace:"argocd",labels:{"argocd.argoproj.io/secret-type":"cluster"}},
		type:"Opaque",stringData:{name:$name,server:$server,namespaces:"actor-fdb-cell-system",clusterResources:"false",config:$config}
	}')
	printf '%s\n' "$secret" | kubectl_for "$HUB_KUBECONFIG" apply -f - >/dev/null
}

register_cluster runtime-a "${RUNTIME_A_KUBECONFIG}" "https://k3d-${RUNTIME_A_CLUSTER}-serverlb:6443"
register_cluster runtime-b "${RUNTIME_B_KUBECONFIG}" "https://k3d-${RUNTIME_B_CLUSTER}-serverlb:6443"
HUB_KUBECONFIG=$HUB_KUBECONFIG \
ACTOR_DESIRED_REPO_URL=git://actor-gitops-repository.argocd.svc.cluster.local:9418/repo.git \
	"$script_dir/../../tencent/fleet/gitops/cell-registration/install-management.sh"
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout restart statefulset/argocd-application-controller >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd rollout status statefulset/argocd-application-controller --timeout=5m
kubectl_for "$HUB_KUBECONFIG" apply -f "$script_dir/project.yaml" >/dev/null
kubectl_for "$HUB_KUBECONFIG" apply -f "$script_dir/applications.yaml" >/dev/null
kubectl_for "$HUB_KUBECONFIG" -n argocd annotate applications --all \
	argocd.argoproj.io/refresh=hard --overwrite >/dev/null

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	if kubectl_for "$HUB_KUBECONFIG" -n argocd get applications -o json | jq -e '
		(.items | length) == 2 and all(.items[]; .status.sync.status == "Synced" and .status.health.status == "Healthy")
	' >/dev/null; then
		log "Argo CD ${ARGOCD_VERSION} reconciled both runtime Cells from Git"
		exit 0
	fi
	sleep 5
done
kubectl_for "$HUB_KUBECONFIG" -n argocd get applications -o wide >&2 || true
die "Argo CD applications did not converge"
