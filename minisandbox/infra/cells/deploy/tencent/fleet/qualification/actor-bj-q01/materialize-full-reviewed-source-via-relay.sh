#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || {
	echo "Usage: materialize-full-reviewed-source-via-relay.sh BUNDLE RECEIPT" >&2
	exit 2
}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
runtime_dir=$fleet_dir/runtime
python=${PYTHON:-python3}
relay=${ACTOR_RELAY_UPLOAD:-$script_dir/relay-upload-to-builder.sh}
tat=${ACTOR_TAT_RUN:-$fleet_dir/tat/tat-run.sh}
bundle=$(readlink -e "$1")
receipt=$(readlink -e "$2")
materializer=$script_dir/materialize-full-reviewed-source.sh
verifier=$runtime_dir/verify-full-source-bundle.py

for path in "$bundle" "$receipt" "$materializer" "$verifier"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "reviewed source relay input must be an absolute non-symlink regular file: $path" >&2
		exit 2
	}
done
for command in "$python" "$relay" "$tat" sha256sum; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done

identity=$("$python" "$verifier" --bundle "$bundle" --receipt "$receipt")
IFS=$'\t' read -r revision manifest_sha <<<"$identity"
[[ $revision =~ ^[0-9a-f]{40}$ && $manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "invalid reviewed source identity" >&2
	exit 2
}
remote_root=/var/lib/actor-build/incoming/reviewed-source-${revision}-${manifest_sha}
remote_bundle=$remote_root/source.tar.gz
remote_receipt=$remote_root/source.receipt.json
remote_materializer=$remote_root/materialize-full-reviewed-source.sh
remote_verifier=$remote_root/verify-full-source-bundle.py

RELAY_REMOTE_MODE=0600 "$relay" "$bundle" "$remote_bundle" >/dev/null
RELAY_REMOTE_MODE=0600 "$relay" "$receipt" "$remote_receipt" >/dev/null
RELAY_REMOTE_MODE=0700 "$relay" "$materializer" "$remote_materializer" >/dev/null
RELAY_REMOTE_MODE=0700 "$relay" "$verifier" "$remote_verifier" >/dev/null

for name in remote_bundle remote_receipt remote_materializer remote_verifier; do
	printf -v "quoted_$name" '%q' "${!name}"
done
bundle_sha=$(sha256sum "$bundle" | cut -d' ' -f1)
receipt_sha=$(sha256sum "$receipt" | cut -d' ' -f1)
materializer_sha=$(sha256sum "$materializer" | cut -d' ' -f1)
verifier_sha=$(sha256sum "$verifier" | cut -d' ' -f1)
target=/var/lib/actor-build/deploy/q01-src-${revision}-${manifest_sha}
printf -v quoted_target '%q' "$target"

"$tat" --name q01-materialize-reviewed-source-v2 --timeout 1800 <<REMOTE
set -euo pipefail
bundle=$quoted_remote_bundle
receipt=$quoted_remote_receipt
materializer=$quoted_remote_materializer
verifier=$quoted_remote_verifier
target=$quoted_target
for path in "\$bundle" "\$receipt" "\$materializer" "\$verifier"; do
  test -f "\$path" && test ! -L "\$path"
done
test "\$(sha256sum "\$bundle" | cut -d' ' -f1)" = '$bundle_sha'
test "\$(sha256sum "\$receipt" | cut -d' ' -f1)" = '$receipt_sha'
test "\$(sha256sum "\$materializer" | cut -d' ' -f1)" = '$materializer_sha'
test "\$(sha256sum "\$verifier" | cut -d' ' -f1)" = '$verifier_sha'
ACTOR_SOURCE_BUNDLE_VERIFIER="\$verifier" ACTOR_BUILD_PYTHON=python3.11 \
  "\$materializer" "\$bundle" "\$receipt"
test "\$(readlink -e "\$target")" = "\$target"
test "\$(tr -d '[:space:]' <"\$target/.actor-source/SOURCE_REVISION")" = '$revision'
test "\$(sha256sum "\$target/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)" = '$manifest_sha'
printf 'reviewed_source_materialized=%s revision=%s manifest_sha256=%s\n' \
  "\$target" '$revision' '$manifest_sha'
REMOTE

printf 'reviewed_source_materialized=%s revision=%s manifest_sha256=%s\n' \
	"$target" "$revision" "$manifest_sha"
