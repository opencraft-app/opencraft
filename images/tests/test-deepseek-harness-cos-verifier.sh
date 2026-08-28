#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="${ROOT_DIR}/images/helpers/verify-deepseek-harness-cos-installer.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT

printf '%s\n' '#!/usr/bin/env bash' 'echo current' >"${TMPDIR}/local.sh"
cp "${TMPDIR}/local.sh" "${TMPDIR}/remote.sh"

bash "${VERIFIER}" "${TMPDIR}/local.sh" "file://${TMPDIR}/remote.sh"
WORKFLOW="${ROOT_DIR}/.ci/hermes-image.yml"
GENERATED_ASSETS_CHECK='node frontend/scripts/generate-deepseek-harness-runtime-assets.mjs --check'
COS_VERIFIER='bash images/helpers/verify-deepseek-harness-cos-installer.sh'
generated_assets_line="$(grep -nF "${GENERATED_ASSETS_CHECK}" "${WORKFLOW}" | cut -d: -f1)"
cos_verifier_line="$(grep -nF "${COS_VERIFIER}" "${WORKFLOW}" | cut -d: -f1)"
test -n "${generated_assets_line}"
test -n "${cos_verifier_line}"
test "${generated_assets_line}" -lt "${cos_verifier_line}"

printf '%s\n' '#!/usr/bin/env bash' 'echo stale' >"${TMPDIR}/remote.sh"
if bash "${VERIFIER}" "${TMPDIR}/local.sh" "file://${TMPDIR}/remote.sh"; then
  echo "COS verifier must reject byte differences" >&2
  exit 1
fi

echo "deepseek harness COS verifier tests passed"
