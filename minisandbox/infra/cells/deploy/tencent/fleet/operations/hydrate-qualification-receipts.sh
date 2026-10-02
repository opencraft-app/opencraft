#!/usr/bin/env bash
set -euo pipefail

kubectl=${KUBECTL:-kubectl}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
: "${CELL:?CELL must name the exact Cell receiving the qualification evidence}"
cell=$CELL
target=${QUALIFICATION_RECEIPT_DIR:-${RUNTIME_RECEIPTS_DIR:-/data/actor-qualification/receipts}}
[[ -f $kubeconfig ]] || { echo "Cell kubeconfig is required" >&2; exit 2; }
for command in "$kubectl" jq gzip base64 sha256sum; do
	command -v "$command" >/dev/null || { echo "missing receipt-hydration command: $command" >&2; exit 2; }
done
[[ $target == /* ]] || { echo "qualification receipt cache target must be absolute" >&2; exit 2; }
install -d -m 0750 "$target"

valid_receipt_basename() {
	local base=$1
	[[ $base =~ ^(${cell}-[A-Za-z0-9][A-Za-z0-9._-]*|autonomy-control-${cell}-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$ ||
		$base =~ ^actor-cell-class-qualification-[0-9a-f]{64}\.json$ ||
		$base =~ ^actor-runtime-release-qualification-[0-9a-f]{64}\.json$ ]]
}

snapshot=$($kubectl --kubeconfig "$kubeconfig" -n "$namespace" get configmaps \
	-l "evidence.actor.dev/cell=${cell},evidence.actor.dev/kind=qualification-receipt" -o json)
count=$(jq '.items | length' <<<"$snapshot")

# A logical qualification may be retried with the same historical basename.
# The cache object identity is the payload SHA, so retain and verify every
# immutable object while materializing only the newest source-mtime as the
# canonical local file.  An equal-mtime fork is ambiguous and fails closed.
# A pre-existing local payload may be replaced only when its SHA is itself one
# of the immutable cached versions; unknown local bytes remain a hard error.
declare -A selected_sha selected_mtime known_sha
selected_count=0
for ((index=0; index<count; index++)); do
	item=$(jq -c ".items[$index]" <<<"$snapshot")
	read -r schema sha base bytes mtime compression compressed_sha compressed_bytes immutable < <(jq -r '[
      .metadata.annotations["evidence.actor.dev/schema"] // "",
      .metadata.annotations["evidence.actor.dev/sha256"] // "",
      .metadata.annotations["evidence.actor.dev/basename"] // "",
      .metadata.annotations["evidence.actor.dev/bytes"] // "",
      .metadata.annotations["evidence.actor.dev/source-mtime-epoch"] // "",
      .metadata.annotations["evidence.actor.dev/compression"] // "",
      .metadata.annotations["evidence.actor.dev/compressed-sha256"] // "",
      .metadata.annotations["evidence.actor.dev/compressed-bytes"] // "",
      (.immutable | tostring)
    ] | @tsv' <<<"$item")
	[[ $schema == qualification-cache-v1 && $sha =~ ^[0-9a-f]{64}$ && $bytes =~ ^[1-9][0-9]{0,7}$ && \
		$mtime =~ ^[0-9]+$ && $compression == gzip-n && $compressed_sha =~ ^[0-9a-f]{64}$ && \
		$compressed_bytes =~ ^[1-9][0-9]{0,5}$ && $immutable == true ]] && valid_receipt_basename "$base" || {
		echo "malformed immutable qualification cache object" >&2
		exit 1
	}
	((bytes <= 67108864 && compressed_bytes <= 700000)) || {
		echo "qualification cache exceeds receipt size limits" >&2
		exit 1
	}
	known_sha["$base:$sha"]=1
	if [[ -z ${selected_sha[$base]+x} ]]; then
		selected_sha[$base]=$sha
		selected_mtime[$base]=$mtime
		selected_count=$((selected_count + 1))
	elif ((mtime > selected_mtime[$base])); then
		selected_sha[$base]=$sha
		selected_mtime[$base]=$mtime
	elif ((mtime == selected_mtime[$base])) && [[ $sha != "${selected_sha[$base]}" ]]; then
		echo "ambiguous immutable qualification cache versions for basename: $base" >&2
		exit 1
	fi
done

for ((index=0; index<count; index++)); do
	item=$(jq -c ".items[$index]" <<<"$snapshot")
	read -r schema sha base bytes mtime compression compressed_sha compressed_bytes immutable < <(jq -r '[
      .metadata.annotations["evidence.actor.dev/schema"] // "",
      .metadata.annotations["evidence.actor.dev/sha256"] // "",
      .metadata.annotations["evidence.actor.dev/basename"] // "",
      .metadata.annotations["evidence.actor.dev/bytes"] // "",
      .metadata.annotations["evidence.actor.dev/source-mtime-epoch"] // "",
      .metadata.annotations["evidence.actor.dev/compression"] // "",
      .metadata.annotations["evidence.actor.dev/compressed-sha256"] // "",
      .metadata.annotations["evidence.actor.dev/compressed-bytes"] // "",
      (.immutable | tostring)
    ] | @tsv' <<<"$item")
	[[ $schema == qualification-cache-v1 && $sha =~ ^[0-9a-f]{64}$ && $bytes =~ ^[1-9][0-9]{0,7}$ && \
		$mtime =~ ^[0-9]+$ && $compression == gzip-n && $compressed_sha =~ ^[0-9a-f]{64}$ && \
		$compressed_bytes =~ ^[1-9][0-9]{0,5}$ && $immutable == true ]] && valid_receipt_basename "$base" || {
		echo "malformed immutable qualification cache object" >&2
		exit 1
	}
	((bytes <= 67108864 && compressed_bytes <= 700000)) || {
		echo "qualification cache exceeds receipt size limits" >&2
		exit 1
	}
	encoded=$(jq -r '.binaryData["receipt.json.gz"] // empty' <<<"$item")
	[[ -n $encoded ]] || { echo "qualification cache has no binary receipt payload" >&2; exit 1; }
	partial=$(mktemp "$target/.hydrate.XXXXXX")
	cleanup() { rm -f -- "$partial" "$partial.gz"; }
	trap cleanup EXIT INT TERM
	compressed=$partial.gz
	printf '%s' "$encoded" | base64 --decode >"$compressed"
	[[ $(wc -c <"$compressed") == "$compressed_bytes" \
		&& $(sha256sum "$compressed" | cut -d' ' -f1) == "$compressed_sha" ]] || {
		echo "qualification cache compressed payload failed size/hash verification" >&2
		exit 1
	}
	# Bound disk use before validating the expanded payload. pipefail also
	# rejects truncated gzip streams and a producer stopped by the byte limit.
	gzip -dc "$compressed" | head -c "$((bytes + 1))" >"$partial"
	rm -f -- "$compressed"
	[[ $(wc -c <"$partial") == "$bytes" && $(sha256sum "$partial" | cut -d' ' -f1) == "$sha" ]] || {
		echo "qualification cache payload failed size/hash verification" >&2
		exit 1
	}
	if [[ $base =~ ^actor-cell-class-qualification-([0-9a-f]{64})\.json$ ]]; then
		jq -e --arg digest "sha256:${BASH_REMATCH[1]}" '
          type == "object" and .schema == "actor-cell-class-qualification/v1" and
          .verdict == "passed" and .scope.profileDigest == $digest and
          (.evidenceSha256 | type == "string")
        ' "$partial" >/dev/null
	elif [[ $base =~ ^actor-runtime-release-qualification-([0-9a-f]{64})\.json$ ]]; then
		jq -e --arg digest "sha256:${BASH_REMATCH[1]}" '
          type == "object" and .schema == "actor-runtime-release-qualification/v1" and
          .verdict == "passed" and .scope.artifactDigest == $digest and
          (.evidenceSha256 | type == "string")
        ' "$partial" >/dev/null
	else
		jq -e --arg cell "$cell" 'type == "object" and .cell == $cell and
          (.verdict == "pass" or .verdict == "passed" or .verdict == "fail" or .verdict == "failed")' "$partial" >/dev/null
	fi
	if [[ $sha != "${selected_sha[$base]}" ]]; then
		cleanup
		trap - EXIT INT TERM
		continue
	fi
	chmod 0640 "$partial"
	touch -d "@$mtime" "$partial"
	destination=$target/$base
	if [[ -e $destination && $(sha256sum "$destination" | cut -d' ' -f1) != "$sha" ]]; then
		local_sha=$(sha256sum "$destination" | cut -d' ' -f1)
		if [[ -z ${known_sha["$base:$local_sha"]+x} ]]; then
			echo "local receipt basename conflicts with immutable cached evidence: $base" >&2
			exit 1
		fi
	fi
	mv -f -- "$partial" "$destination"
	trap - EXIT INT TERM
done
printf 'qualification_receipt_hydration=passed objects=%s canonical_receipts=%s target=%s\n' \
	"$count" "$selected_count" "$target"
