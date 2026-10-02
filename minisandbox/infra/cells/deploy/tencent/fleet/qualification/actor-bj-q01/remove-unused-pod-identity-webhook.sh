#!/usr/bin/env bash
set -euo pipefail

# TKE requires auto_install_pod_identity_webhook_addon=true while initially
# creating the managed OIDC provider. q01 workloads do not use that addon:
# they declare a projected ServiceAccount token and Tencent SDK environment
# explicitly. Remove the incomplete addon only after proving that contract.

namespace=kube-system
release=pod-identity-webhook
runtime_namespace=actor-fdb-cell-system
runtime_deployment=actor-bj-q01-runtime-capacity
kubectl_bin=${KUBECTL:-kubectl}

[[ -n ${KUBECONFIG:-} ]] || {
	echo "KUBECONFIG must identify the reviewed q01 cluster" >&2
	exit 2
}

runtime=$($kubectl_bin -n "$runtime_namespace" get deployment "$runtime_deployment" -o json)
jq -e '
  .status.readyReplicas >= 1 and
  ([.spec.template.spec.volumes[]?
    | select(.name == "tke-oidc-token")
    | .projected.sources[]?.serviceAccountToken
    | select(.audience == "sts.cloud.tencent.com" and .path == "token")]
   | length == 1) and
  ([.spec.template.spec.containers[]?.env[]?
    | select(.name == "TKE_WEB_IDENTITY_TOKEN_FILE" and
             .value == "/var/run/secrets/cloud.tencent.com/serviceaccount/token")]
   | length == 1)
' >/dev/null <<<"$runtime" || {
	echo "q01 runtime capacity controller has no healthy explicit OIDC identity" >&2
	exit 1
}

deployment=$($kubectl_bin -n "$namespace" get deployment "$release" -o json 2>/dev/null || true)
webhook=$($kubectl_bin get mutatingwebhookconfiguration "$release" -o json 2>/dev/null || true)
helm_secret=$($kubectl_bin -n "$namespace" get secret "sh.helm.release.v1.${release}.v1" -o json 2>/dev/null || true)

if [[ -z $deployment && -z $webhook && -z $helm_secret ]]; then
	echo "unused pod identity webhook is already absent"
	exit 0
fi

[[ -n $deployment && -n $webhook && -n $helm_secret ]] || {
	echo "partial pod identity webhook inventory; refusing an ambiguous cleanup" >&2
	exit 1
}

jq -e '
  .metadata.labels["app.kubernetes.io/managed-by"] == "Helm" and
  .metadata.labels["helm.sh/chart"] == "pod-identity-webhook-0.2.0" and
  .metadata.annotations["meta.helm.sh/release-name"] == "pod-identity-webhook" and
  .spec.template.spec.containers[0].image ==
    "ccr.ccs.tencentyun.com/tkeimages/pod-identity-webhook:v0.2.0"
' >/dev/null <<<"$deployment" || {
	echo "pod identity deployment identity differs from the reviewed TKE addon" >&2
	exit 1
}
jq -e '
  (.webhooks | length == 1) and
  .webhooks[0].failurePolicy == "Ignore" and
  .webhooks[0].clientConfig.url ==
    "https://pod-identity-webhook:443/mutate--v1-pod"
' >/dev/null <<<"$webhook" || {
	echo "pod identity webhook contract differs from the reviewed inert addon" >&2
	exit 1
}
jq -e '
  .metadata.labels.owner == "helm" and
  .metadata.labels.name == "pod-identity-webhook" and
  .metadata.labels.status == "deployed" and
  .metadata.labels.version == "1"
' >/dev/null <<<"$helm_secret" || {
	echo "pod identity Helm release identity differs from the reviewed release" >&2
	exit 1
}

$kubectl_bin -n "$namespace" delete deployment "$release" --wait=true
$kubectl_bin -n "$namespace" delete service "$release" --ignore-not-found=true
$kubectl_bin delete mutatingwebhookconfiguration "$release" --wait=true
$kubectl_bin -n "$namespace" delete secret "sh.helm.release.v1.${release}.v1" --wait=true

$kubectl_bin -n "$runtime_namespace" rollout status deployment/$runtime_deployment --timeout=120s
if $kubectl_bin -n "$namespace" get deployment "$release" >/dev/null 2>&1 ||
	$kubectl_bin get mutatingwebhookconfiguration "$release" >/dev/null 2>&1; then
	echo "unused pod identity webhook still exists after cleanup" >&2
	exit 1
fi

echo "removed unused incomplete TKE pod identity webhook; explicit q01 OIDC remains healthy"
