#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
coscli=${COSCLI:-/data/build-cache/coscli/v1.0.9/coscli}
endpoint=${QUALIFICATION_COS_ENDPOINT:-cos.ap-beijing.myqcloud.com}
bucket=${QUALIFICATION_RELAY_BUCKET:-actor-build-relay-qual-bj-q01-nv1-1388575217}

usage() {
	echo "Usage: relay-download-from-builder.sh ABSOLUTE_REMOTE_FILE LOCAL_FILE" >&2
}
[[ $# -eq 2 ]] || { usage; exit 2; }
remote_file=$1
local_file=$2
case "$remote_file" in
    /data/actor-qualification/* | /data/actor-build/release/* | \
        /data/actor-build/product-receipts/* | /var/lib/actor-build/*) ;;
	*) echo "remote file must be below an approved builder evidence/source root" >&2; exit 2 ;;
esac
[[ $remote_file != /data/actor-qualification/ && $remote_file != /var/lib/actor-build/ ]]
[[ $local_file == /* ]] || { echo "local target must be absolute" >&2; exit 2; }
[[ ${RELAY_LOCAL_OVERWRITE:-0} == 1 || ! -e $local_file ]] || {
	echo "local target exists: $local_file" >&2
	exit 2
}
local_dir=$(dirname -- "$local_file")
[[ -d $local_dir ]] || { echo "local target directory does not exist" >&2; exit 2; }
[[ -x $coscli && $($coscli --version) == "coscli version v1.0.9" ]] || {
	echo "the reviewed COSCLI v1.0.9 binary is required" >&2
	exit 2
}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done

printf -v quoted_remote '%q' "$remote_file"
metadata=$("$fleet_dir/tat/tat-run.sh" --name q01-relay-source-metadata --timeout 120 <<REMOTE_METADATA
set -euo pipefail
test -f $quoted_remote
bytes=\$(wc -c <$quoted_remote)
sha=\$(sha256sum $quoted_remote | cut -d' ' -f1)
printf '%s %s\n' "\$bytes" "\$sha"
REMOTE_METADATA
)
read -r remote_bytes remote_sha extra <<<"$metadata"
[[ $remote_bytes =~ ^[0-9]+$ && $remote_sha =~ ^[0-9a-f]{64}$ && -z ${extra:-} ]] || {
	echo "builder returned invalid relay metadata" >&2
	exit 1
}

run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
base=$(basename -- "$remote_file")
[[ $base =~ ^[A-Za-z0-9._-]+$ ]] || base=artifact
key=relay/download/$run_id/$base
cos_uri=cos://$bucket/$key
mkdir -p /data/tmp
temporary=$(mktemp -d /data/tmp/q01-coscli-download.XXXXXX)
chmod 0700 "$temporary"
partial=$temporary/payload
relay_created=false
cleanup() {
	if [[ $relay_created == true ]]; then
		if ! (cd "$temporary" && "$coscli" rm "$cos_uri" \
			--endpoint "$endpoint" --secret-id "$TENCENTCLOUD_SECRET_ID" \
			--secret-key "$TENCENTCLOUD_SECRET_KEY" --init-skip \
			--log-path "$temporary/logs" --force) >/dev/null 2>&1; then
			echo "warning: exact temporary COS relay key cleanup failed: $key" >&2
		fi
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM
cos_args=(
	--endpoint "$endpoint"
	--secret-id "$TENCENTCLOUD_SECRET_ID"
	--secret-key "$TENCENTCLOUD_SECRET_KEY"
	--init-skip
	--log-path "$temporary/logs"
)
run_coscli() { (cd "$temporary" && "$coscli" "$@"); }
put_url=$(run_coscli signurl "$cos_uri" "${cos_args[@]}" \
	--method PUT --time 900 --simple-output 2>"$temporary/sign-put.log")
[[ $put_url == https://* ]] || { echo "COSCLI returned an invalid PUT URL" >&2; exit 1; }
printf -v quoted_put_url '%q' "$put_url"
"$fleet_dir/tat/tat-run.sh" --name q01-relay-upload-evidence --timeout 1200 <<REMOTE_UPLOAD
set -euo pipefail
test "\$(wc -c <$quoted_remote)" = '$remote_bytes'
test "\$(sha256sum $quoted_remote | cut -d' ' -f1)" = '$remote_sha'
curl --fail --silent --show-error --location --proto '=https' \
  --connect-timeout 10 --max-time 900 --request PUT \
  --header 'x-cos-forbid-overwrite: true' \
  --header 'x-cos-meta-sha256: $remote_sha' \
  --upload-file $quoted_remote $quoted_put_url
echo relay_upload=passed
REMOTE_UPLOAD
relay_created=true

run_coscli stat "$cos_uri" "${cos_args[@]}" >"$temporary/stat.log"
run_coscli cp "$cos_uri" "$partial" "${cos_args[@]}" >"$temporary/download.log"
[[ $(wc -c <"$partial") == "$remote_bytes" ]]
[[ $(sha256sum "$partial" | cut -d' ' -f1) == "$remote_sha" ]]
chmod 0600 "$partial"
mv -f -- "$partial" "$local_file"
printf 'relay_download=passed sha256=%s bytes=%s local=%s\n' \
	"$remote_sha" "$remote_bytes" "$local_file"
