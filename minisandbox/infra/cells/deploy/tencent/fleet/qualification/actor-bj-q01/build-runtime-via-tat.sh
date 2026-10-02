#!/usr/bin/env bash
set -euo pipefail

build_jobs=${RIVET_BUILD_JOBS:-1}
[[ $build_jobs =~ ^[12]$ ]] || { echo "RIVET_BUILD_JOBS must be 1 or 2 on the q01 operator" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
registry_id=${QUALIFICATION_TCR_REGISTRY_ID:-tcr-g7ax6o7q}
registry_host=${QUALIFICATION_TCR_HOST:-lightclaw-bj82.tencentcloudcr.com}
cell_name=${QUALIFICATION_CELL_NAME:-actor-bj-q01}
remote_kubeconfig=${QUALIFICATION_KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
source_link=${QUALIFICATION_SOURCE_LINK:-/var/lib/actor-build/deploy/actor-bj-q01-current}
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
prepared_stage=${QUALIFICATION_PREPARED_STAGE_DIR:-}
prepared_receipt=${QUALIFICATION_PREPARED_STAGE_RECEIPT:-}

if [[ -n $prepared_stage || -n $prepared_receipt ]]; then
	[[ $prepared_stage == /data/actor-build/* && $prepared_receipt == /data/actor-build/* &&
	   $prepared_stage != /data/actor-build/ && $prepared_receipt != /data/actor-build/ &&
	   $prepared_stage != *'/../'* && $prepared_receipt != *'/../'* ]] || {
		echo "prepared stage and receipt must both be bounded /data/actor-build paths" >&2
		exit 2
	}
fi

# This function is emitted into both remote preflight and build commands.
# Validate before minting push authority, then again around the bounded copy.
verify_prepared_stage() {
	local source=$1 directory=$2 receipt=$3 revision=$4 manifest=$5
	[[ -d $directory && ! -L $directory && $(readlink -e "$directory") == "$directory" &&
	   -f $receipt && ! -L $receipt && $(readlink -e "$receipt") == "$receipt" ]] || { echo "invalid prepared stage files" >&2; return 1; }
	local artifact workerd_commit fdb_digest artifacts
	for artifact in workerd init-workerd-pool config-depot.capnp libfdb_c.so STAGE_SHA256SUMS; do
		[[ -f $directory/$artifact && ! -L $directory/$artifact ]] || { echo "invalid prepared artifact: $artifact" >&2; return 1; }
	done
	workerd_commit=$(awk -F'"' '$1 ~ /^fork_commit/ {print $2}' "$source/runtimes/workerd/workerd-fdb.lock")
	fdb_digest=$(jq -er .foundationdbClient.sha256 "$source/infra/cells/deploy/tencent/fleet/runtime/runtime-stage.lock.json")
	artifacts=$(sha256sum "$directory/STAGE_SHA256SUMS" | cut -d' ' -f1)
	jq -e --arg revision "$revision" --arg manifest "sha256:$manifest" \
		--arg artifacts "sha256:$artifacts" --arg commit "$workerd_commit" --arg fdb "sha256:$fdb_digest" '
		.schema == "actor-runtime-stage/v1" and .verdict == "passed" and
		.sourceRevision == $revision and .sourceManifestDigest == $manifest and
		.artifactsDigest == $artifacts and .workerdCommit == $commit and
		.foundationdbClientDigest == $fdb and (has("mode") | not) and
		(.toolchainReceiptDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
		(.buildJobs | type == "number" and . > 0 and . == floor)
	' "$receipt" >/dev/null || { echo "prepared stage receipt identity mismatch" >&2; return 1; }
	# Compare the canonical four-entry inventory, not arbitrary receipt paths.
	cmp -s "$directory/STAGE_SHA256SUMS" <(cd "$directory" && sha256sum workerd init-workerd-pool config-depot.capnp libfdb_c.so) || {
		echo "prepared stage artifact checksum mismatch" >&2; return 1;
	}
	readelf -h "$directory/workerd" >/dev/null || return 1
	if readelf -l "$directory/workerd" | grep -q INTERP || readelf -d "$directory/workerd" 2>/dev/null | grep -q '(NEEDED)'; then
		echo "prepared workerd must be static" >&2; return 1
	fi
}

[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ ]] || { echo "invalid QUALIFICATION_CELL_NAME" >&2; exit 2; }
[[ $remote_kubeconfig == /data/actor-bootstrap/* || $remote_kubeconfig == /var/lib/actor-build/credentials/* ]] || {
	echo "QUALIFICATION_KUBECONFIG must be below an approved builder root" >&2
	exit 2
}
[[ $source_link == /var/lib/actor-build/deploy/* && $source_link != /var/lib/actor-build/deploy/ ]] || {
	echo "QUALIFICATION_SOURCE_LINK must be below /var/lib/actor-build/deploy" >&2
	exit 2
}

[[ $# -eq 4 ]] || {
	echo "Usage: build-runtime-via-tat.sh SOURCE_REVISION SOURCE_MANIFEST_SHA256 BASE_RUNTIME_IMAGE IMAGE_TAG" >&2
	exit 2
}
source_revision=$1
source_manifest=$2
base_runtime=$3
image_tag=$4
runtime_os_base=${RIVET_RUNTIME_BASE_IMAGE:?RIVET_RUNTIME_BASE_IMAGE must identify the mirrored OS-only runtime base}
[[ $runtime_os_base =~ ^${registry_host//./\.}/actor-fleet/runtime-base@sha256:[0-9a-f]{64}$ ]]
repository="$registry_host/actor-fleet/rivet-runtime"
[[ $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest =~ ^[0-9a-f]{64}$ ]]
[[ $base_runtime =~ ^${repository//./\.}@sha256:[0-9a-f]{64}$ ]]
[[ $image_tag =~ ^${repository//./\.}:[A-Za-z0-9._-]+$ ]]
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done
# A replacement operator may be ready to administer Kubernetes without being
# ready to compile an image. Check before minting or transferring push authority.
printf -v quoted_preflight_source_link '%q' "$source_link"
{
	printf 'source_link=%s\n' "$quoted_preflight_source_link"
	printf 'prepared_stage=%q\nprepared_receipt=%q\nsource_revision=%q\nsource_manifest=%q\n' \
		"$prepared_stage" "$prepared_receipt" "$source_revision" "$source_manifest"
	declare -f verify_prepared_stage
	cat <<'REMOTE_PREFLIGHT'
set -euo pipefail
missing=0
export PATH=/data/build-cache/runtime-rust/1.96.0/bin:$PATH
for tool in buildah cargo rustc gcc clang ld.lld make pkg-config protoc cmake kubectl systemd-run python3.11 flock mount mountpoint umount; do
  if ! command -v "$tool" >/dev/null; then
    echo "runtime build prerequisite missing: $tool" >&2
    missing=1
  fi
done
[[ $missing == 0 ]] || exit 2
source=$(readlink -e "$source_link")
if [[ -n $prepared_stage ]]; then
  verify_prepared_stage "$source" "$prepared_stage" "$prepared_receipt" "$source_revision" "$source_manifest"
fi
lock_sha=$(sha256sum "$source/Cargo.lock" | cut -d' ' -f1)
test "$(sha256sum "/data/build-cache/runtime-vendor/$lock_sha/Cargo.lock" | cut -d' ' -f1)" = "$lock_sha"
cargo --version
rustc --version
buildah --version
REMOTE_PREFLIGHT
} | "$fleet_dir/tat/tat-run.sh" --name runtime-build-preflight --timeout 120

install -d -m 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/runtime-build.XXXXXX")
chmod 0700 "$temporary"
remote_auth=
cleanup() {
	if [[ -n $remote_auth ]]; then
		printf -v quoted_remote '%q' "$remote_auth"
		"$fleet_dir/tat/tat-run.sh" --name q01-remove-runtime-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null 2>&1 || true
set -euo pipefail
rm -f -- $quoted_remote
REMOTE_CLEANUP
	fi
	[[ $temporary == "$state_dir"/runtime-build.* ]] && rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

# Runtime push authority is operation-scoped and never installed in Kubernetes.
"$tccli" tcr CreateInstanceToken --region "$region" --RegistryId "$registry_id" --TokenType temp \
	--Desc "${cell_name}-runtime-build-${source_revision:0:12}" >"$temporary/token.json"
jq -e '.Username | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e '.Token | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e --argjson minimum "$(( ($(date +%s) + 1800) * 1000 ))" \
	'.ExpTime | type == "number" and . > $minimum' "$temporary/token.json" >/dev/null
request_id=$(jq -er '.RequestId | select(test("^[0-9a-f-]{36}$"))' "$temporary/token.json")
auth=$(printf '%s:%s' "$(jq -r .Username "$temporary/token.json")" \
	"$(jq -r .Token "$temporary/token.json")" | base64 | tr -d '\n')
jq -n --arg host "$registry_host" --arg auth "$auth" \
	'{auths:{($host):{auth:$auth}}}' >"$temporary/config.json"
chmod 0600 "$temporary/config.json"
remote_auth=/var/lib/actor-build/credentials/q01-runtime-build-${request_id}.json
TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_auth" >/dev/null

for value in source_link source_revision source_manifest base_runtime image_tag remote_auth registry_host runtime_os_base remote_kubeconfig cell_name prepared_stage prepared_receipt; do
	printf -v "quoted_$value" '%q' "${!value}"
done
{
	declare -f verify_prepared_stage
	printf 'export CARGO_BUILD_JOBS=%q\n' "$build_jobs"
	# The workspace fat-LTO profile exceeds this operator's 6 GiB build
	# cgroup during the final rivet-engine link. Thin LTO preserves whole-
	# program optimization while keeping the unattended build inside the
	# same fail-closed resource boundary.
	printf 'export CARGO_PROFILE_RELEASE_LTO=thin\n'
	printf 'export RIVET_RUNTIME_BASE_IMAGE=%s\n' "$quoted_runtime_os_base"
	printf 'source_link=%s\nsource_revision=%s\nsource_manifest=%s\nbase_runtime=%s\nimage_tag=%s\nauth=%s\nregistry_host=%s\nremote_kubeconfig=%s\ncell_name=%s\n' \
		"$quoted_source_link" "$quoted_source_revision" "$quoted_source_manifest" \
		"$quoted_base_runtime" "$quoted_image_tag" "$quoted_remote_auth" "$quoted_registry_host" \
		"$quoted_remote_kubeconfig" "$quoted_cell_name"
	printf 'prepared_stage=%s\nprepared_receipt=%s\n' "$quoted_prepared_stage" "$quoted_prepared_receipt"
	cat <<'REMOTE_BUILD'
set -euo pipefail
immutable_source=$(readlink -e "$source_link")
export PATH=/data/build-cache/runtime-rust/1.96.0/bin:$PATH
[[ $immutable_source == /var/lib/actor-build/deploy/q01-src-${source_revision}-${source_manifest} ]]
[[ $(tr -d '[:space:]' <"$immutable_source/.actor-source/SOURCE_REVISION") == "$source_revision" ]]
[[ $(sha256sum "$immutable_source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$source_manifest" ]]
test -x "$immutable_source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/clang-lld-linker.sh"
test "$(stat -c '%a' "$auth")" = 600
test -f "$remote_kubeconfig"
getent ahostsv4 "$registry_host" | awk '{print $1}' | grep -Eq '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'

workspace_root=/var/lib/actor-build/runtime-workspace
install -d -m 0700 "$workspace_root"
exec 9>"$workspace_root/build.lock"
flock -n 9 || { echo "another Runtime build owns the stable workspace" >&2; exit 75; }
stable_source=$workspace_root/source
if mountpoint -q "$stable_source"; then umount "$stable_source"; fi
install -d -m 0700 "$stable_source"
mount --bind "$immutable_source" "$stable_source"
mount -o remount,bind,ro "$stable_source"
source=$stable_source
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/clang-lld-linker.sh"
stage=$(mktemp -d /data/tmp/q01-runtime-stage.XXXXXX)
cargo_home=$(mktemp -d /data/tmp/q01-runtime-cargo-home.XXXXXX)
cleanup_remote() {
  rm -rf -- "$stage"
  rm -rf -- "$cargo_home"
  if mountpoint -q "$stable_source"; then umount "$stable_source"; fi
  rm -f -- "$auth"
}
trap cleanup_remote EXIT INT TERM
lock_sha=$(sha256sum "$immutable_source/Cargo.lock" | cut -d' ' -f1)
vendor_root=/data/build-cache/runtime-vendor/$lock_sha
test "$(sha256sum "$vendor_root/Cargo.lock" | cut -d' ' -f1)" = "$lock_sha"
export CARGO_HOME="$cargo_home"
printf '[net]\noffline = true\n[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "%s/vendor"\n' "$vendor_root" >"$CARGO_HOME/config.toml"
RIVET_IMMUTABLE_SOURCE_DIR="$immutable_source" \
RIVET_CARGO_TARGET_DIR=/data/build-cache/rivet-runtime-cargo-target \
RIVET_CARGO_CACHE_STATE="$workspace_root/cargo-cache.sha256" \
ACTOR_BUILD_PYTHON=python3.11 \
  "$source/infra/cells/deploy/tencent/fleet/runtime/prepare-cargo-cache.sh"
if [[ -n $prepared_stage ]]; then
  verify_prepared_stage "$source" "$prepared_stage" "$prepared_receipt" "$source_revision" "$source_manifest"
  prepared_receipt_sha=$(sha256sum "$prepared_receipt" | cut -d' ' -f1)
  for artifact in workerd init-workerd-pool config-depot.capnp libfdb_c.so STAGE_SHA256SUMS; do
    install -m "$(stat -c '%a' "$prepared_stage/$artifact")" "$prepared_stage/$artifact" "$stage/$artifact"
  done
  stage_receipt=$stage/prepared-stage-receipt.json
  install -m 0644 "$prepared_receipt" "$stage_receipt"
  [[ $(sha256sum "$stage_receipt" | cut -d' ' -f1) == "$prepared_receipt_sha" ]]
  verify_prepared_stage "$source" "$stage" "$stage_receipt" "$source_revision" "$source_manifest"
  printf 'runtime_stage_mode=prepared receipt_sha256=%s\n' "$prepared_receipt_sha"
else
buildah pull --authfile "$auth" "$base_runtime" >/dev/null
base_inspect=$(buildah inspect "$base_runtime")
base_revision=$(jq -er '.Docker.config.Labels["fleet.actor.dev/source-revision"]' <<<"$base_inspect")
base_manifest=$(jq -er '.Docker.config.Labels["fleet.actor.dev/source-manifest-sha256"]' <<<"$base_inspect")
base_sources=()
declare -A seen_base_sources=()
for candidate in /var/lib/actor-build/deploy/* /var/lib/actor-build/runtime-baselines/*; do
  test -d "$candidate" || continue
  test -f "$candidate/.actor-source/SOURCE_REVISION" || continue
  test -f "$candidate/.actor-source/RELEASE_SHA256SUMS" || continue
  candidate_revision=$(tr -d '[:space:]' <"$candidate/.actor-source/SOURCE_REVISION")
  candidate_manifest=$(sha256sum "$candidate/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)
  if [[ $candidate_revision == "$base_revision" && $candidate_manifest == "$base_manifest" ]]; then
    resolved_candidate=$(readlink -e "$candidate")
    # The reviewed-source `current` link and its immutable target are the same
    # provenance object. Count canonical paths, not glob entries, or a valid
    # current base becomes ambiguous as soon as it is promoted.
    if [[ -z ${seen_base_sources[$resolved_candidate]+x} ]]; then
      base_sources+=("$resolved_candidate")
      seen_base_sources[$resolved_candidate]=1
    fi
  fi
done
if (( ${#base_sources[@]} != 1 )); then
  echo "expected exactly one reviewed source for base Runtime identity, found ${#base_sources[@]}" >&2
  exit 1
fi
base_source=${base_sources[0]}
install -d -m 0700 /data/actor-qualification/builds
stage_receipt=/data/actor-qualification/builds/runtime-stage-reuse-${source_revision}-${stage##*.}.json
RIVET_SOURCE_DIR="$source" \
RIVET_BASE_SOURCE_DIR="$base_source" \
RIVET_STAGE_DIR="$stage" \
RIVET_STAGE_RECEIPT="$stage_receipt" \
RIVET_BASE_RUNTIME_IMAGE="$base_runtime" \
REGISTRY_AUTH_FILE="$auth" \
  "$source/infra/cells/deploy/tencent/fleet/runtime/reuse-stage-from-runtime.sh"
fi
kubectl --kubeconfig "$remote_kubeconfig" \
  -n actor-fdb-cell-system get configmap "$cell_name-runtime-config" \
  -o jsonpath='{.data.config\.jsonc}' >"$stage/production-config.jsonc"
build_log=$(mktemp "/data/actor-qualification/builds/runtime-${source_revision}.XXXXXX.log")
printf 'runtime_build_log=%s\n' "$build_log"
set +e
RIVET_SOURCE_DIR="$source" \
RIVET_SOURCE_REVISION="$source_revision" \
RIVET_SOURCE_MANIFEST_FILE="$source/.actor-source/RELEASE_SHA256SUMS" \
RIVET_STAGE_DIR="$stage" \
RIVET_STAGE_RECEIPT="$stage_receipt" \
RIVET_RUNTIME_CONFIG_FILE="$stage/production-config.jsonc" \
RIVET_RUNTIME_IMAGE_TAG="$image_tag" \
REGISTRY_AUTH_FILE="$auth" \
ACTOR_PRODUCT_BUILD_RECEIPT="/data/actor-qualification/builds/product-rivet-runtime-${source_revision}-${stage##*.}.json" \
ACTOR_BUILD_PYTHON=python3.11 \
ACTOR_BUILD_TMPDIR=/data/tmp \
RIVET_CARGO_TARGET_DIR=/data/build-cache/rivet-runtime-cargo-target \
  systemd-run --scope --quiet --unit="${cell_name}-runtime-build-${source_revision:0:12}-${stage##*.}" \
    -p MemoryMax=6G -p CPUQuota=200% -p TasksMax=512 \
    "$source/infra/cells/deploy/tencent/fleet/runtime/build-image.sh" >"$build_log" 2>&1
build_status=$?
set -e
printf 'runtime_build_exit=%s log=%s log_sha256=%s\n' "$build_status" "$build_log" "$(sha256sum "$build_log" | cut -d' ' -f1)"
# Preserve the terminal digest or failure context without overflowing TAT's
# bounded output. The full log is independently retrievable through COS.
tail -c 12000 "$build_log"
exit "$build_status"
REMOTE_BUILD
} | "$fleet_dir/tat/tat-run.sh" --name "q01-build-runtime-${source_revision:0:12}" --timeout 7200

printf -v quoted_remote '%q' "$remote_auth"
"$fleet_dir/tat/tat-run.sh" --name q01-remove-runtime-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null
set -euo pipefail
rm -f -- $quoted_remote
test ! -e $quoted_remote
REMOTE_CLEANUP
remote_auth=
