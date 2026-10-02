#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
request=$script_dir/cluster-request.json
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
cluster_name=$(jq -er '.ClusterBasicSettings.ClusterName' "$request")
vpc_id=$(jq -er '.ClusterBasicSettings.VpcId' "$request")

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
command -v "$tccli" >/dev/null
command -v jq >/dev/null
mkdir -p "$state_dir"
chmod 0700 "$state_dir"

existing=$(
	"$tccli" tke DescribeClusters --region "$region" \
		--Limit 100 --Filters "[{\"Name\":\"ClusterName\",\"Values\":[\"$cluster_name\"]}]"
)
count=$(jq -r --arg name "$cluster_name" '[.Clusters[] | select(.ClusterName == $name)] | length' <<<"$existing")
if ((count > 1)); then
	echo "more than one cluster has the exact qualification name" >&2
	exit 1
fi
if ((count == 1)); then
	jq -e --arg name "$cluster_name" '.Clusters[] | select(.ClusterName == $name)' <<<"$existing" \
		>"$state_dir/cluster.json"
	chmod 0600 "$state_dir/cluster.json"
	echo "qualification cluster already exists; refusing a second create" >&2
	jq '{ClusterId,ClusterName,ClusterStatus,CreatedTime}' "$state_dir/cluster.json"
	exit 0
fi

while IFS= read -r cidr; do
	conflict=$(
		"$tccli" tke DescribeRouteTableConflicts --region "$region" \
			--VpcId "$vpc_id" --RouteTableCidrBlock "$cidr"
	)
	if [[ $(jq -r '.HasConflict' <<<"$conflict") != false ]]; then
		echo "CIDR has a VPC route-table conflict: $cidr" >&2
		exit 1
	fi
done < <(jq -r '.ClusterCIDRSettings | .ClusterCIDR, .ServiceCIDR' "$request")

response=$(
	"$tccli" tke CreateCluster --region "$region" \
		--cli-input-json "file://$request"
)
cluster_id=$(jq -er '.ClusterId | select(test("^cls-[a-z0-9]+$"))' <<<"$response")
jq -n --arg cluster_id "$cluster_id" --arg cluster_name "$cluster_name" \
	'{ClusterId:$cluster_id,ClusterName:$cluster_name}' >"$state_dir/cluster-create.json"
chmod 0600 "$state_dir/cluster-create.json"
printf '%s\n' "$cluster_id"
