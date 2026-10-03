#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
registry_id=${QUALIFICATION_TCR_REGISTRY_ID:-tcr-g7ax6o7q}
registry_host=${QUALIFICATION_TCR_HOST:-lightclaw-bj82.tencentcloudcr.com}
source_link=${QUALIFICATION_SOURCE_LINK:-/var/lib/actor-build/deploy/actor-bj-q01-current}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
build_base=${ACTOR_FLEET_BUILD_BASE:?ACTOR_FLEET_BUILD_BASE must pin the regional base-golang image}
runtime_base=${ACTOR_FLEET_RUNTIME_BASE:?ACTOR_FLEET_RUNTIME_BASE must pin the regional base-distroless image}
build_python=${ACTOR_BUILD_PYTHON:-python3.11}

usage() {
	echo "Usage: build-controller-via-tat.sh SOURCE_REVISION SOURCE_MANIFEST_SHA256 IMAGE_TAG" >&2
}
[[ $# -eq 3 ]] || { usage; exit 2; }
source_revision=$1
source_manifest_sha=$2
image_tag=$3

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done
[[ $source_revision =~ ^[0-9a-f]{40}$ ]]
[[ $source_manifest_sha =~ ^[0-9a-f]{64}$ ]]
[[ $registry_id =~ ^tcr-[a-z0-9]+$ ]]
[[ $registry_host =~ ^[a-z0-9.-]+\.tencentcloudcr\.com$ ]]
[[ $build_base =~ ^${registry_host//./\.}/actor-fleet/base-golang@sha256:[0-9a-f]{64}$ ]]
[[ $runtime_base =~ ^${registry_host//./\.}/actor-fleet/base-distroless@sha256:[0-9a-f]{64}$ ]]
[[ $build_python =~ ^/[-A-Za-z0-9._/]+$ || $build_python =~ ^[A-Za-z0-9._-]+$ ]]
[[ $image_tag =~ ^${registry_host//./\.}/actor-fleet/actor-fleet-controller:[A-Za-z0-9._-]+$ ]]
[[ $source_link == /var/lib/actor-build/deploy/actor-bj-q01-current ||
   $source_link == "/var/lib/actor-build/deploy/q01-src-${source_revision}-${source_manifest_sha}" ||
   $source_link == "/data/actor-build/deploy/controller-src-${source_revision}-${source_manifest_sha}" ]] || {
	echo "controller build source must be the reviewed current link or exact immutable source" >&2
	exit 2
}

install -d -m 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/tcr-build.XXXXXX")
chmod 0700 "$temporary"
remote_auth=
cleanup() {
	rm -rf -- "$temporary"
	if [[ -n $remote_auth ]]; then
		printf -v quoted_remote '%q' "$remote_auth"
		"$fleet_dir/tat/tat-run.sh" --name q01-remove-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null 2>&1 || true
set -euo pipefail
rm -f -- $quoted_remote
REMOTE_CLEANUP
	fi
}
trap cleanup EXIT INT TERM

# The long-lived actor-fleet-tcr Secret is pull-only operational state. Build
# push authority is minted per operation, never copied into Kubernetes, and
# expires even if both cleanup paths fail.
"$tccli" tcr CreateInstanceToken --region "$region" \
	--RegistryId "$registry_id" --TokenType temp \
	--Desc "actor-bj-q01-controller-build-${source_revision:0:12}" \
	>"$temporary/token.json"
jq -e '.Username | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e '.Token | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e --argjson minimum "$(( ($(date +%s) + 1200) * 1000 ))" \
	'.ExpTime | type == "number" and . > $minimum' "$temporary/token.json" >/dev/null
request_id=$(jq -er '.RequestId | select(test("^[0-9a-f-]{36}$"))' "$temporary/token.json")
username=$(jq -r '.Username' "$temporary/token.json")
token=$(jq -r '.Token' "$temporary/token.json")
auth=$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')
jq -n --arg host "$registry_host" --arg auth "$auth" \
	'{auths:{($host):{auth:$auth}}}' >"$temporary/config.json"
chmod 0600 "$temporary/config.json"
remote_auth=/data/actor-build/credentials/controller-build-${request_id}.json
TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_auth" >/dev/null

printf -v quoted_source_link '%q' "$source_link"
printf -v quoted_revision '%q' "$source_revision"
printf -v quoted_manifest '%q' "$source_manifest_sha"
printf -v quoted_image '%q' "$image_tag"
printf -v quoted_registry '%q' "$registry_host"
printf -v quoted_remote '%q' "$remote_auth"
printf -v quoted_build_base '%q' "$build_base"
printf -v quoted_runtime_base '%q' "$runtime_base"
printf -v quoted_python '%q' "$build_python"
product_receipt=/data/actor-build/product-receipts/actor-fleet-controller-${source_revision}-${source_manifest_sha}.json
printf -v quoted_product_receipt '%q' "$product_receipt"
set +e
"$fleet_dir/tat/tat-run.sh" --name q01-build-controller --timeout 3600 <<REMOTE_BUILD
set -euo pipefail
auth=$quoted_remote
trap 'rm -f -- "\$auth"' EXIT INT TERM
test "\$(stat -c '%a' "\$auth")" = 600
source=\$(readlink -e $quoted_source_link)
test "\$(tr -d '[:space:]' <"\$source/.actor-source/SOURCE_REVISION")" = $quoted_revision
test "\$(sha256sum "\$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)" = $quoted_manifest
getent ahostsv4 $quoted_registry | awk '{print \$1}' | grep -Eq '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'
export ACTOR_SOURCE_DIR="\$source"
export ACTOR_FLEET_CONTROLLER_IMAGE_TAG=$quoted_image
export ACTOR_FLEET_BUILD_BASE=$quoted_build_base
export ACTOR_FLEET_RUNTIME_BASE=$quoted_runtime_base
export ACTOR_PRODUCT_BUILD_RECEIPT=$quoted_product_receipt
export PYTHON=$quoted_python
export REGISTRY_AUTH_FILE="\$auth"
export ACTOR_BUILD_TMPDIR=/data/tmp
install -d -m 0700 /data/actor-build/product-receipts
command -v "\$PYTHON" >/dev/null
"\$PYTHON" -c 'import sys; assert sys.version_info >= (3, 11)'
"\$source/infra/cells/deploy/tencent/fleet/controller/build-image.sh"
REMOTE_BUILD
status=$?
set -e

# The remote trap is the primary deletion path. Run a second exact cleanup so
# an agent/API interruption cannot leave even a one-hour token file on disk.
printf -v quoted_remote '%q' "$remote_auth"
"$fleet_dir/tat/tat-run.sh" --name q01-remove-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null
set -euo pipefail
rm -f -- $quoted_remote
test ! -e $quoted_remote
REMOTE_CLEANUP
remote_auth=
exit "$status"
