#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
WISP_DIR="${CLOUDAGENT_WISP_DIR:-$REPO_ROOT/cloudagent/wisp}"

cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

log() {
  printf '[wisp-package] %s\n' "$*" >&2
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

cos_config_value() {
  local key="$1"
  awk -F '=' -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      value = $2
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
      exit
    }
  ' "$COSCMD_CONFIG"
}

if [ ! -d "$WISP_DIR" ]; then
  printf 'missing Wisp source directory: %s\n' "$WISP_DIR" >&2
  exit 2
fi

COSCMD_BIN="${COSCMD_BIN:-coscmd}"
COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cos-agent-sidecar.conf}"
COS_OBJECT_PREFIX="${COS_OBJECT_PREFIX:-/workspace/releases}"
URL_FILE="${CLOUDAGENT_WISP_PACKAGE_URL_FILE:-$ROOT_DIR/dist/wisp-package-url.clean}"
SHA_FILE="${CLOUDAGENT_WISP_PACKAGE_SHA256_FILE:-$ROOT_DIR/dist/wisp-package-sha256.clean}"
REGISTRY_FILE="${CLOUDAGENT_WORKSPACE_VERSION_REGISTRY_FILE:-$ROOT_DIR/dist/cloudagent-workspace-version-registry.json}"
WORKSPACE_VERSION_PREFIX="${CLOUDAGENT_WORKSPACE_VERSION_PREFIX:-wisp.v1}"
DRY_RUN="${CLOUDAGENT_WISP_PUBLISH_DRY_RUN:-0}"

require_cmd "$COSCMD_BIN"
require_cmd docker
require_cmd shasum

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

COS_BUCKET="${COS_BUCKET:-$(cos_config_value bucket)}"
COS_REGION="${COS_REGION:-$(cos_config_value region)}"
if [ -z "$COS_BUCKET" ] || [ -z "$COS_REGION" ]; then
  printf 'missing COS_BUCKET/COS_REGION; set env or provide them in COSCMD_CONFIG\n' >&2
  exit 2
fi

GOOS="${GOOS:-linux}"
GOARCH="${GOARCH:-amd64}"
export GOOS GOARCH

CRUN_BINARY="${WISP_CRUN_BINARY:-$WISP_DIR/assets/bin/crun/crun-$GOARCH}"
TINI_BINARY="${WISP_TINI_BINARY:-$WISP_DIR/assets/bin/tini/tini-$GOARCH}"
ROOTFS_IMAGE="${WISP_ROOTFS_IMAGE:-$WISP_DIR/assets/rootfs/images/alpine-$GOARCH.img}"
ROOTFS_DIR="${WISP_ROOTFS_DIR:-$WISP_DIR/assets/rootfs/rootfs/alpine-$GOARCH}"
E2FSPROGS_DIR="${WISP_E2FSPROGS_DIR:-$WISP_DIR/assets/bin/e2fsprogs/$GOARCH}"
package_output=""
package_marker=""

mkdir -p "$ROOT_DIR/dist"

if [ -n "${CLOUDAGENT_WISP_PACKAGE_ARTIFACT:-}" ]; then
  artifact="$CLOUDAGENT_WISP_PACKAGE_ARTIFACT"
else
  if [ ! -x "$CRUN_BINARY" ]; then
    log "prepare static crun"
    WISP_CRUN_BINARY="$CRUN_BINARY" "$WISP_DIR/hack/release/prepare-static-crun.sh" >&2
  fi
  if [ ! -x "$TINI_BINARY" ]; then
    log "prepare tini"
    WISP_TINI_BINARY="$TINI_BINARY" "$WISP_DIR/hack/release/prepare-tini.sh" >&2
  fi
  if [ ! -f "$ROOTFS_DIR/.wisp-base-ready" ]; then
    log "prepare alpine rootfs directory"
    GOARCH="$GOARCH" DST_ROOTFS_DIR="$ROOTFS_DIR" "$WISP_DIR/hack/release/prepare-alpine-rootfs-dir.sh" >&2
  fi
  if [ "${WISP_PACKAGE_FLATTEN_ROOTFS:-1}" != "1" ] && [ ! -f "$ROOTFS_IMAGE" ]; then
    log "prepare alpine rootfs image"
    DST_ROOTFS_IMAGE="$ROOTFS_IMAGE" "$WISP_DIR/hack/release/prepare-alpine-rootfs.sh" >&2
  fi
  if [ ! -x "$E2FSPROGS_DIR/bin/mke2fs" ] || [ ! -x "$E2FSPROGS_DIR/bin/e2fsck" ]; then
    log "prepare e2fsprogs"
    GOARCH="$GOARCH" WISP_E2FSPROGS_DIR="$E2FSPROGS_DIR" "$WISP_DIR/hack/release/prepare-e2fsprogs.sh" >&2
  fi

  log "package Wisp runtime"
  package_marker="$(mktemp)"
  package_output="$(
    cd "$WISP_DIR"
      WISP_CRUN_BINARY="$CRUN_BINARY" \
      WISP_TINI_BINARY="$TINI_BINARY" \
      WISP_ROOTFS_IMAGE="$ROOTFS_IMAGE" \
      WISP_ROOTFS_DIR="$ROOTFS_DIR" \
      WISP_E2FSPROGS_DIR="$E2FSPROGS_DIR" \
      WISP_BUILD_WITH_DOCKER="${WISP_BUILD_WITH_DOCKER:-1}" \
      WISP_PACKAGE_WITH_DOCKER="${WISP_PACKAGE_WITH_DOCKER:-1}" \
      WISP_PACKAGE_EROFS="${WISP_PACKAGE_EROFS:-1}" \
      WISP_PACKAGE_TAR_GZ="${WISP_PACKAGE_TAR_GZ:-0}" \
      WISP_PACKAGE_FLATTEN_ROOTFS="${WISP_PACKAGE_FLATTEN_ROOTFS:-1}" \
      ./hack/release/package-tarball.sh
  )"
  artifact="$(printf '%s\n' "$package_output" | awk '
    /\.erofs$/ { erofs=$0 }
    /\.tar\.gz$/ { tarball=$0 }
    END {
      if (erofs != "") {
        print erofs
      } else {
        print tarball
      }
    }
  ')"
