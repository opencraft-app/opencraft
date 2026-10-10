#!/usr/bin/env bash
# Explicit operator-run TKE API primitive gate. No Actor or placement claim.
set -euo pipefail
umask 077

[[ $# == 6 ]] || {
  echo 'usage: run.sh REVIEWED_SOURCE SOURCE_REVISION MANIFEST_SHA256 INTENT KUBECONFIG NEW_RECEIPT' >&2
  exit 2
}
source_root=$1
revision=$2
manifest_sha=$3
intent=$4
kubeconfig=$5
receipt=$6
go_binary=${ACTOR_GO_BINARY:?ACTOR_GO_BINARY must select the configured Go toolchain under /data}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet=$(CDPATH= cd -- "$script_dir/../.." && pwd)
[[ $revision =~ ^[a-f0-9]{40}$ && $manifest_sha =~ ^[a-f0-9]{64}$ ]] || exit 2
for path in "$source_root" "$intent" "$kubeconfig" "$receipt" "$go_binary"; do
  [[ $path == /data/* && $path != *'/../'* && $path != *'/./'* ]] || {
    echo 'explicit /data source/input/output/toolchain paths required' >&2; exit 2;
  }
done
[[ -d $source_root && -f $intent && ! -L $intent && -f $kubeconfig &&
   -x $go_binary && ! -e $receipt && ! -L $receipt ]] || exit 2
source_root=$(readlink -e "$source_root")
[[ $source_root == /data/* && $script_dir == "$source_root/infra/cells/deploy/tencent/fleet/qualification/host-eviction-api" ]] || {
  echo 'execute the gate from its frozen reviewed source snapshot' >&2; exit 2;
}
[[ $(tr -d '[:space:]' <"$source_root/.actor-source/SOURCE_REVISION") == "$revision" &&
   $(sha256sum "$source_root/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest_sha" ]] || exit 2
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
  exec "$fleet/operations/with-autonomy-operation-lock.sh" -- bash "$0" "$@"
fi

# Verify the entire immutable Go subtree, including this gate and test sources,
# before compilation. No ignored extra .go file may become a build input.
validation_dir=$(mktemp -d /data/tmp/tke-eviction-source-validation.XXXXXX)
cleanup_validation() {
  rm -f -- "$validation_dir/manifest-files" "$validation_dir/actual-files"
  rmdir -- "$validation_dir"
}
trap cleanup_validation EXIT
cd "$source_root"
manifest=.actor-source/RELEASE_SHA256SUMS
if grep -Evq '^[a-f0-9]{64}  infra/cells/[^[:space:]]+$' "$manifest"; then
  echo 'invalid Go subtree source manifest' >&2; exit 2
fi
sed -E 's/^[a-f0-9]{64}  //' "$manifest" | LC_ALL=C sort >"$validation_dir/manifest-files"
if grep -Eq '(^|/)\.\.(/|$)' "$validation_dir/manifest-files"; then exit 2; fi
[[ -s $validation_dir/manifest-files && -z $(find infra -type l -print -quit) ]] || exit 2
sha256sum --check "$manifest" >/dev/null
find infra -type f -printf '%p\n' | LC_ALL=C sort >"$validation_dir/actual-files"
cmp "$validation_dir/manifest-files" "$validation_dir/actual-files" >/dev/null
cleanup_validation
trap - EXIT

export GOWORK=off GOTOOLCHAIN=local TMPDIR=/data/tmp PYTHONDONTWRITEBYTECODE=1
export GOCACHE=/data/build-cache/go/cache GOPATH=/data/build-cache/go GOMODCACHE=/data/build-cache/go-mod
export HOST_DRAIN_TKE_EVICTION_INTENT=$intent
export HOST_DRAIN_TKE_EVICTION_KUBECONFIG=$kubeconfig
export HOST_DRAIN_TKE_EVICTION_RECEIPT=$receipt
unset HOST_DRAIN_EVICTION_E2E_KUBECONFIG
cd "$source_root/infra/cells"
"$go_binary" test -mod=readonly -tags integration -run '^TestTKEKubernetesFencedEviction$' \
  -count=1 -timeout=8m -v ./internal/hostdrain
# A skipped Go test has exit 0. Only its exact completed, identity-bound receipt
# can complete this gate. This never changes repair flags, RBAC or workloads.
python3 "$script_dir/verify_receipt.py" --intent "$intent" --receipt "$receipt"
