#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
coscli=${COSCLI:-/data/build-cache/coscli/v1.0.9/coscli}
endpoint=${QUALIFICATION_COS_ENDPOINT:-cos.ap-beijing.myqcloud.com}
bucket=${QUALIFICATION_EVIDENCE_BUCKET:-actor-qualification-evidence-prod-bj-q01-nv1-1388575217}

usage() { echo "Usage: persist-receipt-from-builder.sh ABSOLUTE_REMOTE_RECEIPT ABSOLUTE_LOCAL_RECEIPT" >&2; }
[[ $# -eq 2 ]] || { usage; exit 2; }
remote=$1
local_file=$2
if [[ $remote =~ ^/data/actor-qualification/receipts/(actor-bj-q01-[A-Za-z0-9._-]+\.json)$ ]]; then
	receipt_kind=cell
	base=${BASH_REMATCH[1]}
elif [[ $remote =~ ^/data/actor-qualification/receipts/(actor-runtime-release-qualification-([0-9a-f]{64})\.json)$ ]]; then
	receipt_kind=runtime-release
	base=${BASH_REMATCH[1]}
	runtime_release_digest=${BASH_REMATCH[2]}
else
	echo "remote receipt must be a bounded q01 JSON receipt" >&2
	exit 2
fi
[[ $local_file == /* && $(basename -- "$local_file") == "$base" ]] || {
	echo "local receipt must be an absolute path with the same basename" >&2
	exit 2
}
local_dir=$(dirname -- "$local_file")
[[ -d $local_dir ]] || { echo "local receipt directory does not exist" >&2; exit 2; }
[[ -x $coscli && $($coscli --version) == "coscli version v1.0.9" ]] || {
	echo "the reviewed COSCLI v1.0.9 binary is required" >&2
	exit 2
}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done

printf -v quoted_remote '%q' "$remote"
printf -v quoted_receipt_kind '%q' "$receipt_kind"
printf -v quoted_runtime_release_digest '%q' "${runtime_release_digest:-}"
metadata=$("$fleet_dir/tat/tat-run.sh" --name q01-evidence-source-metadata --timeout 120 <<REMOTE_METADATA
set -euo pipefail
test -f $quoted_remote
receipt_kind=$quoted_receipt_kind
runtime_release_digest=$quoted_runtime_release_digest
if [[ \$receipt_kind == runtime-release ]]; then
  jq -e --arg digest "sha256:\$runtime_release_digest" '
    type == "object" and .schema == "actor-runtime-release-qualification/v1" and
    .verdict == "passed" and .qualification.cell == "actor-bj-q01" and
    .scope.artifactDigest == \$digest and (.evidenceSha256 | type == "string")
  ' $quoted_remote >/dev/null
else
  jq -e 'type == "object" and .cell == "actor-bj-q01"' $quoted_remote >/dev/null
fi
bytes=\$(wc -c <$quoted_remote)
sha=\$(sha256sum $quoted_remote | cut -d' ' -f1)
printf '%s %s\n' "\$bytes" "\$sha"
REMOTE_METADATA
)
read -r bytes sha extra <<<"$metadata"
[[ $bytes =~ ^[0-9]+$ && $sha =~ ^[0-9a-f]{64}$ && -z ${extra:-} ]] || {
	echo "builder returned invalid evidence metadata" >&2
	exit 1
}
((bytes > 0 && bytes <= 67108864)) || { echo "receipt exceeds the 64 MiB evidence limit" >&2; exit 1; }
key=receipts/v1/sha256/$sha/$base
uri=cos://$bucket/$key
temporary=$(mktemp -d /data/tmp/q01-evidence.XXXXXX)
chmod 0700 "$temporary"
trap 'rm -rf -- "$temporary"' EXIT INT TERM
args=(--endpoint "$endpoint" --secret-id "$TENCENTCLOUD_SECRET_ID" --secret-key "$TENCENTCLOUD_SECRET_KEY" --init-skip --log-path "$temporary/logs")
run_coscli() { (cd "$temporary" && "$coscli" "$@"); }

if ! run_coscli stat "$uri" "${args[@]}" >"$temporary/stat-before.log" 2>&1; then
	put_url=$(run_coscli signurl "$uri" "${args[@]}" --method PUT --time 900 --simple-output 2>"$temporary/sign-put.log")
	[[ $put_url == https://* ]] || { echo "COSCLI returned an invalid evidence PUT URL" >&2; exit 1; }
	printf -v quoted_url '%q' "$put_url"
	"$fleet_dir/tat/tat-run.sh" --name q01-publish-immutable-evidence --timeout 1200 <<REMOTE_UPLOAD
set -euo pipefail
test "\$(wc -c <$quoted_remote)" = '$bytes'
test "\$(sha256sum $quoted_remote | cut -d' ' -f1)" = '$sha'
curl --fail --silent --show-error --location --proto '=https' \
  --connect-timeout 10 --max-time 900 --request PUT \
  --header 'x-cos-forbid-overwrite: true' \
  --header 'x-cos-server-side-encryption: AES256' \
  --header 'x-cos-meta-sha256: $sha' \
  --upload-file $quoted_remote $quoted_url
REMOTE_UPLOAD
fi

run_coscli stat "$uri" "${args[@]}" >"$temporary/stat-after.log"
run_coscli cp "$uri" "$temporary/receipt" "${args[@]}" >"$temporary/download.log"
[[ $(wc -c <"$temporary/receipt") == "$bytes" && $(sha256sum "$temporary/receipt" | cut -d' ' -f1) == "$sha" ]] || {
	echo "durable evidence failed exact read-after-write verification" >&2
	exit 1
}
if [[ -e $local_file && $(sha256sum "$local_file" | cut -d' ' -f1) != "$sha" ]]; then
	echo "local receipt conflicts with immutable evidence" >&2
	exit 1
fi
chmod 0600 "$temporary/receipt"
mv -f -- "$temporary/receipt" "$local_file"

# Keep an independently immutable in-cluster availability copy. The COS key is
# the cross-cluster authority; this cache lets a replacement operator hydrate
# without receiving long-lived COS credentials.
"$fleet_dir/tat/tat-run.sh" --name q01-cache-qualification-evidence --timeout 120 <<REMOTE_CACHE
set -euo pipefail
source=\$(readlink -e /var/lib/actor-build/deploy/actor-bj-q01-current)
CELL=actor-bj-q01 CELL_NAMESPACE=actor-fdb-cell-system \
KUBECONFIG_PATH=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
  "\$source/infra/cells/deploy/tencent/fleet/operations/cache-qualification-receipt.sh" $quoted_remote
REMOTE_CACHE
printf 'qualification_evidence=passed key=%s sha256=%s bytes=%s local=%s\n' "$key" "$sha" "$bytes" "$local_file"
