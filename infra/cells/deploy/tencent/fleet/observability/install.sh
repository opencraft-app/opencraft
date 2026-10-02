#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=observability
release=actor-observability
chart=oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack
chart_version=87.21.0
chart_sha256=05eae98df0ff6c21877a26a4400780e4bbff248bc3b88694ef8d08b273ed6815
region=${ACTOR_REGION:?ACTOR_REGION is required, for example ap-beijing}
cluster=${ACTOR_CLUSTER_NAME:?ACTOR_CLUSTER_NAME is required, for example actor-bj-k01}
image_registry=${ACTOR_OBSERVABILITY_IMAGE_REGISTRY:-}
image_namespace=${ACTOR_OBSERVABILITY_IMAGE_NAMESPACE:-actor-fleet}
image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}
infrastructure_metrics_file=${ACTOR_INFRASTRUCTURE_METRICS_FILE:-$script_dir/infrastructure-metrics.yaml}
prometheus_memory_request=${ACTOR_PROMETHEUS_MEMORY_REQUEST:-2Gi}
chart_archive_input=${ACTOR_OBSERVABILITY_CHART_ARCHIVE:-}
adapter_archive_input=${ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE:-}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in helm jq kubectl openssl python3 sha256sum; do
	command -v "$command" >/dev/null || {
		echo "required command is missing: $command" >&2
		exit 2
	}
done
[[ $image_inventory == /* && -f $image_inventory ]] || {
	echo "ACTOR_IMAGE_INVENTORY must be an absolute regular-file path" >&2
	exit 2
}
[[ -z $chart_archive_input || -f $chart_archive_input ]] || {
	echo "ACTOR_OBSERVABILITY_CHART_ARCHIVE must be a regular file" >&2
	exit 2
}
if [[ -n $chart_archive_input && -z $adapter_archive_input ]]; then
	echo "offline observability requires ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE as well as the main chart" >&2
	exit 2
fi
if [[ -n $adapter_archive_input ]]; then
	[[ $adapter_archive_input == /* && -f $adapter_archive_input && ! -L $adapter_archive_input ]] || {
		echo "ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE must be an absolute regular non-symlink file" >&2
		exit 2
	}
	adapter_sha=$(sha256sum "$adapter_archive_input" | cut -d' ' -f1)
	[[ $adapter_sha == aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31 ]] || {
		echo "prometheus-adapter archive SHA-256 mismatch" >&2
		exit 1
	}
fi
[[ $prometheus_memory_request =~ ^[1-9][0-9]*(Mi|Gi)$ ]] || {
	echo "ACTOR_PROMETHEUS_MEMORY_REQUEST must be a positive Mi or Gi quantity" >&2
	exit 2
}

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

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

fdb_monitor_image=$(resolve_image fdb-kubernetes-monitor)
metrics_image=$(resolve_image observability-busybox)

chart_archive="$temporary/kube-prometheus-stack-${chart_version}.tgz"
if [[ -n $chart_archive_input ]]; then
	cp -- "$chart_archive_input" "$chart_archive"
else
	helm pull "$chart" --version "$chart_version" --destination "$temporary" >/dev/null
fi
actual_chart_sha=$(sha256sum "$chart_archive" | cut -d' ' -f1)
[[ $actual_chart_sha == "$chart_sha256" ]] || {
	echo "kube-prometheus-stack archive SHA-256 mismatch" >&2
	exit 1
}

if [[ -n ${ACTOR_CELL_NAME:-} ]]; then
	: "${ACTOR_BACKUP_BUCKET:?ACTOR_BACKUP_BUCKET is required with ACTOR_CELL_NAME}"
	infrastructure_metrics_file="$temporary/infrastructure-metrics.yaml"
	python3 "$script_dir/render-infrastructure-metrics.py" \
    --input "$script_dir/infrastructure-metrics.yaml" \
    --output "$infrastructure_metrics_file" \
    --cell "$ACTOR_CELL_NAME" \
    --region "$region" \
    --backup-bucket "$ACTOR_BACKUP_BUCKET" \
		--fdb-monitor-image "$fdb_monitor_image" \
		--metrics-image "$metrics_image"
fi
[[ -f $infrastructure_metrics_file ]] || {
	echo "infrastructure metrics manifest is missing: $infrastructure_metrics_file" >&2
	exit 2
}

kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/namespace-storage.yaml"
helm_image_args=()
if [[ -n $image_registry ]]; then
	controller_namespace=${ACTOR_FLEET_CONTROLLER_NAMESPACE:-fdb-operator-actor-fleet-controller-system}
	kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" get secret actor-fleet-tcr -o json | \
		python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["metadata"]; m["name"]="actor-fleet-tcr"; m["namespace"]=sys.argv[1]; [m.pop(k,None) for k in ("uid","resourceVersion","creationTimestamp","managedFields")]; print(json.dumps(d))' "$namespace" | \
		kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
	helm_image_args=(
		--set-string "global.imagePullSecrets[0].name=actor-fleet-tcr"
		# Chart 87.21.0 gates the busybox digest branch on image.sha instead
		# of image.busybox.sha. Keep the sentinel until the upstream template
		# uses the leaf value; the rendered image still uses busybox.sha below.
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
	actor-observability-grafana-admin >/dev/null 2>&1; then
	printf 'admin' >"$temporary/admin-user"
	openssl rand -base64 36 | tr -d '\n' >"$temporary/admin-password"
	chmod 0600 "$temporary/admin-user" "$temporary/admin-password"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" create secret generic \
		actor-observability-grafana-admin \
		--from-file=admin-user="$temporary/admin-user" \
		--from-file=admin-password="$temporary/admin-password" >/dev/null
fi

helm "${kubeconfig_args[@]}" upgrade --install "$release" "$chart_archive" \
	--namespace "$namespace" \
	--values "$script_dir/values.yaml" \
	--set-string "prometheus.prometheusSpec.externalLabels.region=$region" \
	--set-string "prometheus.prometheusSpec.externalLabels.cluster=$cluster" \
	--set-string "prometheus.prometheusSpec.resources.requests.memory=$prometheus_memory_request" \
	"${helm_image_args[@]}" \
	--atomic --wait --timeout 20m

kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/engine-metrics.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$infrastructure_metrics_file"
kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system rollout restart \
	deployment -l app.kubernetes.io/name=actor-fdb-backup-metrics
kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system rollout status \
	deployment -l app.kubernetes.io/name=actor-fdb-backup-metrics --timeout=5m
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/actor-rules.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/actor-dashboard.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/federation/spoke-rules.yaml"
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/actor-observability-operator --timeout=5m
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	statefulset/actor-observability-grafana --timeout=10m
for _ in $(seq 1 60); do
	if kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod \
		-l app.kubernetes.io/name=prometheus -o name | grep -q .; then
		break
	fi
	sleep 2
done
kubectl "${kubeconfig_args[@]}" -n "$namespace" wait --for=condition=ready \
	pod -l app.kubernetes.io/name=prometheus --timeout=10m

"$script_dir/install-prometheus-adapter.sh"

echo "actor observability converged: chart=$chart_version region=$region cluster=$cluster"
