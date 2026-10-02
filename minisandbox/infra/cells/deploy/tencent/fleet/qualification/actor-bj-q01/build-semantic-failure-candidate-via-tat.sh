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
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}

usage() {
	echo "Usage: build-semantic-failure-candidate-via-tat.sh SOURCE_REVISION SOURCE_MANIFEST_SHA256 BASE_RUNTIME_IMAGE CANDIDATE_TAG" >&2
}
[[ $# -eq 4 ]] || { usage; exit 2; }
source_revision=$1
source_manifest=$2
base_runtime=$3
candidate_tag=$4
runtime_os_base=${RIVET_RUNTIME_BASE_IMAGE:?RIVET_RUNTIME_BASE_IMAGE must identify the mirrored OS-only runtime base}
[[ $runtime_os_base =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*(/[A-Za-z0-9._-]+)+/runtime-base@sha256:[0-9a-f]{64}$ ]]
repository="$registry_host/actor-fleet/rivet-runtime"
[[ $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest =~ ^[0-9a-f]{64}$ ]]
[[ $base_runtime =~ ^${repository//./\.}@sha256:[0-9a-f]{64}$ ]]
[[ $candidate_tag =~ ^${repository//./\.}:q01-semantic-failure-[0-9a-f]{8,64}$ ]]
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }

done

install -d -m 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/semantic-candidate.XXXXXX")
chmod 0700 "$temporary"
remote_auth=
cleanup() {
	if [[ -n $remote_auth ]]; then
		printf -v quoted_remote '%q' "$remote_auth"
		"$fleet_dir/tat/tat-run.sh" --name q01-remove-semantic-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null 2>&1 || true
set -euo pipefail
rm -f -- $quoted_remote
REMOTE_CLEANUP
	fi
	[[ $temporary == "$state_dir"/semantic-candidate.* ]] && rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

"$tccli" tcr CreateInstanceToken --region "$region" --RegistryId "$registry_id" --TokenType temp \
	--Desc "actor-bj-q01-semantic-candidate-${source_revision:0:12}" >"$temporary/token.json"
jq -e '.Username | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e '.Token | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -e --argjson minimum "$(( ($(date +%s) + 1800) * 1000 ))" \
	'.ExpTime | type == "number" and . > $minimum' "$temporary/token.json" >/dev/null
request_id=$(jq -er '.RequestId | select(test("^[0-9a-f-]{36}$"))' "$temporary/token.json")
username=$(jq -r '.Username' "$temporary/token.json")
token=$(jq -r '.Token' "$temporary/token.json")
auth=$(printf '%s:%s' "$username" "$token" | base64 | tr -d '\n')
jq -n --arg host "$registry_host" --arg auth "$auth" '{auths:{($host):{auth:$auth}}}' >"$temporary/config.json"
chmod 0600 "$temporary/config.json"
remote_auth=/var/lib/actor-build/credentials/q01-semantic-build-${request_id}.json
TAT_UPLOAD_MODE=0600 "$fleet_dir/tat/tat-upload.sh" "$temporary/config.json" "$remote_auth" >/dev/null

run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
remote_build=$temporary/remote-build.sh
{
	printf 'export CARGO_BUILD_JOBS=%q\n' "$build_jobs"
	printf 'export CARGO_PROFILE_RELEASE_LTO=thin\n'
	printf 'export ACTOR_BUILD_PYTHON=python3.11\n'
	printf 'export RIVET_RUNTIME_BASE_IMAGE=%q\n' "$runtime_os_base"
	printf 'auth=%q\n' "$remote_auth"
	printf 'run_id=%q\n' "$run_id"
	printf 'source_path=%q\n' "/var/lib/actor-build/deploy/q01-src-${source_revision}-${source_manifest}"
	printf 'expected_revision=%q\n' "$source_revision"
	printf 'expected_manifest=%q\n' "$source_manifest"
	printf 'base_runtime=%q\n' "$base_runtime"
	printf 'candidate_tag=%q\n' "$candidate_tag"
	printf 'repository=%q\n' "$repository"
	cat <<'REMOTE_BUILD'
set -euo pipefail
source=$(readlink -e "$source_path")
export PATH=/data/build-cache/runtime-rust/1.96.0/bin:$PATH
[[ $source =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})$ ]]
[[ ${BASH_REMATCH[1]} == "$expected_revision" && ${BASH_REMATCH[2]} == "$expected_manifest" ]]
[[ $(tr -d '[:space:]' <"$source/.actor-source/SOURCE_REVISION") == "$expected_revision" ]]
[[ $(sha256sum "$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$expected_manifest" ]]
test "$(stat -c '%a' "$auth")" = 600

# The semantic candidate uses the same compiler cache as the production
# Runtime build. Serialize both users and present derived source at the same
# stable path, so Cargo reuses every unchanged crate instead of keying a full
# rebuild to a random temporary source path.
workspace_root=/var/lib/actor-build/runtime-workspace
install -d -m 0700 "$workspace_root"
exec 9>"$workspace_root/build.lock"
flock -n 9 || { echo "another Runtime build owns the stable workspace" >&2; exit 75; }
stable_source=$workspace_root/source
install -d -m 0700 "$stable_source"
if mountpoint -q "$stable_source"; then umount "$stable_source"; fi

candidate=$(mktemp -d /data/tmp/q01-semantic-source.XXXXXX)
stage=$(mktemp -d /data/tmp/q01-semantic-stage.XXXXXX)
candidate_staging=
container=
mounted=
stable_mounted=
cleanup_remote() {
  if [[ -n $stable_mounted ]] && mountpoint -q "$stable_source"; then umount "$stable_source"; fi
  if [[ -n $mounted ]]; then buildah unmount "$container" >/dev/null 2>&1 || true; fi
  if [[ -n $container ]]; then buildah rm "$container" >/dev/null 2>&1 || true; fi
  if [[ -n $candidate_staging && $candidate_staging == /var/lib/actor-build/deploy/q01-semantic-staging.* ]]; then
    rm -rf -- "$candidate_staging"
  fi
  rm -rf -- "$candidate" "$stage"
  rm -f -- "$auth"
}
trap cleanup_remote EXIT INT TERM
lock_sha=$(sha256sum "$source/Cargo.lock" | cut -d' ' -f1)
vendor_root=/data/build-cache/runtime-vendor/$lock_sha
test "$(sha256sum "$vendor_root/Cargo.lock" | cut -d' ' -f1)" = "$lock_sha"
export CARGO_HOME="$stage/cargo-home"
install -d -m 0755 "$CARGO_HOME"
printf '[net]\noffline = true\n[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "%s/vendor"\n' "$vendor_root" >"$CARGO_HOME/config.toml"

cp -al "$source/." "$candidate/"
find "$candidate" -type d -exec chmod u+w {} +
patch_file="$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/semantic-failure-candidate.patch"
patch_sha=$(sha256sum "$patch_file" | cut -d' ' -f1)
patch --batch --forward -d "$candidate" -p1 <"$patch_file"
candidate_manifest="$stage/CANDIDATE_SHA256SUMS"
python3 - "$candidate" "$source/.actor-source/RELEASE_SHA256SUMS" "$candidate_manifest" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]); original=pathlib.Path(sys.argv[2]); output=pathlib.Path(sys.argv[3])
entries={}
for line in original.read_text().splitlines():
    digest,path=line.split(None,1)
    entries[path.strip()]=digest
target="runtimes/workerd/host/src/lib.rs"
entries[target]=hashlib.sha256((root/target).read_bytes()).hexdigest()
output.write_text("".join(f"{entries[path]}  {path}\n" for path in sorted(entries)))
PY
candidate_manifest_sha=$(sha256sum "$candidate_manifest" | cut -d' ' -f1)
(cd "$candidate" && sha256sum --check "$candidate_manifest" >/dev/null)
(cd "$source" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)

mount --bind "$candidate" "$stable_source"
stable_mounted=1
mount -o remount,bind,ro "$stable_source"
build_source=$stable_source
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="$build_source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/clang-lld-linker.sh"
test -x "$CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER"

image=
resumed_published_image=false
local_image_id=$(buildah images --json | jq -r --arg tag "$candidate_tag" '
  [.[] | select(((.names // []) | index($tag)) != null)] |
  if length == 0 then "" elif length == 1 then .[0].id
  else error("candidate tag resolves to multiple local images") end')
if [[ -n $local_image_id ]]; then
  candidate_inspect=$(buildah inspect --type image "$local_image_id")
  labels=$(jq -c '.Docker.config.Labels' <<<"$candidate_inspect")
  [[ $(jq -er '.["fleet.actor.dev/source-revision"]' <<<"$labels") == "$expected_revision" ]]
  [[ $(jq -er '.["fleet.actor.dev/source-manifest-sha256"]' <<<"$labels") == "$candidate_manifest_sha" ]]
  [[ $(jq -er '.["fleet.actor.dev/runtime-base-image"]' <<<"$labels") == "$RIVET_RUNTIME_BASE_IMAGE" ]]
  jq -e '.["fleet.actor.dev/engine-sha256"] | test("^[0-9a-f]{64}$")' <<<"$labels" >/dev/null
  jq -e '.["fleet.actor.dev/workerd-host-sha256"] | test("^[0-9a-f]{64}$")' <<<"$labels" >/dev/null
  # FromImageDigest is the local image's input/config identity, not the
  # registry manifest digest returned by a push. Re-publish this exact,
  # label-verified local candidate and use TCR's digest response; otherwise a
  # resumed build can issue a receipt for an object that does not exist.
  candidate_digest_file="$stage/CANDIDATE_REGISTRY_DIGEST"
  buildah push --authfile "$auth" --digestfile "$candidate_digest_file" \
    "$candidate_tag" "docker://$candidate_tag" >/dev/null
  candidate_digest=$(tr -d '[:space:]' <"$candidate_digest_file")
  [[ $candidate_digest =~ ^sha256:[0-9a-f]{64}$ ]]
  image="$repository@$candidate_digest"
  resumed_published_image=true
fi

if [[ -z $image ]]; then
  container=$(buildah from --authfile "$auth" "$base_runtime")
  base_inspect=$(buildah inspect "$container")
  [[ $(jq -er '.Docker.config.Labels["fleet.actor.dev/source-revision"]' <<<"$base_inspect") == "$expected_revision" ]]
  [[ $(jq -er '.Docker.config.Labels["fleet.actor.dev/source-manifest-sha256"]' <<<"$base_inspect") == "$expected_manifest" ]]
  expected_workerd_sha=$(jq -er '.Docker.config.Labels["fleet.actor.dev/workerd-sha256"] | select(test("^[0-9a-f]{64}$"))' <<<"$base_inspect")
  mounted=$(buildah mount "$container")
  [[ $(sha256sum "$mounted/opt/actor/bin/workerd" | cut -d' ' -f1) == "$expected_workerd_sha" ]]
  install -m 0755 "$mounted/opt/actor/bin/workerd" "$stage/workerd"
  install -m 0755 "$mounted/opt/actor/bin/init-workerd-pool" "$stage/init-workerd-pool"
  install -m 0644 "$mounted/opt/actor/share/config-depot.capnp" "$stage/config-depot.capnp"
  install -m 0755 "$mounted/usr/local/lib/libfdb_c.so" "$stage/libfdb_c.so"
  buildah unmount "$container" >/dev/null
  mounted=
  buildah rm "$container" >/dev/null
  container=
  (cd "$stage" && sha256sum workerd init-workerd-pool config-depot.capnp libfdb_c.so >STAGE_SHA256SUMS)
  stage_receipt="$stage/CANDIDATE_STAGE_RECEIPT.json"
  jq -n \
    --arg revision "$expected_revision" \
    --arg manifest "sha256:$candidate_manifest_sha" \
    --arg artifacts "sha256:$(sha256sum "$stage/STAGE_SHA256SUMS" | cut -d' ' -f1)" \
    --arg base_runtime "$base_runtime" \
    --arg base_manifest "sha256:$expected_manifest" \
    --arg patch "sha256:$patch_sha" \
    '{schema:"actor-runtime-stage/v1",verdict:"passed",mode:"semantic-candidate-base-runtime-reuse",
      sourceRevision:$revision,sourceManifestDigest:$manifest,workerdCommit:null,
      foundationdbClientDigest:null,toolchainReceiptDigest:null,buildJobs:0,
      artifactsDigest:$artifacts,reuse:{baseRuntimeImage:$base_runtime,
        baseSourceRevision:$revision,baseSourceManifestDigest:$base_manifest,
        intentionalFaultPatchDigest:$patch}}' >"$stage_receipt"
  kubectl --kubeconfig /var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
    -n actor-fdb-cell-system get configmap actor-bj-q01-runtime-config \
    -o jsonpath='{.data.config\.jsonc}' >"$stage/production-config.jsonc"

  install -d -m 0700 /data/actor-qualification/builds
  build_output=$(mktemp "/data/actor-qualification/builds/semantic-runtime-${expected_revision}.XXXXXX.log")
  printf 'semantic_runtime_build_log=%s\n' "$build_output"
  set +e
  RIVET_SOURCE_DIR="$build_source" \
  RIVET_SOURCE_REVISION="$expected_revision" \
  RIVET_SOURCE_MANIFEST_FILE="$candidate_manifest" \
  RIVET_STAGE_DIR="$stage" \
  RIVET_STAGE_RECEIPT="$stage_receipt" \
  RIVET_RUNTIME_CONFIG_FILE="$stage/production-config.jsonc" \
  RIVET_RUNTIME_IMAGE_TAG="$candidate_tag" \
  REGISTRY_AUTH_FILE="$auth" \
  RIVET_PUSH_IMAGE=0 \
  ACTOR_BUILD_TMPDIR=/data/tmp \
  RIVET_CARGO_TARGET_DIR=/data/build-cache/rivet-runtime-cargo-target \
    systemd-run --scope --quiet --unit="q01-semantic-build-$run_id" \
      -p MemoryMax=6G -p CPUQuota=200% -p TasksMax=512 \
      "$build_source/infra/cells/deploy/tencent/fleet/runtime/build-image.sh" >"$build_output" 2>&1
  build_status=$?
  set -e
  printf 'semantic_runtime_build_exit=%s log=%s log_sha256=%s\n' \
    "$build_status" "$build_output" "$(sha256sum "$build_output" | cut -d' ' -f1)"
  # TAT retains bounded command output. Keep the full log on the builder and
  # return only terminal context plus the immutable image reference.
  tail -c 12000 "$build_output"
  ((build_status == 0)) || exit "$build_status"
  candidate_digest_file="$stage/CANDIDATE_REGISTRY_DIGEST"
  buildah push --authfile "$auth" --digestfile "$candidate_digest_file" \
    "$candidate_tag" "docker://$candidate_tag" >/dev/null
  candidate_digest=$(tr -d '[:space:]' <"$candidate_digest_file")
  [[ $candidate_digest =~ ^sha256:[0-9a-f]{64}$ ]]
  image="$repository@$candidate_digest"
fi
candidate_source=/var/lib/actor-build/deploy/q01-src-${expected_revision}-${candidate_manifest_sha}
if [[ -e $candidate_source ]]; then
  [[ -d $candidate_source ]]
  [[ $(tr -d '[:space:]' <"$candidate_source/.actor-source/SOURCE_REVISION") == "$expected_revision" ]]
  [[ $(sha256sum "$candidate_source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$candidate_manifest_sha" ]]
else
  candidate_staging=$(mktemp -d /var/lib/actor-build/deploy/q01-semantic-staging.XXXXXX)
  tar -C "$candidate" --exclude='./target' -cf - . | tar -C "$candidate_staging" -xf -
  install -m 0644 "$candidate_manifest" "$candidate_staging/.actor-source/RELEASE_SHA256SUMS"
  [[ $(tr -d '[:space:]' <"$candidate_staging/.actor-source/SOURCE_REVISION") == "$expected_revision" ]]
  [[ $(sha256sum "$candidate_staging/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$candidate_manifest_sha" ]]
  (cd "$candidate_staging" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
  chmod -R a-w "$candidate_staging"
  mv "$candidate_staging" "$candidate_source"
  candidate_staging=
fi
receipt=/data/actor-qualification/receipts/actor-bj-q01-semantic-failure-candidate-${run_id}.json
python3 - "$receipt" "$run_id" "$expected_revision" "$expected_manifest" "$candidate_manifest_sha" "$patch_sha" "$base_runtime" "$image" "$candidate_source" "$resumed_published_image" <<'PY'
import datetime,json,os,sys,tempfile
path,run_id,revision,base_manifest,candidate_manifest,patch_sha,base_image,image,candidate_source,resumed=sys.argv[1:]
doc={"schema":"actor-bj-q01-semantic-failure-candidate/v1","verdict":"passed",
     "createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"runID":run_id,
     "intentionallyNotProduction":True,"affectedWorker":"q01-platform-upgrade-gate",
     "sourceRevision":revision,"baseSourceManifestSHA256":base_manifest,
     "candidateSourceManifestSHA256":candidate_manifest,"faultPatchSHA256":patch_sha,
     "baseRuntimeImage":base_image,"candidateRuntimeImage":image,
     "candidateSourcePath":candidate_source,"resumedPublishedImage":resumed=="true"}
os.makedirs(os.path.dirname(path),exist_ok=True)
fd,tmp=tempfile.mkstemp(prefix=".semantic-candidate.",dir=os.path.dirname(path),text=True)
with os.fdopen(fd,"w") as out: json.dump(doc,out,indent=2,sort_keys=True); out.write("\n")
os.chmod(tmp,0o640); os.replace(tmp,path)
print(json.dumps(doc,sort_keys=True))
PY
REMOTE_BUILD
} >"$remote_build"
chmod 0600 "$remote_build"
bash -n "$remote_build"
"$fleet_dir/tat/tat-run.sh" --name "q01-build-semantic-candidate-${run_id:0:10}" \
	--timeout 7200 <"$remote_build"

printf -v quoted_remote '%q' "$remote_auth"
"$fleet_dir/tat/tat-run.sh" --name q01-remove-semantic-build-auth --timeout 120 <<REMOTE_CLEANUP >/dev/null
set -euo pipefail
rm -f -- $quoted_remote
test ! -e $quoted_remote
REMOTE_CLEANUP
remote_auth=
