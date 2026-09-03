#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_INSTALLER="${1:-${ROOT_DIR}/images/helpers/install-deepseek-harness.sh}"
REMOTE_INSTALLER_URL="${2:-https://vela-installer-1388575217.cos.accelerate.myqcloud.com/dsh/install-deepseek-harness.sh}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT
REMOTE_INSTALLER="${TMPDIR}/install-deepseek-harness.sh"

test -f "${LOCAL_INSTALLER}"
curl --fail --location --silent --show-error \
  --retry 5 --retry-all-errors --connect-timeout 10 --max-time 120 \
  --output "${REMOTE_INSTALLER}" "${REMOTE_INSTALLER_URL}"
test -s "${REMOTE_INSTALLER}"
bash -n "${LOCAL_INSTALLER}" "${REMOTE_INSTALLER}"

if ! cmp -s "${LOCAL_INSTALLER}" "${REMOTE_INSTALLER}"; then
  python3 - "${LOCAL_INSTALLER}" "${REMOTE_INSTALLER}" <<'PY'
import hashlib
import pathlib
import sys

local_path, remote_path = map(pathlib.Path, sys.argv[1:])
for label, path in (("repository", local_path), ("COS", remote_path)):
    print(f"{label} sha256={hashlib.sha256(path.read_bytes()).hexdigest()}", file=sys.stderr)
PY
  echo "COS DeepSeek Harness installer does not byte-match the repository source" >&2
  exit 1
fi

echo "COS DeepSeek Harness installer matches repository source"
