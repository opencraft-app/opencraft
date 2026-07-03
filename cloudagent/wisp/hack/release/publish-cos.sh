#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <release-tarball>" >&2
  exit 2
fi

artifact="$1"
if [[ ! -f "$artifact" ]]; then
  echo "artifact not found: $artifact" >&2
  exit 1
fi

coscmd_bin="${COSCMD_BIN:-coscmd}"
coscmd_config="${COSCMD_CONFIG:-}"
object_prefix="${COS_OBJECT_PREFIX:-/workspace/$(date -u +%Y%m%d)}"
dry_run="${COS_PUBLISH_DRY_RUN:-0}"

config_value() {
  local key="$1"
  [[ -n "$coscmd_config" && -f "$coscmd_config" ]] || return 0
  awk -F '=' -v want="$key" '
    $1 ~ "^[[:space:]]*" want "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      print $2
      exit
    }
  ' "$coscmd_config"
}

bucket="${COS_BUCKET:-$(config_value bucket)}"
region="${COS_REGION:-$(config_value region)}"
public_base="${COS_PUBLIC_BASE_URL:-}"
public_scheme="${COS_PUBLIC_SCHEME:-http}"

if [[ -z "$coscmd_config" ]]; then
  echo "COSCMD_CONFIG is required" >&2
  exit 1
fi
if [[ -z "$bucket" || -z "$region" ]]; then
  echo "COS_BUCKET and COS_REGION are required or must exist in COSCMD_CONFIG" >&2
  exit 1
fi
if [[ -z "$public_base" ]]; then
  public_base="${public_scheme}://${bucket}.cos.${region}.myqcloud.com"
fi

coscmd_with_retry() {
  local attempts delay i
  attempts="${CLOUDAGENT_COSCMD_ATTEMPTS:-4}"
  delay="${CLOUDAGENT_COSCMD_RETRY_DELAY_SECONDS:-10}"
  i=1
  while true; do
    if "$coscmd_bin" -c "$coscmd_config" "$@"; then
      return 0
    fi
    if [[ "$i" -ge "$attempts" ]]; then
      return 1
    fi
    echo "[wisp-publish] coscmd failed attempt=$i/$attempts command=$1; retry in ${delay}s" >&2
    sleep "$delay"
    i=$((i + 1))
  done
}

sha="$(sha256sum "$artifact" 2>/dev/null | awk '{print $1}')"
if [[ -z "$sha" ]]; then
  sha="$(shasum -a 256 "$artifact" | awk '{print $1}')"
fi
short="${sha:0:12}"
base="$(basename "$artifact")"
case "$base" in
  *.tar.gz)
    stem="${base%.tar.gz}"
    ext=".tar.gz"
    ;;
  *.erofs)
    stem="${base%.erofs}"
    ext=".erofs"
    ;;
  *)
    stem="${base%.*}"
    ext="${base#$stem}"
    ;;
esac
object="${object_prefix%/}/${stem}-${short}${ext}"

if [[ "$dry_run" == "1" ]]; then
  echo "DRY_RUN=1" >&2
else
  coscmd_with_retry upload -f -y "$artifact" "$object"
  coscmd_with_retry putobjectacl "$object" --grant-read anyone
fi

echo "URL=${public_base}${object}"
echo "SHA256=$sha"
