#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
terraform_bin=${TERRAFORM:-terraform}
plugin_cache=${TF_PLUGIN_CACHE_DIR:-/data/build-cache/terraform-plugin-cache}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
[[ -n ${QUALIFICATION_CLUSTER_ID:-} ]] || {
	echo "QUALIFICATION_CLUSTER_ID must name the reviewed existing q01 cluster" >&2
	exit 2
}
[[ $QUALIFICATION_CLUSTER_ID =~ ^cls-[a-z0-9]+$ ]] || {
	echo "QUALIFICATION_CLUSTER_ID is not a Tencent TKE cluster ID" >&2
	exit 2
}

mkdir -p "$plugin_cache"
mkdir -p "$state_dir"
export TF_PLUGIN_CACHE_DIR=$plugin_cache

tf() { "$terraform_bin" -chdir="$script_dir" "$@"; }
import_if_absent() {
	local address=$1 id=$2
	if tf state show "$address" >/dev/null 2>&1; then
		return
	fi
	tf import -var="cluster_id=$QUALIFICATION_CLUSTER_ID" "$address" "$id"
}

tf init
import_if_absent tencentcloud_kubernetes_cluster.qualification "$QUALIFICATION_CLUSTER_ID"
import_if_absent 'tencentcloud_tcr_vpc_attachment.qualification["bootstrap"]' \
	"tcr-g7ax6o7q#vpc-6c2snz3a#subnet-qljvksy9"
import_if_absent 'tencentcloud_tcr_vpc_attachment.qualification["release"]' \
	"tcr-q9w0spg4#vpc-6c2snz3a#subnet-qljvksy9"
import_if_absent 'tencentcloud_cos_bucket.storage["cold"]' actor-depot-cold-prod-bj-q01-nv1-1388575217
import_if_absent 'tencentcloud_cos_bucket.storage["backup"]' actor-fdb-backup-prod-bj-q01-nv1-1388575217
import_if_absent 'tencentcloud_cos_bucket.storage["code"]' actor-worker-code-qual-bj-q01-nv1-1388575217

# Import is not approval to mutate. A non-empty plan must be reviewed against
# the original tccli request and the live q01 inventory before apply.
tf plan -var="cluster_id=$QUALIFICATION_CLUSTER_ID" -out="$state_dir/q01-import.plan"
