#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
cluster_id=${QUALIFICATION_CLUSTER_ID:?QUALIFICATION_CLUSTER_ID is required}
remote_file=${QUALIFICATION_REMOTE_KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
temporary=$(mktemp -d /data/actor-bj-q01-kubeconfig.XXXXXX)
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT

"$tccli" tke DescribeClusterEndpoints --region "$region" --ClusterId "$cluster_id" \
	>"$temporary/endpoints.json"
endpoint=$(jq -er '.ClusterIntranetEndpoint | select(. != "")' "$temporary/endpoints.json")
"$tccli" tke DescribeClusterKubeconfig --region "$region" \
	--ClusterId "$cluster_id" --IsExtranet false >"$temporary/response.json"
jq -er '.Kubeconfig | select(length > 0)' "$temporary/response.json" >"$temporary/kubeconfig"
chmod 0600 "$temporary/kubeconfig"
server=$(kubectl --kubeconfig "$temporary/kubeconfig" config view --raw --minify -o jsonpath='{.clusters[0].cluster.server}')
[[ $server == "https://$endpoint" || $server == "https://$endpoint:"* ]] || {
	echo "private kubeconfig server does not match the private endpoint" >&2
	exit 1
}

PATH="$(dirname -- "$tccli"):$PATH" \
	TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/kubeconfig" "$remote_file"
printf 'private kubeconfig installed on builder for %s\n' "$cluster_id"
