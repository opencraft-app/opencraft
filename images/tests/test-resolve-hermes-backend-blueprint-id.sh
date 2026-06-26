#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOLVER="${ROOT_DIR}/images/helpers/resolve-hermes-backend-blueprint-id.py"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

cat >"${TMPDIR}/tccli" <<'SH'
#!/usr/bin/env bash
cat <<'JSON'
{
  "TotalCount": 4,
  "BlueprintSet": [
    {
      "BlueprintId": "lhbp-old123",
      "BlueprintName": "hermes_agent",
      "DisplayTitle": "Hermes Agent",
      "Description": "Hermes Agent",
      "BlueprintState": "NORMAL",
      "CreatedTime": "2026-06-24T09:35:12Z"
    },
    {
      "BlueprintId": "lhbp-nanjing",
      "BlueprintName": "hermes_agent",
      "DisplayTitle": "Hermes Agent 南京",
      "Description": "nanjing test",
      "BlueprintState": "NORMAL",
      "CreatedTime": "2026-06-26T09:35:12Z"
    },
    {
      "BlueprintId": "lhbp-disabled",
      "BlueprintName": "hermes_agent",
      "DisplayTitle": "Hermes Agent",
      "Description": "Hermes Agent",
      "BlueprintState": "OFFLINE",
      "CreatedTime": "2026-06-27T09:35:12Z"
    },
    {
      "BlueprintId": "lhbp-latest",
      "BlueprintName": "hermes_agent",
      "DisplayTitle": "Hermes Agent",
      "Description": "Hermes Agent",
      "BlueprintState": "NORMAL",
      "CreatedTime": "2026-06-25T09:35:12Z"
    }
  ]
}
JSON
SH
chmod +x "${TMPDIR}/tccli"

PATH="${TMPDIR}:${PATH}" python3 "${RESOLVER}" >"${TMPDIR}/resolved.txt"
grep -qx "lhbp-latest" "${TMPDIR}/resolved.txt"

cat >"${TMPDIR}/tccli" <<'SH'
#!/usr/bin/env bash
cat <<'JSON'
{"TotalCount": 0, "BlueprintSet": []}
JSON
SH
chmod +x "${TMPDIR}/tccli"

if PATH="${TMPDIR}:${PATH}" python3 "${RESOLVER}" >"${TMPDIR}/empty.txt" 2>"${TMPDIR}/empty.err"; then
  echo "resolver unexpectedly succeeded without a dynamic blueprint" >&2
  exit 1
fi
test ! -s "${TMPDIR}/empty.txt"

echo "ok"
