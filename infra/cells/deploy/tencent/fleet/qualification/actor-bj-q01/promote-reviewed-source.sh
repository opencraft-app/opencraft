#!/usr/bin/env bash
set -euo pipefail

python=${ACTOR_BUILD_PYTHON:-python3.11}
[[ $# -eq 1 ]] || { echo "Usage: promote-reviewed-source.sh /var/lib/actor-build/deploy/q01-src-<git-commit>-<manifest-sha256>" >&2; exit 2; }
target=$(readlink -e "$1")
[[ $target =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})$ && -d $target ]] || {
	echo "source promotion target does not bind a q01 Git commit and release manifest" >&2
	exit 2
}
for command in jq sha256sum kubectl "$python"; do
	command -v "$command" >/dev/null || {
		echo "reviewed source promotion requires builder tool: $command" >&2
		exit 1
	}
done
"$python" -c 'import sys; assert sys.version_info[:2] == (3, 11)' || {
	echo "ACTOR_BUILD_PYTHON must identify Python 3.11" >&2
	exit 2
}
expected_revision=${BASH_REMATCH[1]}
expected_manifest_sha=${BASH_REMATCH[2]}
export KUBECONFIG=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}
revision=$(tr -d '[:space:]' <"$target/.actor-source/SOURCE_REVISION")
manifest="$target/.actor-source/RELEASE_SHA256SUMS"
[[ $revision =~ ^[0-9a-f]{40}$ && -s $manifest ]] || { echo "reviewed source identity is incomplete" >&2; exit 1; }
manifest_sha=$(sha256sum "$manifest" | cut -d' ' -f1)
[[ $revision == "$expected_revision" && $manifest_sha == "$expected_manifest_sha" ]] || {
	echo "source directory identity does not match its reviewed source metadata" >&2
	exit 1
}
(
	cd "$target"
	python_shim=$(mktemp -d)
	trap 'rm -rf -- "$python_shim"' EXIT
	ln -s "$(command -v "$python")" "$python_shim/python3"
	export PATH="$python_shim:$PATH"
	export PYTHONDONTWRITEBYTECODE=1
	sha256sum --check "$manifest" >/dev/null
	infra/cells/deploy/tencent/fleet/verify-manifests.sh >/dev/null
	rm -rf -- "$python_shim"
	trap - EXIT
)
# A promoted source tree is an input artifact, never a build workspace. Build
# outputs live under /data/build-cache; the next reviewed delta materializer
# explicitly creates a writable staging copy.
chmod -R a-w "$target"

link=/var/lib/actor-build/deploy/actor-bj-q01-current
temporary_link="${link}.new.$$"
cleanup(){ rm -f -- "$temporary_link"; }
trap cleanup EXIT INT TERM
previous=$(readlink -e "$link" 2>/dev/null || true)
ln -s "$target" "$temporary_link"
mv -Tf "$temporary_link" "$link"
trap - EXIT INT TERM

receipt_dir=/data/actor-qualification/source-promotions
install -d -m 0700 "$receipt_dir"
timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
receipt="$receipt_dir/${revision}.json"
"$python" - "$timestamp" "$revision" "$manifest_sha" "$target" "$previous" "$receipt" <<'PY'
import json,sys
timestamp,revision,manifest,target,previous,receipt=sys.argv[1:]
document={"schemaVersion":"actor-q01-source-promotion-v1","verdict":"passed","timestamp":timestamp,
          "revision":revision,"releaseManifestSHA256":manifest,"target":target,"previousTarget":previous or None}
with open(receipt,"w") as output:
    json.dump(document,output,indent=2,sort_keys=True)
    output.write("\n")
PY
printf 'source_promotion=passed revision=%s manifest_sha256=%s target=%s receipt=%s\n' "$revision" "$manifest_sha" "$target" "$receipt"
