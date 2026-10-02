#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=mesh-observability
release=actor-mesh-observability
chart=oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack
chart_version=87.21.0
chart_sha256=05eae98df0ff6c21877a26a4400780e4bbff248bc3b88694ef8d08b273ed6815
targets=${ACTOR_FEDERATION_TARGETS:?ACTOR_FEDERATION_TARGETS is required}
python=${PYTHON:-python3}
image_registry=${ACTOR_OBSERVABILITY_IMAGE_REGISTRY:-}
image_namespace=${ACTOR_OBSERVABILITY_IMAGE_NAMESPACE:-actor-fleet}
image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}
chart_archive_input=${ACTOR_OBSERVABILITY_CHART_ARCHIVE:-}
adapter_archive_input=${ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE:-}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in helm jq kubectl openssl sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
command -v "$python" >/dev/null || { echo "PYTHON interpreter is unavailable: $python" >&2; exit 2; }
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
	echo "PYTHON must select Python 3.10 or newer" >&2
	exit 2
}
[[ -f $targets ]] || { echo "federation targets file does not exist: $targets" >&2; exit 2; }
[[ $image_inventory == /* && -f $image_inventory && ! -L $image_inventory ]] || {
	echo "ACTOR_IMAGE_INVENTORY must be an absolute non-symlink regular file" >&2
	exit 2
}
[[ -z $chart_archive_input || ($chart_archive_input == /* && -f $chart_archive_input && ! -L $chart_archive_input) ]] || {
	echo "ACTOR_OBSERVABILITY_CHART_ARCHIVE must be an absolute non-symlink regular file" >&2
	exit 2
}
[[ -z $adapter_archive_input || ($adapter_archive_input == /* && -f $adapter_archive_input && ! -L $adapter_archive_input) ]] || {
	echo "ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE must be an absolute regular non-symlink file" >&2
	exit 2
}
if [[ -n $chart_archive_input && -z $adapter_archive_input ]]; then
	echo "offline Hub observability requires ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE" >&2
	exit 2
fi

resolve_image() {
	local repository=$1 ref expected
	ref=$(jq -er --arg repository "$repository" '
		[.images[] | select(.repository == $repository) | .ref] |
		if length == 1 then .[0] else error("image repository must resolve exactly once") end
	' "$image_inventory")
	[[ $ref =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
		echo "image inventory repository $repository is not digest pinned" >&2
		return 2
	}
	if [[ -n $image_registry ]]; then
		expected="$image_registry/$image_namespace/$repository@sha256:"
		[[ $ref == "$expected"* ]] || {
			echo "image inventory repository $repository is outside the configured registry namespace" >&2
			return 2
		}
	fi
	printf '%s\n' "$ref"
}

image_digest() {
	local ref
	ref=$(resolve_image "$1")
	printf '%s\n' "${ref##*@sha256:}"
}

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
"$python" "$script_dir/render_targets.py" --targets "$targets" --output "$temporary/targets-values.yaml"

chart_archive="$temporary/kube-prometheus-stack-${chart_version}.tgz"
if [[ -n $chart_archive_input ]]; then
	cp -- "$chart_archive_input" "$chart_archive"
else
	helm pull "$chart" --version "$chart_version" --destination "$temporary" >/dev/null
fi
actual_chart_sha=$(sha256sum "$chart_archive" | cut -d' ' -f1)
[[ $actual_chart_sha == "$chart_sha256" ]] || { echo "kube-prometheus-stack archive SHA-256 mismatch" >&2; exit 1; }

kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-storage.yaml"
helm_image_args=()
if [[ -n $image_registry ]]; then
	controller_namespace=${ACTOR_FLEET_CONTROLLER_NAMESPACE:-fdb-operator-actor-fleet-controller-system}
	kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" get secret actor-fleet-tcr -o json | \
		"$python" -c 'import json,sys; d=json.load(sys.stdin); m=d["metadata"]; m["name"]="actor-fleet-tcr"; m["namespace"]=sys.argv[1]; [m.pop(k,None) for k in ("uid","resourceVersion","creationTimestamp","managedFields")]; print(json.dumps(d))' "$namespace" | \
		kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
	helm_image_args=(
		--set-string "global.imagePullSecrets[0].name=actor-fleet-tcr"
		--set-string "crds.upgradeJob.image.sha=$(image_digest observability-busybox)"
		--set-string "crds.upgradeJob.image.busybox.registry=$image_registry"
		--set-string "crds.upgradeJob.image.busybox.repository=$image_namespace/observability-busybox"
		--set-string "crds.upgradeJob.image.busybox.sha=$(image_digest observability-busybox)"
		--set-string "crds.upgradeJob.image.kubectl.registry=$image_registry"
		--set-string "crds.upgradeJob.image.kubectl.repository=$image_namespace/observability-kubectl"
		--set-string "crds.upgradeJob.image.kubectl.sha=$(image_digest observability-kubectl)"
		--set-string "prometheusOperator.admissionWebhooks.patch.image.registry=$image_registry"
		--set-string "prometheusOperator.admissionWebhooks.patch.image.repository=$image_namespace/observability-webhook-certgen"
		--set-string "prometheusOperator.admissionWebhooks.patch.image.sha=$(image_digest observability-webhook-certgen)"
		--set-string "prometheusOperator.image.registry=$image_registry"
		--set-string "prometheusOperator.image.repository=$image_namespace/observability-prometheus-operator"
		--set-string "prometheusOperator.image.sha=$(image_digest observability-prometheus-operator)"
		--set-string "prometheusOperator.prometheusConfigReloader.image.registry=$image_registry"
		--set-string "prometheusOperator.prometheusConfigReloader.image.repository=$image_namespace/observability-prometheus-config-reloader"
		--set-string "prometheusOperator.prometheusConfigReloader.image.sha=$(image_digest observability-prometheus-config-reloader)"
		--set-string "prometheus.prometheusSpec.image.registry=$image_registry"
		--set-string "prometheus.prometheusSpec.image.repository=$image_namespace/observability-prometheus"
		--set-string "prometheus.prometheusSpec.image.sha=$(image_digest observability-prometheus)"
		--set-string "grafana.image.registry=$image_registry"
		--set-string "grafana.image.repository=$image_namespace/observability-grafana"
		--set-string "grafana.image.sha=$(image_digest observability-grafana)"
		--set-string "grafana.initChownData.image.registry=$image_registry"
		--set-string "grafana.initChownData.image.repository=$image_namespace/observability-busybox"
		--set-string "grafana.initChownData.image.sha=$(image_digest observability-busybox)"
		--set-string "grafana.sidecar.image.registry=$image_registry"
		--set-string "grafana.sidecar.image.repository=$image_namespace/observability-k8s-sidecar"
		--set-string "grafana.sidecar.image.sha=$(image_digest observability-k8s-sidecar)"
		--set-string "kube-state-metrics.image.registry=$image_registry"
		--set-string "kube-state-metrics.image.repository=$image_namespace/observability-kube-state-metrics"
		--set-string "kube-state-metrics.image.sha=sha256:$(image_digest observability-kube-state-metrics)"
	)
fi

if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret \
	actor-mesh-observability-grafana-admin >/dev/null 2>&1; then
	printf 'admin' >"$temporary/admin-user"
	openssl rand -base64 36 | tr -d '\n' >"$temporary/admin-password"
	chmod 0600 "$temporary/admin-user" "$temporary/admin-password"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" create secret generic \
		actor-mesh-observability-grafana-admin \
		--from-file=admin-user="$temporary/admin-user" \
		--from-file=admin-password="$temporary/admin-password" >/dev/null
fi

helm "${kubeconfig_args[@]}" upgrade --install "$release" "$chart_archive" \
	--namespace "$namespace" \
	--values "$script_dir/hub-values.yaml" \
	--values "$temporary/targets-values.yaml" \
	"${helm_image_args[@]}" \
	--atomic --wait --timeout 20m
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-rules.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-compute-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-storage-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-cold-tier-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-workers-api.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/hub-workers-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/actor-mesh-observability-operator --timeout=5m
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	statefulset/actor-mesh-observability-grafana --timeout=10m
kubectl "${kubeconfig_args[@]}" -n "$namespace" wait --for=condition=ready \
	pod -l app.kubernetes.io/name=prometheus --timeout=10m

ACTOR_PROMETHEUS_ADAPTER_NAMESPACE=$namespace \
ACTOR_PROMETHEUS_ADAPTER_RELEASE=actor-mesh-prometheus-adapter \
ACTOR_PROMETHEUS_ADAPTER_VALUES=$script_dir/hub-prometheus-adapter-values.yaml \
	"$script_dir/../install-prometheus-adapter.sh"

echo "mesh observability converged: chart=$chart_version"
