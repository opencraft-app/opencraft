#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_dir=${RIVET_SOURCE_DIR:?RIVET_SOURCE_DIR must name the reviewed source tree}
stage_dir=${RIVET_STAGE_DIR:?RIVET_STAGE_DIR is required}
stage_receipt=${RIVET_STAGE_RECEIPT:?RIVET_STAGE_RECEIPT is required}
toolchain_receipt=${RIVET_TOOLCHAIN_RECEIPT:?RIVET_TOOLCHAIN_RECEIPT is required}
zig=${WORKERD_ZIG:?WORKERD_ZIG must name the verified Zig compiler}
bazel=${WORKERD_BAZEL:?WORKERD_BAZEL must name the verified Bazel executable}
build_jobs=${WORKERD_BUILD_JOBS:-16}
lock=${RIVET_RUNTIME_STAGE_LOCK:-$script_dir/runtime-stage.lock.json}
build_cache_root=${WORKERD_BUILD_CACHE_DIR:-/data/build-cache/workerd-stage}
export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}

[[ $source_dir == /* && $stage_dir == /* && $stage_receipt == /* && $TMPDIR == /* && $build_cache_root == /* ]] || {
	echo "runtime stage paths must be absolute" >&2
	exit 2
}
[[ -x $zig && -x $bazel && -f $lock && -f $toolchain_receipt ]] || { echo "runtime stage toolchain, receipt, or lock is unavailable" >&2; exit 2; }
[[ $build_jobs =~ ^[1-9][0-9]*$ ]] || { echo "WORKERD_BUILD_JOBS must be a positive integer" >&2; exit 2; }
[[ ! -e $stage_receipt && -d $(dirname -- "$stage_receipt") ]] || { echo "stage receipt must be a new path with an existing parent" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"
if [[ -e $stage_dir ]]; then
	[[ -d $stage_dir && -z $(find "$stage_dir" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
		echo "runtime stage must be absent or empty" >&2
		exit 2
	}
else
	install -d -m 0755 "$stage_dir"
fi
source_dir=$(CDPATH= cd -- "$source_dir" && pwd)

for command in ar curl file flock git jq readelf sha256sum tar; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
jq -e \
	--arg zig "sha256:$(sha256sum "$zig" | cut -d' ' -f1)" \
	--arg bazel "sha256:$(sha256sum "$bazel" | cut -d' ' -f1)" \
	'.schema == "actor-runtime-toolchains/v1" and .verdict == "passed" and .platform == "linux/amd64" and .zig.version == "0.14.1" and .zig.sha256 == $zig and .bazel.version == "9.2.0" and .bazel.sha256 == $bazel' \
	"$toolchain_receipt" >/dev/null || { echo "runtime toolchain receipt does not bind the supplied executables" >&2; exit 1; }
jq -e '
  keys == ["foundationdbClient","platform","schemaVersion","workerdLock"] and
  .schemaVersion == 1 and .platform == "linux/amd64" and
  .workerdLock == "runtimes/workerd/workerd-fdb.lock" and
  (.foundationdbClient | keys == ["sha256","url","version"]) and
  (.foundationdbClient.sha256 | test("^[0-9a-f]{64}$")) and
  .foundationdbClient.version == "7.3.79" and
  (.foundationdbClient.url | startswith("https://github.com/apple/foundationdb/releases/download/7.3.79/"))
' "$lock" >/dev/null || { echo "runtime stage lock is invalid" >&2; exit 1; }

source_revision=$(tr -d '[:space:]' <"$source_dir/.actor-source/SOURCE_REVISION")
source_manifest="$source_dir/.actor-source/RELEASE_SHA256SUMS"
[[ $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest ]] || { echo "reviewed source identity is unavailable" >&2; exit 1; }
(cd "$source_dir" && sha256sum --check "$source_manifest" >/dev/null)
"$source_dir/runtimes/workerd/verify-source-bundle.sh"

workerd_commit_expected=$(awk -F'"' '$1 ~ /^fork_commit/ { print $2 }' "$source_dir/runtimes/workerd/workerd-fdb.lock")
workerd_tree_expected=$(awk -F'"' '$1 ~ /^fork_tree/ { print $2 }' "$source_dir/runtimes/workerd/workerd-fdb.lock")
[[ $workerd_commit_expected =~ ^[0-9a-f]{40}$ && $workerd_tree_expected =~ ^[0-9a-f]{40}$ ]] || {
	echo "workerd source lock has invalid commit or tree identity" >&2
	exit 1
}

# Keep one stable workspace per independently versioned workerd fork. Bazel's
# output base and Cargo's target directory are derived from this path, so an
# infra-only monorepo revision reuses verified actions instead of rebuilding
# every V8 translation unit in a fresh mktemp checkout. The sibling
# rivet-history link is switched under the same lock; Cargo/Bazel still hash
# the current reviewed dependency contents and rebuild affected actions.
build_cache_root=${build_cache_root%/}/$workerd_commit_expected-$workerd_tree_expected
case "$build_cache_root/" in
"$source_dir"/*)
	echo "workerd build cache must be outside the immutable source tree" >&2
	exit 2
	;;
esac
install -d -m 0755 "$build_cache_root"
exec 9>"$build_cache_root/build.lock"
flock 9

workerd_source=$(RIVET_WORKERD_SOURCE="$build_cache_root/workerd-fdb" "$source_dir/runtimes/workerd/setup-fork.sh")
workspace_compat_link="$build_cache_root/rivet-history"
if [[ -L $workspace_compat_link ]]; then
	ln -sfn "$source_dir" "$workspace_compat_link"
elif [[ -e $workspace_compat_link ]]; then
	echo "workerd cache compatibility path is not a symlink: $workspace_compat_link" >&2
	exit 1
else
	ln -s "$source_dir" "$workspace_compat_link"
fi
[[ $(readlink -f "$workspace_compat_link") == "$source_dir" ]] || {
	echo "workerd cache compatibility link does not bind reviewed source" >&2
	exit 1
}
workerd_commit=$(git -C "$workerd_source" rev-parse HEAD)
[[ $workerd_commit == "$workerd_commit_expected" ]] || {
	echo "workerd cache commit does not match source lock" >&2
	exit 1
}

temporary=$(mktemp -d "$TMPDIR/runtime-stage.XXXXXX")
receipt_stage=
cleanup() { rm -rf -- "$temporary"; [[ -z $receipt_stage ]] || rm -f -- "$receipt_stage"; }
trap cleanup EXIT INT TERM

fdb_deb=${FDB_CLIENT_DEB:-$temporary/foundationdb-client.deb}
fdb_sha=$(jq -r .foundationdbClient.sha256 "$lock")
if [[ -z ${FDB_CLIENT_DEB:-} ]]; then
	fdb_url=$(jq -r .foundationdbClient.url "$lock")
	downloaded=false
	for attempt in 1 2 3 4 5; do
		rm -f -- "$fdb_deb"
		if curl --fail --location --connect-timeout 15 --max-time 1800 \
			--output "$fdb_deb" "$fdb_url"; then
			downloaded=true
			break
		fi
		sleep $((attempt * 2))
	done
	[[ $downloaded == true ]] || {
		echo "FoundationDB client download failed after five attempts: $fdb_url" >&2
		exit 1
	}
fi
printf '%s  %s\n' "$fdb_sha" "$fdb_deb" | sha256sum --check --status || {
	echo "FoundationDB client artifact digest mismatch" >&2
	exit 1
}
install -d -m 0755 "$temporary/fdb-package" "$temporary/fdb-root"
(cd "$temporary/fdb-package" && ar x "$fdb_deb")
mapfile -t fdb_data_archives < <(find "$temporary/fdb-package" -maxdepth 1 -type f -name 'data.tar.*' -print)
[[ ${#fdb_data_archives[@]} -eq 1 ]] || { echo "FoundationDB client package has no unique data archive" >&2; exit 1; }
tar -xf "${fdb_data_archives[0]}" -C "$temporary/fdb-root"
fdb_library=$temporary/fdb-root/usr/lib/libfdb_c.so
[[ -f $fdb_library ]] || { echo "FoundationDB client package has no libfdb_c.so" >&2; exit 1; }

(cd "$workerd_source" && WORKERD_ZIG="$zig" WORKERD_BAZEL="$bazel" \
	./tools/build-rivet-workerd-musl.sh --jobs="$build_jobs")
workerd=$workerd_source/bazel-bin/src/workerd/server/workerd
[[ -x $workerd ]] || { echo "workerd build produced no executable" >&2; exit 1; }
if readelf -l "$workerd" | grep -q INTERP || readelf -d "$workerd" 2>/dev/null | grep -q '(NEEDED)'; then
	echo "workerd stage artifact is not static" >&2
	exit 1
fi

install -m 0755 "$workerd" "$stage_dir/workerd"
install -m 0755 "$source_dir/infra/cells/deploy/tencent/init-workerd-pool.sh" "$stage_dir/init-workerd-pool"
install -m 0644 "$source_dir/runtimes/workerd/host/workerd/config-depot.capnp" "$stage_dir/config-depot.capnp"
install -m 0755 "$fdb_library" "$stage_dir/libfdb_c.so"
(cd "$stage_dir" && sha256sum workerd init-workerd-pool config-depot.capnp libfdb_c.so >STAGE_SHA256SUMS)

receipt_stage=$(mktemp "$(dirname -- "$stage_receipt")/.runtime-stage-receipt.XXXXXX")
jq -n \
	--arg source_revision "$source_revision" \
	--arg source_manifest_digest "sha256:$(sha256sum "$source_manifest" | cut -d' ' -f1)" \
	--arg workerd_commit "$workerd_commit" \
	--arg fdb_client_digest "sha256:$fdb_sha" \
	--arg toolchain_receipt_digest "sha256:$(sha256sum "$toolchain_receipt" | cut -d' ' -f1)" \
	--argjson build_jobs "$build_jobs" \
	--arg artifacts_digest "sha256:$(sha256sum "$stage_dir/STAGE_SHA256SUMS" | cut -d' ' -f1)" \
	'{schema:"actor-runtime-stage/v1",verdict:"passed",sourceRevision:$source_revision,sourceManifestDigest:$source_manifest_digest,workerdCommit:$workerd_commit,foundationdbClientDigest:$fdb_client_digest,toolchainReceiptDigest:$toolchain_receipt_digest,buildJobs:$build_jobs,artifactsDigest:$artifacts_digest}' \
	>"$receipt_stage"
if ! ln "$receipt_stage" "$stage_receipt"; then
	rm -f -- "$receipt_stage"
	receipt_stage=
	exit 1
fi
rm -f -- "$receipt_stage"
receipt_stage=
printf 'runtime_stage=passed receipt=%s workerd_commit=%s\n' "$stage_receipt" "$workerd_commit"
