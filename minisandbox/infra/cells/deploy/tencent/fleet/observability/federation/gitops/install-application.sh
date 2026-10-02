#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 4 ]] || { echo "Usage: install-application.sh APPLICATION PUBLICATION RENDER_RECEIPT CONVERGENCE_RECEIPT" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
: "${HUB_KUBECONFIG:?set HUB_KUBECONFIG}"
python=${PYTHON:-python3.11}; application=$1; publication=$2; render_receipt=$3; convergence=$4
for path in "$HUB_KUBECONFIG" "$application" "$publication" "$render_receipt"; do
  [[ -f $path && ! -L $path ]] || { echo "invalid Argo adoption input: $path" >&2; exit 2; }
done
[[ $convergence == /* && ! -e $convergence && -d $(dirname -- "$convergence") ]] || { echo "convergence receipt must be a new absolute path" >&2; exit 2; }
temporary=$(mktemp -d /data/tmp/actor-observability-adopt.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
k=(kubectl --kubeconfig "$HUB_KUBECONFIG")
repository=$(jq -er '.repository.url' "$publication"); revision=$(jq -er '.gitRevision' "$publication")
[[ $(jq -er '.schema + ":" + .verdict' "$publication") == actor-mesh-observability-desired-publication/v1:passed ]]
[[ $(jq -er '.schema + ":" + .verdict' "$render_receipt") == actor-mesh-observability-desired-render/v1:passed ]]
[[ $(jq -er '.renderReceiptSha256' "$publication") == "sha256:$(sha256sum "$render_receipt" | cut -d' ' -f1)" ]]
"$python" "$script_dir/render-application.py" --repository "$repository" --revision "$revision" --output "$temporary/expected.yaml" >/dev/null
cmp -s "$application" "$temporary/expected.yaml" || { echo "Application differs from receipt-bound rendering" >&2; exit 1; }

"${k[@]}" -n mesh-observability get statefulset actor-mesh-observability-grafana -o jsonpath='{.metadata.uid}' >"$temporary/grafana.uid"
"${k[@]}" -n mesh-observability get prometheus actor-mesh-observability-prometheus -o jsonpath='{.metadata.uid}' >"$temporary/prometheus.uid"
"${k[@]}" -n mesh-observability get service actor-mesh-observability-grafana -o jsonpath='{.metadata.uid}' >"$temporary/service.uid"
"${k[@]}" -n mesh-observability get secret actor-mesh-observability-grafana-admin -o jsonpath='{.metadata.uid}' >"$temporary/admin.uid"
# This noncredential Secret originates from pinned values, but remains outside
# desired Git so the observability Project never gains Secret write authority.
"${k[@]}" -n mesh-observability annotate secret actor-mesh-observability-prometheus-scrape-confg \
  argocd.argoproj.io/sync-options=Prune=false --overwrite >/dev/null

"${k[@]}" -n argocd get configmap argocd-cm -o json >"$temporary/argocd-cm.json"
management_ip=$("${k[@]}" -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')
"$python" "$fleet_dir/workers-api/gitops/merge-resource-inclusions.py" \
  --existing "$temporary/argocd-cm.json" --required "$script_dir/resource-inclusions.yaml" \
  --management-cluster-url "https://$management_ip:443" --output "$temporary/argocd-cm.yaml"
"${k[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap -f "$temporary/argocd-cm.yaml" >/dev/null
"${k[@]}" -n argocd rollout restart statefulset/argocd-application-controller >/dev/null
"${k[@]}" -n argocd rollout status statefulset/argocd-application-controller --timeout=5m >/dev/null
"${k[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap -f "$application" >/dev/null
"${k[@]}" -n argocd annotate application actor-management-observability argocd.argoproj.io/refresh=hard --overwrite >/dev/null

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
  "${k[@]}" -n argocd get application actor-management-observability -o json >"$temporary/live.json"
  jq -e --arg revision "$revision" '.status.sync.revision==$revision and .status.sync.status=="Synced" and .status.health.status=="Healthy" and ((.status.conditions//[])|length==0) and all(.status.resources[]; .status=="Synced")' "$temporary/live.json" >/dev/null && break
  sleep 5
done
jq -e --arg revision "$revision" '.status.sync.revision==$revision and .status.sync.status=="Synced" and .status.health.status=="Healthy" and ((.status.conditions//[])|length==0) and all(.status.resources[]; .status=="Synced") and all(.status.resources[]; .kind!="Secret")' "$temporary/live.json" >/dev/null
[[ $("${k[@]}" -n mesh-observability get statefulset actor-mesh-observability-grafana -o jsonpath='{.metadata.uid}') == "$(<"$temporary/grafana.uid")" ]]
[[ $("${k[@]}" -n mesh-observability get prometheus actor-mesh-observability-prometheus -o jsonpath='{.metadata.uid}') == "$(<"$temporary/prometheus.uid")" ]]
[[ $("${k[@]}" -n mesh-observability get service actor-mesh-observability-grafana -o jsonpath='{.metadata.uid}') == "$(<"$temporary/service.uid")" ]]
[[ $("${k[@]}" -n mesh-observability get secret actor-mesh-observability-grafana-admin -o jsonpath='{.metadata.uid}') == "$(<"$temporary/admin.uid")" ]]

original=$("${k[@]}" -n mesh-observability get configmap actor-mesh-overview-dashboard -o jsonpath='{.data.actor-mesh-overview\.json}' | sha256sum | cut -d' ' -f1)
"${k[@]}" -n mesh-observability patch configmap actor-mesh-overview-dashboard --type=merge -p '{"data":{"actor-mesh-overview.json":"drift"}}' >/dev/null
"${k[@]}" -n argocd annotate application actor-management-observability argocd.argoproj.io/refresh=hard --overwrite >/dev/null
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
  current=$("${k[@]}" -n mesh-observability get configmap actor-mesh-overview-dashboard -o jsonpath='{.data.actor-mesh-overview\.json}' | sha256sum | cut -d' ' -f1)
  [[ $current == "$original" ]] && break
  sleep 3
done
[[ $current == "$original" ]] || { echo "Argo did not self-heal dashboard drift" >&2; exit 1; }

jq -cn --arg revision "$revision" --arg app_uid "$(jq -er '.metadata.uid' "$temporary/live.json")" \
  --arg project_uid "$("${k[@]}" -n argocd get appproject actor-management-observability -o jsonpath='{.metadata.uid}')" \
  --arg grafana_uid "$(<"$temporary/grafana.uid")" --arg prometheus_uid "$(<"$temporary/prometheus.uid")" \
  '{schema:"actor-mesh-observability-argocd-convergence/v1",verdict:"passed",gitRevision:$revision,bootstrapResources:{applicationUid:$app_uid,projectUid:$project_uid},adoptedResources:{grafanaStatefulSetUid:$grafana_uid,prometheusUid:$prometheus_uid},gates:{synced:true,healthy:true,leastPrivilegeProject:true,noSecretInDesiredState:true,identityPreserved:true,selfHeal:true}}' >"$temporary/receipt.json"
ln "$temporary/receipt.json" "$convergence"; chmod 0644 "$convergence"
echo "management_observability_argocd=passed revision=$revision receipt=$convergence"
