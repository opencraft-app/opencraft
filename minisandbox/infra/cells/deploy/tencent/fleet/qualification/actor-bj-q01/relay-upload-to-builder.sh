#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
coscli=${COSCLI:-/data/build-cache/coscli/v1.0.9/coscli}
region=${TENCENT_REGION:-ap-beijing}
endpoint=${QUALIFICATION_COS_ENDPOINT:-cos.ap-beijing.myqcloud.com}
bucket=${QUALIFICATION_RELAY_BUCKET:-actor-build-relay-qual-bj-q01-nv1-1388575217}

usage() {
	echo "Usage: relay-upload-to-builder.sh LOCAL_FILE ABSOLUTE_REMOTE_FILE" >&2
}
[[ $# -eq 2 ]] || { usage; exit 2; }
local_file=$(readlink -e "$1")
remote_file=$2
[[ -f $local_file ]] || { echo "local file does not exist" >&2; exit 2; }
[[ ($remote_file == /var/lib/actor-build/* && $remote_file != /var/lib/actor-build/) ||
   ($remote_file == /data/actor-build/* && $remote_file != /data/actor-build/) ]] || {
	echo "remote file must be a bounded path below /var/lib/actor-build or /data/actor-build" >&2
	exit 2
}
if [[ -n ${RELAY_REMOTE_MODE:-} ]]; then
	remote_mode=$RELAY_REMOTE_MODE
elif [[ -x $local_file ]]; then
	remote_mode=0700
else
	remote_mode=0600
fi
[[ $remote_mode =~ ^0?[67]00$ ]] || {
	echo "RELAY_REMOTE_MODE must be 0600 or 0700" >&2
	exit 2
}
[[ -x $coscli ]] || {
	echo "pinned coscli is missing; run install-coscli.sh first" >&2
	exit 2
}
[[ $($coscli --version) == "coscli version v1.0.9" ]] || {
	echo "COSCLI must be the reviewed v1.0.9 binary" >&2
	exit 2
}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done

builder_uuid=${RELAY_BUILDER_FILESYSTEM_UUID:-}
builder_disk=${RELAY_BUILDER_DISK_ID:-}
if [[ -n $builder_uuid || -n $builder_disk ]]; then
	[[ $builder_uuid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ &&
	   $builder_disk =~ ^disk-[a-z0-9]+$ && $TAT_INSTANCE_ID =~ ^ins-[a-z0-9]+$ ]] || {
		echo "dedicated builder relay requires exact filesystem UUID, disk and instance identities" >&2
		exit 2
	}
fi

sha=$(sha256sum "$local_file" | cut -d' ' -f1)
bytes=$(wc -c <"$local_file")
base=$(basename -- "$local_file")
[[ $base =~ ^[A-Za-z0-9._-]+$ ]] || base=artifact
key=relay/sha256/$sha/$base
cos_uri=cos://$bucket/$key
mkdir -p /data/tmp
temporary=$(mktemp -d /data/tmp/q01-coscli-relay.XXXXXX)
chmod 0700 "$temporary"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
cos_args=(
	--endpoint "$endpoint"
	--secret-id "$TENCENTCLOUD_SECRET_ID"
	--secret-key "$TENCENTCLOUD_SECRET_KEY"
	--init-skip
	--log-path "$temporary/logs"
)
run_coscli() {
	(cd "$temporary" && "$coscli" "$@")
}
# COSCLI v1.0.9 can suppress both the diagnostic and the non-zero status for
# authentication failures under --disable-log. Never use that flag in an
# unattended, fail-closed path; capture its enabled logs in this protected
# temporary directory instead.
if ! run_coscli stat "$cos_uri" "${cos_args[@]}" >"$temporary/stat.log" 2>&1; then
	if ! run_coscli cp "$local_file" "$cos_uri" "${cos_args[@]}" \
		--forbid-overwrite --server-side-encryption AES256 \
		--meta "x-cos-meta-sha256:$sha" >"$temporary/upload.log" 2>&1; then
		echo "COSCLI upload failed; protected diagnostic: $temporary/upload.log" >&2
		trap - EXIT INT TERM
		exit 1
	fi
fi
# The key is content-addressed. The builder independently checks both byte
# count and SHA-256 before the atomic rename, so a successful exact-key stat is
# sufficient here and never relies on a bucket LIST.
if ! run_coscli stat "$cos_uri" "${cos_args[@]}" >"$temporary/verified-stat.log" 2>&1; then
	echo "COSCLI exact-key verification failed" >&2
	exit 1
fi
if ! url=$(run_coscli signurl "$cos_uri" "${cos_args[@]}" --time 900 --simple-output 2>"$temporary/signurl.log"); then
	echo "COSCLI signed URL generation failed" >&2
	exit 1
fi
[[ $url == https://* ]] || {
	echo "COSCLI returned an invalid signed URL" >&2
	exit 1
}
printf -v quoted_url '%q' "$url"
printf -v quoted_remote '%q' "$remote_file"
printf -v quoted_dir '%q' "$(dirname -- "$remote_file")"
"$fleet_dir/tat/tat-run.sh" --name q01-relay-download --timeout 1200 <<REMOTE
set -euo pipefail
check_build_storage() {
  [[ -n '$builder_uuid' ]] || return 0
  test "\$(curl --fail --silent --show-error --max-time 5 http://metadata.tencentyun.com/latest/meta-data/instance-id)" = '$TAT_INSTANCE_ID'
  test "\$(findmnt -n --mountpoint /data -o UUID)" = '$builder_uuid'
  test "\$(findmnt -n --mountpoint /data -o SOURCE)" = "\$(readlink -e '/dev/disk/by-id/virtio-$builder_disk')"
  test "\$(stat -c %d /data)" != "\$(stat -c %d /)"
  resolved=\$(readlink -m $quoted_dir)
  [[ \$resolved == /data/actor-build || \$resolved == /data/actor-build/* ]]
  nearest=$quoted_dir
  while [[ ! -e \$nearest ]]; do nearest=\$(dirname -- "\$nearest"); done
  test "\$(stat -c %d "\$nearest")" = "\$(stat -c %d /data)"
  for file in $quoted_remote ${quoted_remote}.cos-part; do
    test ! -L "\$file"
    if [[ -e \$file ]]; then
      test -f "\$file"
      test "\$(stat -c %h "\$file")" = 1
      test "\$(stat -c %d "\$file")" = "\$(stat -c %d /data)"
    fi
  done
}
check_build_storage
install -d -m 700 $quoted_dir
partial=${quoted_remote}.cos-part
trap 'rm -f -- "\$partial"' EXIT
curl --fail --silent --show-error --location --proto '=https' \
  --connect-timeout 10 --max-time 900 --output "\$partial" $quoted_url
test "\$(wc -c <"\$partial")" = '$bytes'
test "\$(sha256sum "\$partial" | cut -d' ' -f1)" = '$sha'
chmod '$remote_mode' "\$partial"
check_build_storage
mv "\$partial" $quoted_remote
trap - EXIT
printf 'relay download verified sha256=%s bytes=%s\n' '$sha' '$bytes'
REMOTE

printf 'relay_key=%s sha256=%s bytes=%s remote=%s\n' "$key" "$sha" "$bytes" "$remote_file"
