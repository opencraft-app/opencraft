#!/usr/bin/env bash
set -euo pipefail

usage() {
	echo "Usage: cache-qualification-receipt.sh ABSOLUTE_RECEIPT.json" >&2
}
[[ $# -eq 1 ]] || { usage; exit 2; }

receipt=$(readlink -e "$1")
receipt_root=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
receipt_root=$(readlink -e "$receipt_root")
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
kubectl=${KUBECTL:-kubectl}
namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
: "${CELL:?CELL must name the exact Cell receiving the qualification evidence}"
cell=$CELL

[[ -f $receipt && $receipt == "$receipt_root"/* ]] || {
	echo "receipt must be an existing file directly below the qualification receipt root" >&2
	exit 2
}
[[ -f $kubeconfig ]] || { echo "Cell kubeconfig is required" >&2; exit 2; }
for command in "$kubectl" jq gzip base64 sha256sum; do
	command -v "$command" >/dev/null || { echo "missing receipt-cache command: $command" >&2; exit 2; }
done
base=$(basename -- "$receipt")
cell_class_digest=
runtime_release_digest=
if [[ $base =~ ^actor-cell-class-qualification-([0-9a-f]{64})\.json$ ]]; then
	cell_class_digest=${BASH_REMATCH[1]}
elif [[ $base =~ ^actor-runtime-release-qualification-([0-9a-f]{64})\.json$ ]]; then
	runtime_release_digest=${BASH_REMATCH[1]}
elif [[ ! $base =~ ^(${cell}-[A-Za-z0-9][A-Za-z0-9._-]*|autonomy-control-${cell}-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$ ]]; then
	echo "receipt basename is not bound to the exact Cell" >&2
	exit 2
fi
bytes=$(wc -c <"$receipt")
((bytes > 0 && bytes <= 67108864)) || {
	echo "receipt exceeds the 64 MiB qualification evidence limit" >&2
	exit 2
}
if [[ -n $cell_class_digest ]]; then
	jq -e --arg digest "sha256:$cell_class_digest" '
      type == "object" and .schema == "actor-cell-class-qualification/v1" and
      .verdict == "passed" and .scope.profileDigest == $digest and
      (.evidenceSha256 | type == "string")
    ' "$receipt" >/dev/null || {
		echo "receipt is not a passed qualification for the exact Cell class digest" >&2
		exit 2
	}
elif [[ -n $runtime_release_digest ]]; then
	jq -e --arg digest "sha256:$runtime_release_digest" '
      type == "object" and .schema == "actor-runtime-release-qualification/v1" and
      .verdict == "passed" and .scope.artifactDigest == $digest and
      (.evidenceSha256 | type == "string")
    ' "$receipt" >/dev/null || {
		echo "receipt is not a passed qualification for the exact Runtime artifact digest" >&2
		exit 2
	}
else
	jq -e --arg cell "$cell" '
      type == "object" and .cell == $cell and
      ((.verdict == "pass") or (.verdict == "passed") or (.verdict == "failed") or (.verdict == "fail"))
    ' "$receipt" >/dev/null || {
		echo "receipt is not terminal JSON for the exact Cell" >&2
		exit 2
	}
fi

sha=$(sha256sum "$receipt" | cut -d' ' -f1)
mtime=$(stat -c %Y "$receipt")
temporary=$(mktemp -d /data/tmp/qualification-cache.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
gzip -n -c "$receipt" >"$temporary/receipt.json.gz"
compressed_bytes=$(wc -c <"$temporary/receipt.json.gz")
compressed_sha=$(sha256sum "$temporary/receipt.json.gz" | cut -d' ' -f1)
((compressed_bytes > 0 && compressed_bytes <= 700000)) || {
	echo "deterministic compressed receipt exceeds the bounded Kubernetes availability-cache size" >&2
	exit 1
}
name=actor-evidence-${cell}-${sha:0:20}
validate_existing() {
	local existing=$1 encoded
	jq -e --arg sha "$sha" --arg base "$base" --argjson bytes "$bytes" \
		--arg compressed_sha "$compressed_sha" --argjson compressed_bytes "$compressed_bytes" '
      .immutable == true and
      .metadata.annotations["evidence.actor.dev/sha256"] == $sha and
      .metadata.annotations["evidence.actor.dev/basename"] == $base and
      (.metadata.annotations["evidence.actor.dev/bytes"] | tonumber) == $bytes and
      .metadata.annotations["evidence.actor.dev/compression"] == "gzip-n" and
      .metadata.annotations["evidence.actor.dev/compressed-sha256"] == $compressed_sha and
      (.metadata.annotations["evidence.actor.dev/compressed-bytes"] | tonumber) == $compressed_bytes
    ' <<<"$existing" >/dev/null || {
		echo "existing evidence cache identity does not match the receipt" >&2
		exit 1
	}
	encoded=$(jq -r '.binaryData["receipt.json.gz"] // empty' <<<"$existing")
	[[ -n $encoded \
		&& $(printf '%s' "$encoded" | base64 --decode | sha256sum | cut -d' ' -f1) == "$compressed_sha" \
		&& $(printf '%s' "$encoded" | base64 --decode | gzip -dc | sha256sum | cut -d' ' -f1) == "$sha" ]] || {
		echo "existing evidence cache payload does not match its identity" >&2
		exit 1
	}
}
existing=$($kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap "$name" -o json 2>/dev/null || true)
if [[ -n $existing ]]; then
	validate_existing "$existing"
	printf 'qualification_receipt_cache=present name=%s sha256=%s bytes=%s\n' "$name" "$sha" "$bytes"
	exit 0
fi

base64 -w0 "$temporary/receipt.json.gz" >"$temporary/encoded"
manifest=$(jq -n --arg namespace "$namespace" --arg name "$name" --arg cell "$cell" \
	--arg sha "$sha" --arg base "$base" --arg bytes "$bytes" --arg mtime "$mtime" \
	--arg compressed_sha "$compressed_sha" --arg compressed_bytes "$compressed_bytes" \
	--rawfile encoded "$temporary/encoded" '{
      apiVersion:"v1", kind:"ConfigMap", immutable:true,
      metadata:{
        namespace:$namespace, name:$name,
        labels:{"evidence.actor.dev/cell":$cell,"evidence.actor.dev/kind":"qualification-receipt"},
        annotations:{
          "evidence.actor.dev/schema":"qualification-cache-v1",
          "evidence.actor.dev/sha256":$sha,
          "evidence.actor.dev/basename":$base,
          "evidence.actor.dev/bytes":$bytes,
          "evidence.actor.dev/source-mtime-epoch":$mtime,
          "evidence.actor.dev/compression":"gzip-n",
          "evidence.actor.dev/compressed-sha256":$compressed_sha,
          "evidence.actor.dev/compressed-bytes":$compressed_bytes
        }
      },
      binaryData:{"receipt.json.gz":$encoded}
    }')
if ! printf '%s\n' "$manifest" | $kubectl --kubeconfig "$kubeconfig" -n "$namespace" create -f - >/dev/null; then
	# A concurrent publisher is success only if it created the same immutable
	# full-hash object. Retrieve and validate exactly once; an RBAC or API failure
	# must not turn into an unbounded retry loop.
	existing=$($kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmap "$name" -o json 2>/dev/null || true)
	[[ -n $existing ]] || { echo "qualification cache create failed" >&2; exit 1; }
	validate_existing "$existing"
	printf 'qualification_receipt_cache=present-after-race name=%s sha256=%s bytes=%s\n' "$name" "$sha" "$bytes"
	exit 0
fi
printf 'qualification_receipt_cache=created name=%s sha256=%s bytes=%s\n' "$name" "$sha" "$bytes"
