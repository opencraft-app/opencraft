#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="${ROOT_DIR}/images/helpers/verify-deepseek-harness-cos-installer.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT

printf '%s\n' '#!/usr/bin/env bash' 'echo current' >"${TMPDIR}/local.sh"
cp "${TMPDIR}/local.sh" "${TMPDIR}/remote.sh"

bash "${VERIFIER}" "${TMPDIR}/local.sh" "file://${TMPDIR}/remote.sh"
grep -Fq 'bash images/helpers/verify-deepseek-harness-cos-installer.sh' \
  "${ROOT_DIR}/.ci/hermes-image.yml"

printf '%s\n' '#!/usr/bin/env bash' 'echo stale' >"${TMPDIR}/remote.sh"
if bash "${VERIFIER}" "${TMPDIR}/local.sh" "file://${TMPDIR}/remote.sh"; then
  echo "COS verifier must reject byte differences" >&2
  exit 1
fi

echo "deepseek harness COS verifier tests passed"
