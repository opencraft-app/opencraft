#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# -eq 5 ]] || { echo "Usage: install-application.sh APPLICATION PUBLICATION DESIRED_RENDER INSTALL_RECEIPT CONVERGENCE_RECEIPT" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=${ACTOR_FLEET_SOURCE_DIR:-$(CDPATH= cd -- "$script_dir/../.." && pwd)}
[[ $fleet_dir == /* && -d $fleet_dir && ! -L $fleet_dir ]] || { echo "invalid ACTOR_FLEET_SOURCE_DIR" >&2; exit 2; }
: "${HUB_KUBECONFIG:?set HUB_KUBECONFIG}"
python=${PYTHON:-python3.11}
application=$1; publication=$2; desired=$3; install=$4; convergence=$5
for path in "$HUB_KUBECONFIG" "$application" "$publication" "$desired" "$install"; do [[ -f $path && ! -L $path ]] || { echo "invalid adoption input: $path" >&2; exit 2; }; done
[[ $convergence == /* && ! -e $convergence && -d $(dirname -- "$convergence") ]] || { echo "convergence receipt must be new" >&2; exit 2; }
temporary=$(mktemp -d /data/tmp/actor-code-plane-adopt.XXXXXX); trap 'rm -rf -- "$temporary"' EXIT INT TERM
"$python" "$script_dir/render-application.py" --publication-receipt "$publication" --desired-render-receipt "$desired" --output "$temporary/expected.yaml"
cmp -s "$application" "$temporary/expected.yaml" || { echo "Application differs from receipt-bound rendering" >&2; exit 1; }
revision=$(jq -er '.gitRevision' "$publication")
management_id=$(jq -er '.managementId' "$install")
k=(kubectl --kubeconfig "$HUB_KUBECONFIG")

capture() {
	local output=$1
	jq -n \
		--arg fdb "$("${k[@]}" -n actor-fdb-cell-system get foundationdbcluster "$management_id" -o jsonpath='{.metadata.uid}')" \
		--arg backup "$("${k[@]}" -n actor-fdb-cell-system get foundationdbbackup "$management_id-continuous" -o jsonpath='{.metadata.uid}')" \
		--arg registry "$("${k[@]}" -n worker-registry-system get deployment worker-registry -o jsonpath='{.metadata.uid}')" \
		--arg service "$("${k[@]}" -n worker-registry-system get service worker-registry-private -o jsonpath='{.metadata.uid}')" \
		--arg endpoint "$("${k[@]}" -n worker-registry-system get service worker-registry-private -o jsonpath='{.status.loadBalancer.ingress[0].ip}')" \
		--arg fdb_pull "$("${k[@]}" -n actor-fdb-cell-system get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}')" \
		--arg backup_credentials "$("${k[@]}" -n actor-fdb-cell-system get secret "$management_id-backup-credentials" -o jsonpath='{.metadata.uid}')" \
		--arg registry_pull "$("${k[@]}" -n worker-registry-system get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}')" \
		--arg registry_fdb "$("${k[@]}" -n worker-registry-system get secret worker-registry-fdb -o jsonpath='{.metadata.uid}')" \
		--arg registry_tls "$("${k[@]}" -n worker-registry-system get secret worker-registry-fdb-tls -o jsonpath='{.metadata.uid}')" \
		--arg registry_cos "$("${k[@]}" -n worker-registry-system get secret worker-registry-cos -o jsonpath='{.metadata.uid}')" \
		'{fdbClusterUid:$fdb,fdbBackupUid:$backup,registryDeploymentUid:$registry,registryPrivateServiceUid:$service,endpointIp:$endpoint,secrets:{fdbPullUid:$fdb_pull,backupCredentialsUid:$backup_credentials,registryPullUid:$registry_pull,registryFdbUid:$registry_fdb,registryTlsUid:$registry_tls,registryCosUid:$registry_cos}}' >"$output"
}
capture "$temporary/before.json"
"$python" - "$temporary/before.json" "$install" <<'PY'
import json,sys
live,receipt=(json.load(open(path)) for path in sys.argv[1:])
expected={"fdbClusterUid":receipt["foundationDB"]["uid"],"fdbBackupUid":receipt["foundationDB"]["backup"]["uid"],"registryDeploymentUid":receipt["registry"]["deploymentUid"],"registryPrivateServiceUid":receipt["registry"]["privateServiceUid"]}
if any(live[key]!=value for key,value in expected.items()): raise SystemExit("live code-plane identity differs from install receipt")
if live["secrets"] != receipt["externalSecrets"]: raise SystemExit("live external Secret identity differs from install receipt")
PY

"${k[@]}" -n argocd get configmap argocd-cm -o json >"$temporary/argocd-cm.json"
management_ip=$("${k[@]}" -n default get service kubernetes -o jsonpath='{.spec.clusterIP}')
"$python" "$fleet_dir/workers-api/gitops/merge-resource-inclusions.py" --existing "$temporary/argocd-cm.json" \
	--required "$script_dir/resource-inclusions.yaml" --management-cluster-url "https://$management_ip:443" --output "$temporary/argocd-cm.yaml"
"${k[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap -f "$temporary/argocd-cm.yaml" >/dev/null
"${k[@]}" -n argocd rollout restart statefulset/argocd-application-controller >/dev/null
"${k[@]}" -n argocd rollout status statefulset/argocd-application-controller --timeout=5m >/dev/null
"${k[@]}" apply --server-side --force-conflicts --field-manager=actor-management-bootstrap -f "$application" >/dev/null
"${k[@]}" -n argocd annotate application actor-regional-code-plane argocd.argoproj.io/refresh=hard --overwrite >/dev/null
deadline=$((SECONDS+600))
while ((SECONDS<deadline)); do
	"${k[@]}" -n argocd get application actor-regional-code-plane -o json >"$temporary/application.json"
	jq -e --arg revision "$revision" '.status.sync.revision==$revision and .status.sync.status=="Synced" and ((.status.conditions//[])|length==0) and (.status.resources|length==9) and all(.status.resources[];.status=="Synced")' "$temporary/application.json" >/dev/null && break
	sleep 5
done
jq -e --arg revision "$revision" '.status.sync.revision==$revision and .status.sync.status=="Synced" and ((.status.conditions//[])|length==0) and (.status.resources|length==9) and all(.status.resources[];.status=="Synced")' "$temporary/application.json" >/dev/null || { echo "code-plane Application did not converge" >&2; exit 1; }
capture "$temporary/after.json"
cmp -s "$temporary/before.json" "$temporary/after.json" || { echo "Argo adoption changed code-plane or Secret identity" >&2; exit 1; }

"${k[@]}" -n worker-registry-system patch deployment worker-registry --type=merge -p '{"spec":{"revisionHistoryLimit":4}}' >/dev/null
"${k[@]}" -n argocd annotate application actor-regional-code-plane argocd.argoproj.io/refresh=hard --overwrite >/dev/null
deadline=$((SECONDS+180)); while ((SECONDS<deadline)); do [[ $("${k[@]}" -n worker-registry-system get deployment worker-registry -o jsonpath='{.spec.revisionHistoryLimit}') == 3 ]] && break; sleep 3; done
[[ $("${k[@]}" -n worker-registry-system get deployment worker-registry -o jsonpath='{.spec.revisionHistoryLimit}') == 3 ]] || { echo "Argo did not self-heal Registry drift" >&2; exit 1; }

jq -n --arg revision "$revision" --arg publication "$(sha256sum "$publication"|cut -d' ' -f1)" --arg desired "$(sha256sum "$desired"|cut -d' ' -f1)" \
	--arg application_uid "$(jq -er '.metadata.uid' "$temporary/application.json")" --argjson identity "$(cat "$temporary/after.json")" \
	'{schema:"actor-regional-code-plane-argocd-convergence/v1",verdict:"passed",gitRevision:$revision,sourceReceipts:{publicationSha256:$publication,desiredRenderSha256:$desired},applicationUid:$application_uid,adoptedIdentity:$identity,gates:{synced:true,identityPreserved:true,secretsExternallyOwned:true,pruneDisabled:true,selfHeal:true}}' >"$temporary/receipt.json"
ln "$temporary/receipt.json" "$convergence"; chmod 0644 "$convergence"
printf 'regional_code_plane_argocd=passed revision=%s receipt=%s\n' "$revision" "$convergence"
