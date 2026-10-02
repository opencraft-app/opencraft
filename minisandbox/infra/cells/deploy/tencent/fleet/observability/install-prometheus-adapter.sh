#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${ACTOR_PROMETHEUS_ADAPTER_NAMESPACE:-observability}
release=${ACTOR_PROMETHEUS_ADAPTER_RELEASE:-actor-prometheus-adapter}
chart=oci://ghcr.io/prometheus-community/charts/prometheus-adapter
chart_version=5.3.0
chart_sha256=aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31
image_tag=v0.12.0
image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}
chart_archive_input=${ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE:-}
values_file=${ACTOR_PROMETHEUS_ADAPTER_VALUES:-$script_dir/prometheus-adapter-values.yaml}
adopt_tke_apiservice=${ACTOR_PROMETHEUS_ADAPTER_ADOPT_TKE_APISERVICE:-false}
adoption_receipt=${ACTOR_PROMETHEUS_ADAPTER_ADOPTION_RECEIPT:-}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in helm jq kubectl sha256sum; do
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
	echo "ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE must be a regular file" >&2
	exit 2
}
[[ $values_file == /* && -f $values_file && ! -L $values_file ]] || {
	echo "ACTOR_PROMETHEUS_ADAPTER_VALUES must be an absolute regular non-symlink file" >&2
	exit 2
}
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && $release =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "Prometheus Adapter namespace and release must be DNS labels" >&2
	exit 2
}
[[ $adopt_tke_apiservice == false || $adopt_tke_apiservice == true ]] || {
	echo "ACTOR_PROMETHEUS_ADAPTER_ADOPT_TKE_APISERVICE must be true or false" >&2
	exit 2
}
if [[ $adopt_tke_apiservice == true ]]; then
	[[ $adoption_receipt == /* && ! -e $adoption_receipt && -d $(dirname -- "$adoption_receipt") ]] || {
		echo "TKE APIService adoption requires a new absolute receipt path" >&2
		exit 2
	}
fi

image_ref=$(jq -er '
  [.images[] | select(.repository == "observability-prometheus-adapter") | .ref] |
  if length == 1 then .[0] else error("adapter image must resolve exactly once") end
' "$image_inventory")
[[ $image_ref =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
	echo "adapter image is not digest pinned" >&2
	exit 2
}
image_repository=${image_ref%@sha256:*}
image_digest=${image_ref##*@}

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

chart_archive="$temporary/prometheus-adapter-${chart_version}.tgz"
if [[ -n $chart_archive_input ]]; then
	cp -- "$chart_archive_input" "$chart_archive"
else
	helm pull "$chart" --version "$chart_version" --destination "$temporary" >/dev/null
fi
actual_chart_sha=$(sha256sum "$chart_archive" | cut -d' ' -f1)
[[ $actual_chart_sha == "$chart_sha256" ]] || {
	echo "prometheus-adapter archive SHA-256 mismatch" >&2
	exit 1
}

apiservice=v1beta1.custom.metrics.k8s.io
adopted_uid=
if kubectl "${kubeconfig_args[@]}" get apiservice "$apiservice" -o json >"$temporary/apiservice-before.json" 2>/dev/null \
	&& ! helm "${kubeconfig_args[@]}" status "$release" --namespace "$namespace" >/dev/null 2>&1; then
	[[ $adopt_tke_apiservice == true ]] || {
		echo "$apiservice already exists; explicit TKE APIService adoption is required" >&2
		exit 1
	}
	jq -e '
	  .metadata.name == "v1beta1.custom.metrics.k8s.io" and
	  .spec.group == "custom.metrics.k8s.io" and .spec.version == "v1beta1" and
	  .spec.service.namespace == "kube-system" and .spec.service.name == "hpa-metrics-service" and
	  (.metadata.uid | type == "string" and length > 0)
	' "$temporary/apiservice-before.json" >/dev/null || {
		echo "existing custom metrics APIService is not the reviewed TKE service" >&2
		exit 1
	}
	adopted_uid=$(jq -er '.metadata.uid' "$temporary/apiservice-before.json")
	kubectl "${kubeconfig_args[@]}" label apiservice "$apiservice" \
		app.kubernetes.io/managed-by=Helm --overwrite >/dev/null
	kubectl "${kubeconfig_args[@]}" annotate apiservice "$apiservice" \
		meta.helm.sh/release-name="$release" \
		meta.helm.sh/release-namespace="$namespace" \
		fleet.actor.dev/adopted-from-service=kube-system/hpa-metrics-service \
		fleet.actor.dev/adopted-uid="$adopted_uid" --overwrite >/dev/null
fi

kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret actor-fleet-tcr >/dev/null
helm "${kubeconfig_args[@]}" upgrade --install "$release" "$chart_archive" \
	--namespace "$namespace" \
	--values "$values_file" \
	--set-string "image.repository=$image_repository" \
	--set-string "image.tag=$image_tag@$image_digest" \
	--set-string 'image.pullSecrets[0]=actor-fleet-tcr' \
	--atomic --wait --timeout 10m

if [[ $adopt_tke_apiservice == true ]]; then
	kubectl "${kubeconfig_args[@]}" get apiservice "$apiservice" -o json >"$temporary/apiservice-after.json"
	[[ -n $adopted_uid ]] || adopted_uid=$(jq -er '.metadata.annotations["fleet.actor.dev/adopted-uid"]' "$temporary/apiservice-after.json")
	if jq -e --arg uid "$adopted_uid" '
	  .metadata.uid == $uid and .spec.service.namespace == "kube-system" and
	  .spec.service.name == "hpa-metrics-service"
	' "$temporary/apiservice-after.json" >/dev/null; then
		patch=$(jq -cn --arg uid "$adopted_uid" --arg namespace "$namespace" --arg release "$release" '[
		  {op:"test",path:"/metadata/uid",value:$uid},
		  {op:"test",path:"/spec/service/namespace",value:"kube-system"},
		  {op:"test",path:"/spec/service/name",value:"hpa-metrics-service"},
		  {op:"replace",path:"/spec/service/namespace",value:$namespace},
		  {op:"replace",path:"/spec/service/name",value:$release}
		]')
		kubectl "${kubeconfig_args[@]}" patch apiservice "$apiservice" --type=json -p "$patch" >/dev/null
	fi
	# TKE's prior service is control-plane managed. Prove that the reviewed
	# pointer transition is stable instead of accepting a momentary successful
	# patch that the provider immediately reconciles away.
	for _ in $(seq 1 12); do
		sleep 5
		kubectl "${kubeconfig_args[@]}" get apiservice "$apiservice" -o json >"$temporary/apiservice-after.json"
		jq -e --arg uid "$adopted_uid" --arg namespace "$namespace" --arg release "$release" '
		  .metadata.uid == $uid and .spec.service.namespace == $namespace and
		  .spec.service.name == $release and
		  any(.status.conditions[]?; .type == "Available" and .status == "True")
		' "$temporary/apiservice-after.json" >/dev/null || {
			echo "TKE reclaimed the custom metrics APIService during the takeover observation" >&2
			exit 1
		}
	done
	jq -e --arg uid "$adopted_uid" --arg namespace "$namespace" --arg release "$release" '
	  .metadata.uid == $uid and
	  .metadata.annotations["fleet.actor.dev/adopted-from-service"] == "kube-system/hpa-metrics-service" and
	  .metadata.labels["app.kubernetes.io/managed-by"] == "Helm" and
	  .metadata.annotations["meta.helm.sh/release-name"] == $release and
	  .metadata.annotations["meta.helm.sh/release-namespace"] == $namespace and
	  .spec.service.name == $release and .spec.service.namespace == $namespace
	' "$temporary/apiservice-after.json" >/dev/null || {
		echo "Prometheus Adapter did not preserve and adopt the TKE APIService identity" >&2
		exit 1
	}
	jq -cn --arg uid "$adopted_uid" --arg namespace "$namespace" --arg release "$release" \
		--arg chart_sha256 "sha256:$actual_chart_sha" --arg image "$image_ref" \
		'{schema:"actor-prometheus-adapter-apiservice-adoption/v1",verdict:"passed",
		  apiService:{name:"v1beta1.custom.metrics.k8s.io",uid:$uid,
		    priorService:{namespace:"kube-system",name:"hpa-metrics-service"},
		    currentService:{namespace:$namespace,name:$release}},
		  chartSha256:$chart_sha256,image:$image,
		  gates:{exactTkeSource:true,uidPreserved:true,helmOwnership:true,adapterServiceActive:true,
		    stableObservationSeconds:60}}' \
		>"$temporary/adoption-receipt.json"
	ln "$temporary/adoption-receipt.json" "$adoption_receipt"
	chmod 0644 "$adoption_receipt"
fi

api_groups=$(helm template "$release" "$chart_archive" --namespace "$namespace" \
	--values "$values_file" | sed -n 's/^  name: v1beta1\.\([a-z]*\.metrics\.k8s\.io\)$/\1/p' | sort -u)
[[ -n $api_groups ]] || { echo "Prometheus Adapter rendered no metrics APIService" >&2; exit 1; }
while IFS= read -r group; do
	kubectl "${kubeconfig_args[@]}" wait --for=condition=Available \
		"apiservice/v1beta1.$group" --timeout=5m
	kubectl "${kubeconfig_args[@]}" get --raw "/apis/$group/v1beta1" >/dev/null
done <<<"$api_groups"

echo "Prometheus Adapter converged: chart=$chart_version image=$image_repository:$image_tag@$image_digest"
