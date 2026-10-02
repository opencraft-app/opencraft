#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
registry_id=${ACTOR_TCR_REGISTRY_ID:?ACTOR_TCR_REGISTRY_ID is required}
registry_host=${ACTOR_TCR_HOST:?ACTOR_TCR_HOST is required}
remote_source=${ACTOR_REMOTE_SOURCE_DIR:?ACTOR_REMOTE_SOURCE_DIR is required}
state_dir=${ACTOR_BUILD_STATE_DIR:-/data/actor-build/workers-api}
build_base=${WORKERS_API_BUILD_BASE:?WORKERS_API_BUILD_BASE must pin base-golang}
runtime_base=${WORKERS_API_RUNTIME_BASE:?WORKERS_API_RUNTIME_BASE must pin base-distroless}
build_python=${ACTOR_BUILD_PYTHON:-python3.11}

usage() {
	echo "Usage: build-image-via-tat.sh SOURCE_REVISION SOURCE_MANIFEST_SHA256 IMAGE_TAG LOCAL_RECEIPT" >&2
}
[[ $# -eq 4 ]] || { usage; exit 2; }
source_revision=$1
source_manifest_sha=$2
image_tag=$3
local_receipt=$4

for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done
[[ $source_revision =~ ^[0-9a-f]{40}$ ]]
[[ $source_manifest_sha =~ ^[0-9a-f]{64}$ ]]
[[ $registry_id =~ ^tcr-[a-z0-9]+$ ]]
[[ $registry_host =~ ^[a-z0-9.-]+\.tencentcloudcr\.com$ ]]
[[ $remote_source == /* && $remote_source != / && $remote_source != *$'\n'* ]]
[[ $state_dir == /data/* && $state_dir != *$'\n'* ]]
[[ $local_receipt == /data/* && ! -e $local_receipt ]]
[[ $build_base =~ ^${registry_host//./\.}/actor-fleet/base-golang@sha256:[0-9a-f]{64}$ ]]
[[ $runtime_base =~ ^${registry_host//./\.}/actor-fleet/base-distroless@sha256:[0-9a-f]{64}$ ]]
[[ $image_tag =~ ^${registry_host//./\.}/actor-fleet/workers-api:[A-Za-z0-9._-]+$ ]]

install -d -m 0700 "$state_dir" "$(dirname -- "$local_receipt")"
temporary=$(mktemp -d "$state_dir/token.XXXXXX")
chmod 0700 "$temporary"
remote_auth=
cleanup() {
	rm -rf -- "$temporary"
	if [[ -n $remote_auth ]]; then
		printf -v quoted_remote '%q' "$remote_auth"
		"$fleet_dir/tat/tat-run.sh" --name remove-workers-api-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null 2>&1 || true
set -euo pipefail
rm -f -- $quoted_remote
REMOTE_CLEANUP
	fi
}
trap cleanup EXIT INT TERM

"$tccli" tcr CreateInstanceToken --region "$region" \
	--RegistryId "$registry_id" --TokenType temp \
	--Desc "workers-api-build-${source_revision:0:12}" >"$temporary/token.json"
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
remote_auth="$state_dir/tcr-build-${request_id}.json"
TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_auth" >/dev/null

remote_receipt="$state_dir/product-workers-api-${source_revision}-${source_manifest_sha}.json"
for value in remote_source source_revision source_manifest_sha image_tag registry_host remote_auth build_base runtime_base build_python remote_receipt; do
	printf -v "quoted_$value" '%q' "${!value}"
done
set +e
"$fleet_dir/tat/tat-run.sh" --name build-workers-api --timeout 3600 <<REMOTE_BUILD
set -euo pipefail
auth=$quoted_remote_auth
trap 'rm -f -- "\$auth"' EXIT INT TERM
test "\$(stat -c '%a' "\$auth")" = 600
source=\$(readlink -e $quoted_remote_source)
test "\$(tr -d '[:space:]' <"\$source/.actor-source/SOURCE_REVISION")" = $quoted_source_revision
test "\$(sha256sum "\$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)" = $quoted_source_manifest_sha
getent ahostsv4 $quoted_registry_host | awk '{print \$1}' | grep -Eq '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'
test ! -e $quoted_remote_receipt
export ACTOR_SOURCE_DIR="\$source"
export WORKERS_API_IMAGE_TAG=$quoted_image_tag
export WORKERS_API_BUILD_BASE=$quoted_build_base
export WORKERS_API_RUNTIME_BASE=$quoted_runtime_base
export ACTOR_PRODUCT_BUILD_RECEIPT=$quoted_remote_receipt
export PYTHON=$quoted_build_python
export REGISTRY_AUTH_FILE="\$auth"
export ACTOR_BUILD_TMPDIR=/data/tmp
install -d -m 0700 $state_dir /data/tmp
"\$PYTHON" -c 'import sys; assert sys.version_info >= (3, 11)'
"\$source/infra/cells/deploy/tencent/fleet/workers-api/build-image.sh"
REMOTE_BUILD
status=$?
set -e

printf -v quoted_remote '%q' "$remote_auth"
"$fleet_dir/tat/tat-run.sh" --name remove-workers-api-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null
set -euo pipefail
rm -f -- $quoted_remote
test ! -e $quoted_remote
REMOTE_CLEANUP
remote_auth=
((status == 0)) || exit "$status"

"$fleet_dir/tat/tat-download.sh" "$remote_receipt" "$local_receipt"
"$build_python" "$fleet_dir/gitops/image-seed/product-lock.py" validate --receipt "$local_receipt"
