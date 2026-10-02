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
bootstrap_base=${ACTOR_FLEET_BOOTSTRAP_BASE:?ACTOR_FLEET_BOOTSTRAP_BASE must pin the regional base-golang bootstrap image}

usage() {
	echo "Usage: build-controller-dependency-base-via-tat.sh SOURCE_REVISION SOURCE_MANIFEST_SHA256 IMAGE_TAG" >&2
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
[[ $image_tag =~ ^${registry_host//./\.}/actor-fleet/base-golang:[A-Za-z0-9._-]+$ ]]
[[ $bootstrap_base =~ ^${registry_host//./\.}/actor-fleet/base-golang@sha256:[0-9a-f]{64}$ ]]
[[ $source_link == /var/lib/actor-build/deploy/actor-bj-q01-current ||
   $source_link == "/var/lib/actor-build/deploy/q01-src-${source_revision}-${source_manifest_sha}" ]] || {
	echo "dependency-base source must be the reviewed current link or exact immutable source" >&2
	exit 2
}

install -d -m 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/tcr-dependency-base.XXXXXX")
chmod 0700 "$temporary"
remote_auth=
cleanup() {
	rm -rf -- "$temporary"
	if [[ -n $remote_auth ]]; then
		printf -v quoted_remote '%q' "$remote_auth"
		"$fleet_dir/tat/tat-run.sh" --name q01-remove-dependency-base-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null 2>&1 || true
set -euo pipefail
rm -f -- $quoted_remote
REMOTE_CLEANUP
	fi
}
trap cleanup EXIT INT TERM

# Dependency-base pushes use an operation-scoped token.  The long-lived
# Kubernetes pull Secret never receives repository write authority.
"$tccli" tcr CreateInstanceToken --region "$region" \
	--RegistryId "$registry_id" --TokenType temp \
	--Desc "actor-bj-q01-dependency-base-${source_revision:0:12}" \
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
remote_auth=/var/lib/actor-build/credentials/q01-tcr-dependency-base-${request_id}.json
TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_auth" >/dev/null

printf -v quoted_source_link '%q' "$source_link"
printf -v quoted_revision '%q' "$source_revision"
printf -v quoted_manifest '%q' "$source_manifest_sha"
printf -v quoted_image '%q' "$image_tag"
printf -v quoted_registry '%q' "$registry_host"
printf -v quoted_remote '%q' "$remote_auth"
printf -v quoted_bootstrap_base '%q' "$bootstrap_base"
set +e
"$fleet_dir/tat/tat-run.sh" --name q01-build-controller-dependency-base --timeout 3600 <<REMOTE_BUILD
set -euo pipefail
auth=$quoted_remote
trap 'rm -f -- "\$auth"' EXIT INT TERM
test "\$(stat -c '%a' "\$auth")" = 600
source=\$(readlink -e $quoted_source_link)
test "\$(tr -d '[:space:]' <"\$source/.actor-source/SOURCE_REVISION")" = $quoted_revision
test "\$(sha256sum "\$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)" = $quoted_manifest
getent ahostsv4 $quoted_registry | awk '{print \$1}' | grep -Eq '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'
export ACTOR_SOURCE_DIR="\$source"
export ACTOR_FLEET_BUILD_BASE_IMAGE_TAG=$quoted_image
export ACTOR_FLEET_BOOTSTRAP_BASE=$quoted_bootstrap_base
export REGISTRY_AUTH_FILE="\$auth"
export ACTOR_BUILD_TMPDIR=/data/tmp
"\$source/infra/cells/deploy/tencent/fleet/controller/build-dependency-base.sh"
REMOTE_BUILD
status=$?
set -e

printf -v quoted_remote '%q' "$remote_auth"
"$fleet_dir/tat/tat-run.sh" --name q01-remove-dependency-base-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null
set -euo pipefail
rm -f -- $quoted_remote
test ! -e $quoted_remote
REMOTE_CLEANUP
remote_auth=
exit "$status"
