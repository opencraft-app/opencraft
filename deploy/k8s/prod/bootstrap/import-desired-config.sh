#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
CONFIG_FILE="${1:-${LLMGATEWAY_DESIRED_CONFIG_FILE:-${SCRIPT_DIR}/private/desired-config.json}}"
CONTROL_URL="${LLMGATEWAY_CONTROL_URL:-}"
CONTROL_TOKEN="${LLMGATEWAY_CONTROL_TOKEN:-}"
RELEASE="${DESIRED_CONFIG_RELEASE:-false}"
SET_IDS_JSON="${DESIRED_CONFIG_SET_IDS_JSON:-[]}" # Empty means every active bootstrapped Set.

die() {
  printf 'desired-config bootstrap failed: %s\n' "$1" >&2
  exit 1
}

for command_name in curl jq git; do
  command -v "${command_name}" >/dev/null 2>&1 || die "${command_name} is required"
done

[[ -n "${CONTROL_URL}" ]] || die "LLMGATEWAY_CONTROL_URL is required"
[[ -n "${CONTROL_TOKEN}" ]] || die "LLMGATEWAY_CONTROL_TOKEN is required"
[[ -r "${CONFIG_FILE}" ]] || die "DesiredConfig is not readable: ${CONFIG_FILE}"

CONFIG_FILE="$(cd "$(dirname "${CONFIG_FILE}")" && pwd -P)/$(basename "${CONFIG_FILE}")"
if [[ "${CONFIG_FILE}" == "${REPO_ROOT}/"* ]]; then
  relative_config="${CONFIG_FILE#${REPO_ROOT}/}"
  if git -C "${REPO_ROOT}" ls-files --error-unmatch -- "${relative_config}" >/dev/null 2>&1; then
    die "DesiredConfig is tracked by Git; remove it from the index before importing"
  fi
fi

permissions="$(stat -f '%Lp' "${CONFIG_FILE}" 2>/dev/null || stat -c '%a' "${CONFIG_FILE}" 2>/dev/null || true)"
case "${permissions}" in
  400|600) ;;
  *) printf 'warning: set DesiredConfig permissions to 0600 (current: %s)\n' "${permissions:-unknown}" >&2 ;;
esac

# Validate without printing the secret-bearing document. The API performs the
# authoritative validation again before it writes anything.
jq -e '
  .api_version == "llmgateway.io/v1alpha1" and
  .kind == "DesiredConfig" and
  (.channel_bundles | type == "array" and length == 1) and
  (.channel_bundles[0].id | type == "string" and length > 0) and
  (.channel_bundles[0].channels | type == "array") and
  (all(.channel_bundles[0].channels[]; .key | type == "string" and length > 0))
' "${CONFIG_FILE}" >/dev/null || die "invalid DesiredConfig: expected llmgateway.io/v1alpha1, DesiredConfig, exactly one channel bundle, and plaintext channel keys"

bundle_id="$(jq -r '.channel_bundles[0].id' "${CONFIG_FILE}")"
bundle_id_uri="$(jq -nr --arg value "${bundle_id}" '$value | @uri')"

tmp_dir="$(mktemp -d)"
chmod 700 "${tmp_dir}"
trap 'rm -rf "${tmp_dir}"' EXIT
import_response="${tmp_dir}/import.json"
revisions_response="${tmp_dir}/revisions.json"
release_response="${tmp_dir}/release.json"

if ! curl --fail-with-body --silent --show-error \
  --output "${import_response}" \
  "${CONTROL_URL%/}/api/desired-config/import" \
  -H "Authorization: Bearer ${CONTROL_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary "@${CONFIG_FILE}"; then
  die "import request failed; inspect control-plane logs without printing the DesiredConfig"
fi
jq -e --arg bundle_id "${bundle_id}" '
  .success == true and
  (.data | type == "array" and length == 1) and
  .data[0].id == $bundle_id and
  (.data[0].fingerprint | type == "string" and length > 0)
' "${import_response}" >/dev/null || die "control plane returned an invalid import response"
fingerprint="$(jq -r '.data[0].fingerprint' "${import_response}")"

if ! curl --fail-with-body --silent --show-error \
  --output "${revisions_response}" \
  "${CONTROL_URL%/}/api/channel-bundles/${bundle_id_uri}/revisions" \
  -H "Authorization: Bearer ${CONTROL_TOKEN}"; then
  die "revision verification request failed"
fi
revision_id="$(jq -r --arg fingerprint "${fingerprint}" '
  [.data[] | select(.fingerprint == $fingerprint)] | sort_by(.created_at) | last | .revision_id // empty
' "${revisions_response}")"
[[ -n "${revision_id}" ]] || die "imported fingerprint has no persisted immutable revision"

printf 'DesiredConfig imported: bundle=%s revision=%s fingerprint=%s\n' \
  "${bundle_id}" "${revision_id}" "${fingerprint}"

case "${RELEASE}" in
  false) exit 0 ;;
  true) ;;
  *) die "DESIRED_CONFIG_RELEASE must be true or false" ;;
esac

jq -e 'type == "array" and all(.[]; type == "string" and length > 0)' <<<"${SET_IDS_JSON}" >/dev/null \
  || die "DESIRED_CONFIG_SET_IDS_JSON must be a JSON string array"
release_payload="$(jq -cn \
  --arg revision_id "${revision_id}" \
  --argjson set_ids "${SET_IDS_JSON}" \
  '{revision_id:$revision_id,set_ids:$set_ids,force_drift:false,stop_on_failure:true,triggered_by:"desired-config-agent-playbook"}')"

if ! curl --fail-with-body --silent --show-error \
  --output "${release_response}" \
  "${CONTROL_URL%/}/api/channel-bundles/${bundle_id_uri}/releases" \
  -H "Authorization: Bearer ${CONTROL_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary "${release_payload}"; then
  die "release request failed; inspect the release run in the control console"
fi
release_status="$(jq -r '.data.status // empty' "${release_response}")"
release_id="$(jq -r '.data.id // empty' "${release_response}")"
[[ "${release_status}" == "success" ]] || die "release ${release_id:-unknown} finished with status ${release_status:-unknown}"

printf 'DesiredConfig released: bundle=%s revision=%s run=%s status=%s stop_on_failure=true\n' \
  "${bundle_id}" "${revision_id}" "${release_id}" "${release_status}"
