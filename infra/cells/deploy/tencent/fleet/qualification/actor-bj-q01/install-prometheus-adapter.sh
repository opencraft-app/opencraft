#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
chart=oci://ghcr.io/prometheus-community/charts/prometheus-adapter
chart_version=5.3.0
chart_sha256=aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31
image=lightclaw-bj82.tencentcloudcr.com/actor-fleet/observability-prometheus-adapter
image_tag=v0.12.0@sha256:7c715d3f0cb5fac0341cb9b167b934c5c72e7408e98587bf08dde994ce77462f
namespace=observability
release=actor-prometheus-adapter
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT

helm pull "$chart" --version "$chart_version" --destination "$temporary" >/dev/null
archive=$temporary/prometheus-adapter-$chart_version.tgz
actual_sha=$(sha256sum "$archive" | cut -d' ' -f1)
[[ $actual_sha == "$chart_sha256" ]] || {
	echo "prometheus-adapter chart SHA-256 mismatch" >&2
	exit 1
}

helm "${kubeconfig_args[@]}" upgrade --install "$release" "$archive" \
	--namespace "$namespace" \
	--values "$script_dir/prometheus-adapter-values.yaml" \
	--set-string "image.repository=$image" \
	--set-string "image.tag=$image_tag" \
	--set-string 'image.pullSecrets[0]=actor-fleet-tcr' \
	--atomic --wait --timeout 10m

kubectl "${kubeconfig_args[@]}" wait --for=condition=Available \
	apiservice/v1beta1.external.metrics.k8s.io --timeout=5m
kubectl "${kubeconfig_args[@]}" get --raw \
	/apis/external.metrics.k8s.io/v1beta1 >/dev/null
echo "q01 Prometheus Adapter converged: chart=$chart_version image=$image_tag"
