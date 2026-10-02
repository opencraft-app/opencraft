#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_BOOTSTRAP_ROLE:?set ACTOR_BOOTSTRAP_ROLE to management or cell}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_STATE_DIR:?set ACTOR_PULL_CREDENTIAL_STATE_DIR}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${TENCENTCLOUD_SECRET_ID:?set TENCENTCLOUD_SECRET_ID through the protected environment}"
: "${TENCENTCLOUD_SECRET_KEY:?set TENCENTCLOUD_SECRET_KEY through the protected environment}"
tccli=${TCCLI:-tccli}
python=${ACTOR_BOOTSTRAP_PYTHON:-}
if [[ -z $python ]]; then
	if [[ -x /usr/local/qcloud/python/bin/python3.7 ]]; then python=/usr/local/qcloud/python/bin/python3.7; else python=python3; fi
fi

for command in "$tccli" kubectl jq "$python" sha256sum base64 getent stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_STATE_DIR" \
	"$ACTOR_PULL_CREDENTIAL_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "bootstrap paths must be absolute and non-root" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" "$ACTOR_CLUSTER_KUBECONFIG"; do
	[[ -f $path && ! -L $path ]] || { echo "bootstrap input must be a regular non-symlink file: $path" >&2; exit 2; }
done
if (( (8#$(stat -c '%a' "$ACTOR_CLUSTER_KUBECONFIG") & 8#077) != 0 )); then
	echo "Cell kubeconfig must not be group/world accessible" >&2
	exit 2
fi
[[ -d $(dirname -- "$ACTOR_PULL_CREDENTIAL_STATE_DIR") ]] || {
	echo "pull credential state parent must already exist" >&2
	exit 2
}
[[ -d $(dirname -- "$ACTOR_PULL_CREDENTIAL_RECEIPT") ]] || {
	echo "pull credential receipt parent must already exist" >&2
	exit 2
}
[[ ! -L $ACTOR_PULL_CREDENTIAL_STATE_DIR ]] || { echo "credential state directory may not be a symlink" >&2; exit 2; }
install -d -m 0700 "$ACTOR_PULL_CREDENTIAL_STATE_DIR"

temporary=$(mktemp -d "$ACTOR_PULL_CREDENTIAL_STATE_DIR/.pull-bootstrap.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

"$python" "$script_dir/validate-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" \
	--images "$ACTOR_IMAGE_INVENTORY" \
	--role "$ACTOR_BOOTSTRAP_ROLE" >"$temporary/plan.json"

identity=$(jq -er '.identity' "$temporary/plan.json")
region=$(jq -er '.region' "$temporary/plan.json")
cluster_id=$(jq -er '.clusterId' "$temporary/plan.json")
vpc_id=$(jq -er '.vpcId' "$temporary/plan.json")
registry_id=$(jq -er '.registryId' "$temporary/plan.json")
registry_host=$(jq -er '.registryHost' "$temporary/plan.json")
registry_namespace=$(jq -er '.registryNamespace' "$temporary/plan.json")
registry_access_ip=$(jq -er '.registryAccessIp' "$temporary/plan.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/plan.json")
# A rebuilt cluster may reuse the Cell name, but not its cloud identity.
token_description="${identity}-${cluster_id}-image-pull-v1"
credential_file="$ACTOR_PULL_CREDENTIAL_STATE_DIR/${identity}-tcr-pull-v1.json"

"$tccli" tke DescribeClusters --region "$region" --ClusterIds "[\"$cluster_id\"]" \
	>"$temporary/cluster.json"
live_vpc=$(jq -er --arg id "$cluster_id" \
	'.Clusters | select(length == 1) | .[0] | select(.ClusterId == $id and .ClusterStatus == "Running") | .ClusterNetworkSettings.VpcId' \
	"$temporary/cluster.json")
[[ $live_vpc == "$vpc_id" ]] || { echo "live TKE VPC differs from Terraform inventory" >&2; exit 1; }

"$tccli" tcr DescribeInternalEndpoints --region "$region" --RegistryId "$registry_id" \
	>"$temporary/tcr-endpoints.json"
live_access_ip=$(jq -er --arg vpc "$vpc_id" \
	'[.AccessVpcSet[] | select(.VpcId == $vpc and .Status == "Running") | .AccessIp] | select(length == 1) | .[0]' \
	"$temporary/tcr-endpoints.json")
[[ $live_access_ip == "$registry_access_ip" ]] || {
	echo "live TCR VPC attachment differs from Terraform inventory" >&2
	exit 1
}
getent ahostsv4 "$registry_host" | awk '{print $1}' | grep -Fx "$registry_access_ip" >/dev/null || {
	echo "registry hostname does not resolve to the inventory's private TCR endpoint" >&2
	exit 1
}

"$tccli" tcr DescribeRepositories --region "$region" --RegistryId "$registry_id" \
	--NamespaceName "$registry_namespace" --Limit 100 >"$temporary/repositories.json"
"$python" - "$ACTOR_IMAGE_INVENTORY" "$temporary/repositories.json" <<'PY'
import json,sys
images=json.load(open(sys.argv[1]))["images"]
repositories=json.load(open(sys.argv[2])).get("RepositoryList",[])
live={item.get("Name") for item in repositories if item.get("Public") is False}
expected={f'{json.load(open(sys.argv[1]))["namespace"]}/{item["repository"]}' for item in images}
missing=sorted(expected-live)
if missing:
    raise SystemExit("private TCR repositories are absent: " + ", ".join(missing))
PY

"$tccli" tcr DescribeInstanceToken --region "$region" --RegistryId "$registry_id" \
	--Limit 100 --Offset 0 >"$temporary/cloud-tokens.json"
if [[ -f $credential_file && ! -L $credential_file ]]; then
	[[ $(stat -c '%a' "$credential_file") == 600 ]] || {
		echo "saved TCR pull credential must have mode 0600" >&2
		exit 1
	}
	token_id=$(jq -er '.TokenId | select(type == "string" and length > 0)' "$credential_file")
	jq -e --arg id "$token_id" --arg description "$token_description" \
		'[.Tokens[] | select((.Id // .TokenId) == $id and .Desc == $description and .Enabled == true)] | length == 1' \
		"$temporary/cloud-tokens.json" >/dev/null || {
		echo "saved TCR pull credential is not the exact enabled cloud token" >&2
		exit 1
	}
elif [[ -e $credential_file ]]; then
	echo "TCR credential path is not a regular file" >&2
	exit 1
else
	if jq -e --arg description "$token_description" \
		'.Tokens[] | select(.Desc == $description)' "$temporary/cloud-tokens.json" >/dev/null; then
		echo "cloud TCR token exists but its protected local credential is missing" >&2
		exit 1
	fi
	"$tccli" tcr CreateInstanceToken --region "$region" --RegistryId "$registry_id" \
		--TokenType longterm --Desc "$token_description" >"$temporary/created-token.json"
	chmod 0600 "$temporary/created-token.json"
	mv "$temporary/created-token.json" "$credential_file"
fi

jq -e '.Username | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e '.Token | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e '.TokenId | type == "string" and length > 0' "$credential_file" >/dev/null
jq -e --argjson minimum "$(( ($(date +%s) + 31536000) * 1000 ))" \
	'.ExpTime | type == "number" and . > $minimum' "$credential_file" >/dev/null
username=$(jq -r '.Username' "$credential_file")
token=$(jq -r '.Token' "$credential_file")
token_id=$(jq -r '.TokenId' "$credential_file")
expires_at=$(jq -r '.ExpTime' "$credential_file")
auth=$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')
jq -n --arg host "$registry_host" --arg auth "$auth" \
	'{auths:{($host):{auth:$auth}}}' >"$temporary/docker-config.json"
chmod 0600 "$temporary/docker-config.json"

kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")
cluster_uid=$("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
[[ -n $cluster_uid ]] || { echo "target Kubernetes cluster UID is empty" >&2; exit 1; }
namespace_records=()
while IFS= read -r namespace; do
	"${kube[@]}" create namespace "$namespace" --dry-run=client -o json | \
		jq --arg role "$ACTOR_BOOTSTRAP_ROLE" \
			'.metadata.labels += {"fleet.actor.dev/bootstrap-role":$role,"app.kubernetes.io/managed-by":"actor-create-first"}' | \
		"${kube[@]}" apply --server-side --field-manager=actor-create-first-bootstrap -f - >/dev/null
	"${kube[@]}" -n "$namespace" create secret generic actor-fleet-tcr \
		--type=kubernetes.io/dockerconfigjson \
		--from-file=.dockerconfigjson="$temporary/docker-config.json" \
		--dry-run=client -o json >"$temporary/$namespace.desired.json"
	if "${kube[@]}" -n "$namespace" get secret actor-fleet-tcr -o json \
		>"$temporary/$namespace.live.json" 2>/dev/null; then
		jq -S '{type,data}' "$temporary/$namespace.desired.json" >"$temporary/desired-projection.json"
		jq -S '{type,data}' "$temporary/$namespace.live.json" >"$temporary/live-projection.json"
		cmp -s "$temporary/desired-projection.json" "$temporary/live-projection.json" || {
			echo "existing pull Secret differs: $namespace/actor-fleet-tcr" >&2
			exit 1
		}
	else
		"${kube[@]}" create -f "$temporary/$namespace.desired.json" >/dev/null
		"${kube[@]}" -n "$namespace" get secret actor-fleet-tcr -o json \
			>"$temporary/$namespace.live.json"
	fi
	namespace_uid=$("${kube[@]}" get namespace "$namespace" -o jsonpath='{.metadata.uid}')
	secret_uid=$(jq -er '.metadata.uid' "$temporary/$namespace.live.json")
	namespace_records+=("$(jq -cn --arg name "$namespace" --arg namespace_uid "$namespace_uid" \
		--arg secret_uid "$secret_uid" '{name:$name,namespaceUid:$namespace_uid,secretUid:$secret_uid}')")
done < <(jq -r '.namespaces[]' "$temporary/plan.json")

records=$(printf '%s\n' "${namespace_records[@]}" | jq -sc 'sort_by(.name)')
receipt_temporary="$temporary/receipt.json"
jq -cn --arg role "$ACTOR_BOOTSTRAP_ROLE" --arg identity "$identity" \
	--arg cluster_id "$cluster_id" --arg cluster_uid "$cluster_uid" --arg vpc_id "$vpc_id" \
	--arg registry_id "$registry_id" --arg registry_host "$registry_host" \
	--arg access_ip "$registry_access_ip" --arg inventory_digest "$image_inventory_digest" \
	--arg token_id "$token_id" --argjson expires_at "$expires_at" --argjson namespaces "$records" \
	'{schema:"actor-create-first-pull-bootstrap/v1",verdict:"passed",role:$role,identity:$identity,
      cluster:{id:$cluster_id,uid:$cluster_uid,vpcId:$vpc_id},
      registry:{id:$registry_id,host:$registry_host,privateAccessIp:$access_ip,
        tokenId:$token_id,expiresAt:$expires_at},imageInventoryDigest:$inventory_digest,namespaces:$namespaces}' \
	>"$receipt_temporary"

if [[ -e $ACTOR_PULL_CREDENTIAL_RECEIPT ]]; then
	[[ -f $ACTOR_PULL_CREDENTIAL_RECEIPT && ! -L $ACTOR_PULL_CREDENTIAL_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_PULL_CREDENTIAL_RECEIPT" || {
		echo "pull credential receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt_temporary" "$ACTOR_PULL_CREDENTIAL_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_PULL_CREDENTIAL_RECEIPT && ! -L $ACTOR_PULL_CREDENTIAL_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_PULL_CREDENTIAL_RECEIPT" || {
		echo "unable to publish immutable pull credential receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_PULL_CREDENTIAL_RECEIPT"
printf 'pull_bootstrap=passed role=%s identity=%s receipt=%s sha256=%s\n' \
	"$ACTOR_BOOTSTRAP_ROLE" "$identity" "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	"$(sha256sum "$ACTOR_PULL_CREDENTIAL_RECEIPT" | cut -d' ' -f1)"