fi
if [ -z "$artifact" ] || [ ! -f "$artifact" ]; then
  if [ -n "$package_marker" ] && [ -f "$package_marker" ]; then
    latest_artifact="$(find "$WISP_DIR/dist-release" -maxdepth 1 -type f \( -name "wisp-${GOOS}-${GOARCH}-*.erofs" -o -name "wisp-${GOOS}-${GOARCH}-*.tar.gz" \) -newer "$package_marker" -print 2>/dev/null | sort | awk '
      /\.erofs$/ { erofs=$0 }
      /\.tar\.gz$/ { tarball=$0 }
      END {
        if (erofs != "") {
          print erofs
        } else {
          print tarball
        }
      }
    ' || true)"
    rm -f "$package_marker"
  else
    latest_artifact=""
  fi
  if [ -n "$latest_artifact" ] && [ -f "$latest_artifact" ]; then
    artifact="$latest_artifact"
  fi
elif [ -n "$package_marker" ] && [ -f "$package_marker" ]; then
  rm -f "$package_marker"
fi
if [ -z "$artifact" ] || [ ! -f "$artifact" ]; then
  printf 'Wisp package script did not produce a package artifact. output=%s\n' "$package_output" >&2
  exit 1
fi

log "publish Wisp package artifact=$artifact"
publish_output="$(
  cd "$WISP_DIR"
  COSCMD_BIN="$COSCMD_BIN" \
    COSCMD_CONFIG="$COSCMD_CONFIG" \
    COS_BUCKET="$COS_BUCKET" \
    COS_REGION="$COS_REGION" \
    COS_PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}" \
    COS_OBJECT_PREFIX="$COS_OBJECT_PREFIX" \
    COS_PUBLISH_DRY_RUN="$DRY_RUN" \
    ./hack/release/publish-cos.sh "$artifact"
)"
printf '%s\n' "$publish_output" >&2

url="$(printf '%s\n' "$publish_output" | awk -F= '$1=="URL" { print $2; exit }')"
sha256="$(printf '%s\n' "$publish_output" | awk -F= '$1=="SHA256" { print $2; exit }')"
if [ -z "$url" ] || [ -z "$sha256" ]; then
  printf 'failed to parse Wisp publish output: %s\n' "$publish_output" >&2
  exit 1
fi

mkdir -p "$(dirname "$URL_FILE")" "$(dirname "$SHA_FILE")" "$(dirname "$REGISTRY_FILE")"
printf '%s\n' "$url" >"$URL_FILE"
printf '%s\n' "$sha256" >"$SHA_FILE"

workspace_version="${CLOUDAGENT_WORKSPACE_VERSION:-${WORKSPACE_VERSION_PREFIX}-${sha256:0:12}}"
python3 - "$REGISTRY_FILE" "$workspace_version" "$url" "$sha256" <<'PY'
import json
import sys

path, version, url, sha256 = sys.argv[1:]
entry = {
    version: {
        "wisp_package_url": url,
        "wisp_package_sha256": sha256,
    }
}
raw = json.dumps(entry, indent=2, sort_keys=True)
with open(path, "w", encoding="utf-8") as fh:
    fh.write(raw + "\n")
print(raw)
PY

log "wisp_package_url=$url"
log "wisp_package_sha256=$sha256"
log "workspace_registry_json=$REGISTRY_FILE"
