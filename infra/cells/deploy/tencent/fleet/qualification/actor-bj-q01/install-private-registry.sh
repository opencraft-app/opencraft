#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
registry_id=${QUALIFICATION_TCR_REGISTRY_ID:-tcr-g7ax6o7q}
registry_host=${QUALIFICATION_TCR_HOST:-lightclaw-bj82.tencentcloudcr.com}
cluster_id=${QUALIFICATION_CLUSTER_ID:-cls-ike1rebd}
remote_config=${QUALIFICATION_REMOTE_TCR_CONFIG:-/var/lib/actor-build/credentials/actor-bj-q01-tcr-config.json}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
registry_identity=${registry_id#tcr-}
[[ $registry_identity =~ ^[a-z0-9]+$ ]]
credential_file=$state_dir/q01-tcr-${registry_identity}-longterm-credential-v1.json
token_description=actor-bj-q01-image-pull-${registry_identity}-v1
namespaces=(
	fdb-operator-actor-fleet-controller-system
	actor-fdb-cell-system
	actor-stateless-system
	actor-runtime-admission-system
	observability
	actor-release-system
	actor-git-system
	argocd
)
required_repositories=(
	actor-fleet/actor-fleet-controller
	actor-fleet/actor-loadgen
	actor-fleet/base-golang
	actor-fleet/base-distroless
	actor-fleet/rivet-runtime
	actor-fleet/base-tencentcloud-cli
	actor-fleet/release-hook
	actor-fleet/argocd
	actor-fleet/argocd-dex
	actor-fleet/argocd-haproxy
	actor-fleet/argocd-redis
	actor-fleet/git-service
	actor-fleet/fdb-kubernetes-monitor
	actor-fleet/fdb-kubernetes-operator
	actor-fleet/nats
	actor-fleet/runtime-base
	actor-fleet/worker-registry
	actor-fleet/workers-api
	actor-fleet/observability-busybox
	actor-fleet/observability-grafana
	actor-fleet/observability-k8s-sidecar
	actor-fleet/observability-kube-state-metrics
	actor-fleet/observability-kubectl
	actor-fleet/observability-prometheus
	actor-fleet/observability-prometheus-adapter
	actor-fleet/observability-prometheus-config-reloader
	actor-fleet/observability-prometheus-operator
	actor-fleet/observability-webhook-certgen
)

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
[[ $registry_id =~ ^tcr-[a-z0-9]+$ ]]
[[ $cluster_id == cls-ike1rebd ]] || { echo "registry installation is bound to q01 cluster cls-ike1rebd" >&2; exit 2; }
[[ $registry_host =~ ^[a-z0-9.-]+\.tencentcloudcr\.com$ ]]
[[ $remote_config == /var/lib/actor-build/credentials/* ]]
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/tcr.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
chmod 0700 "$temporary"

# Image distribution must stay on the Beijing VPC. Validate the exact live
# cluster identity and TCR attachment rather than assuming the shared registry
# hostname will resolve privately.
"$tccli" tke DescribeClusters --region "$region" --ClusterIds "[\"$cluster_id\"]" >"$temporary/cluster.json"
vpc_id=$(jq -er --arg id "$cluster_id" '.Clusters | select(length == 1) | .[0] | select(.ClusterId == $id and .ClusterStatus == "Running") | .ClusterNetworkSettings.VpcId' "$temporary/cluster.json")
"$tccli" tcr DescribeInternalEndpoints --region "$region" --RegistryId "$registry_id" >"$temporary/tcr-endpoints.json"
access_ip=$(jq -er --arg vpc "$vpc_id" '[.AccessVpcSet[] | select(.VpcId == $vpc and .Status == "Running") | .AccessIp] | select(length == 1) | .[0]' "$temporary/tcr-endpoints.json")
python3 - "$access_ip" <<'PY'
import ipaddress,sys
address=ipaddress.ip_address(sys.argv[1])
if not address.is_private:
    raise SystemExit("TCR VPC endpoint is not private")
PY

# An instance token's effective repository inventory is fixed when the token is
# created. Creating a repository afterwards can leave an apparently valid
# long-term token unable to push it. Fail closed until every production build
# and workload repository exists and is private, then create exactly one token.
"$tccli" tcr DescribeRepositories --region "$region" \
	--RegistryId "$registry_id" --NamespaceName actor-fleet --Limit 100 \
	>"$temporary/repositories.json"
for repository in "${required_repositories[@]}"; do
	jq -e --arg name "$repository" \
		'[.RepositoryList[] | select(.Name == $name and .Public == false)] | length == 1' \
		"$temporary/repositories.json" >/dev/null || {
		echo "required private TCR repository is absent: $repository" >&2
		exit 1
	}
done

"$tccli" tcr DescribeInstanceToken --region "$region" \
	--RegistryId "$registry_id" --Limit 100 --Offset 0 >"$temporary/cloud-tokens.json"
if [[ -f $credential_file ]]; then
	[[ $(stat -c '%a' "$credential_file") == 600 ]] || {
		echo "saved q01 TCR credential must have mode 0600" >&2
		exit 1
	}
	token_id=$(jq -er '.TokenId | select(length > 0)' "$credential_file")
	jq -e --arg id "$token_id" --arg description "$token_description" \
		'[.Tokens[] | select((.Id // .TokenId) == $id and .Desc == $description and .Enabled == true)] | length == 1' \
		"$temporary/cloud-tokens.json" >/dev/null || {
		echo "saved q01 TCR credential is not the enabled cloud token" >&2
		exit 1
	}
else
	if jq -e --arg description "$token_description" \
		'.Tokens[] | select(.Desc == $description)' "$temporary/cloud-tokens.json" >/dev/null; then
		echo "q01 long-term TCR token exists but its protected local credential is missing" >&2
		exit 1
	fi
	"$tccli" tcr CreateInstanceToken --region "$region" \
		--RegistryId "$registry_id" --TokenType longterm \
		--Desc "$token_description" >"$temporary/created-token.json"
	install -m 0600 "$temporary/created-token.json" "$credential_file"
fi
jq -e '.Username | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e '.Token | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e '.TokenId | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e --argjson minimum "$(( ($(date +%s) + 31536000) * 1000 ))" \
	'.ExpTime | type == "number" and . > $minimum' "$credential_file" >/dev/null
username=$(jq -r '.Username' "$credential_file")
token=$(jq -r '.Token' "$credential_file")
token_id=$(jq -r '.TokenId' "$credential_file")
auth=$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')
jq -n --arg host "$registry_host" --arg auth "$auth" \
	'{auths:{($host):{auth:$auth}}}' >"$temporary/config.json"
chmod 0600 "$temporary/config.json"

TAT_UPLOAD_OVERWRITE=1 TAT_UPLOAD_MODE=0600 \
	"$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_config"
printf -v quoted_remote '%q' "$remote_config"
printf -v quoted_registry_host '%q' "$registry_host"
printf -v quoted_access_ip '%q' "$access_ip"
namespace_words=$(printf ' %q' "${namespaces[@]}")
"$fleet_dir/tat/tat-run.sh" --name q01-install-private-registry --timeout 300 <<REMOTE
set -euo pipefail
export KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig
config=$quoted_remote
test "\$(stat -c '%a' "\$config")" = 600
getent ahostsv4 $quoted_registry_host | awk '{print \$1}' | grep -Fx $quoted_access_ip >/dev/null
for namespace in$namespace_words; do
  kubectl get namespace "\$namespace" >/dev/null
  merged=\$(mktemp)
  manifest=\$(mktemp)
  if kubectl -n "\$namespace" get secret actor-fleet-tcr >/dev/null 2>&1; then
    existing=\$(mktemp)
    kubectl -n "\$namespace" get secret actor-fleet-tcr -o jsonpath='{.data.\.dockerconfigjson}' | base64 --decode >"\$existing"
    jq -s '{auths:((.[0].auths // {}) + (.[1].auths // {}))}' "\$existing" "\$config" >"\$merged"
    rm -f -- "\$existing"
  else
    install -m 0600 "\$config" "\$merged"
  fi
  kubectl -n "\$namespace" create secret generic actor-fleet-tcr \
    --type=kubernetes.io/dockerconfigjson \
    --from-file=.dockerconfigjson="\$merged" --dry-run=client -o json >"\$manifest"
  if kubectl -n "\$namespace" get secret actor-fleet-tcr >/dev/null 2>&1; then
    kubectl -n "\$namespace" replace -f "\$manifest" >/dev/null
  else
    kubectl -n "\$namespace" create -f "\$manifest" >/dev/null
  fi
  rm -f -- "\$manifest" "\$merged"
  kubectl -n "\$namespace" get secret actor-fleet-tcr \
    -o jsonpath='{.type}' | grep -qx kubernetes.io/dockerconfigjson
  kubectl -n "\$namespace" get secret actor-fleet-tcr -o jsonpath='{.data.\.dockerconfigjson}' | \
    base64 --decode | jq -e --arg host $quoted_registry_host '.auths[\$host].auth | type == "string" and length > 0' >/dev/null
done
REMOTE

jq -n --arg registry "$registry_host" --arg token_id "$token_id" --arg cluster_id "$cluster_id" \
	--arg vpc_id "$vpc_id" --arg access_ip "$access_ip" \
	--argjson expires "$(jq '.ExpTime' "$credential_file")" \
	'{verdict:"installed",registry:$registry,cluster_id:$cluster_id,vpc_id:$vpc_id,private_access_ip:$access_ip,token_type:"longterm",token_id:$token_id,expires_at:$expires,secret:"actor-fleet-tcr"}' \
	>"$state_dir/tcr-install-receipt.json"
chmod 0600 "$state_dir/tcr-install-receipt.json"
jq . "$state_dir/tcr-install-receipt.json"
