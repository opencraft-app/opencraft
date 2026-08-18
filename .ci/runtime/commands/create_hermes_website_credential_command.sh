#!/usr/bin/env bash
# create_hermes_website_credential_command.sh
#
# Creates one reusable, parameterized Tencent Cloud TAT command for
# delivering per-instance website credentials to Hermes CVMs.
#
# The command content embeds the install script and uses TAT parameter
# placeholders:
#   {{tat-hidden:website_key}}  — hidden parameter, never shown in console/logs
#   {{api_base}}                — regular parameter, the API base URL
#
# No secret is placed in the command content, defaults, or output.
# Each invocation supplies its own Parameters JSON with the instance's key.
#
# Usage:
#   HERMES_TAT_REGION=ap-singapore \
#     bash .ci/runtime/commands/create_hermes_website_credential_command.sh
#
# Environment:
#   HERMES_TAT_REGION        Default: ap-singapore
#   HERMES_TAT_SCRIPT_FILE   Default: images/helpers/install-hermes-website-credential.sh
#   HERMES_TAT_COMMAND_NAME_PREFIX  Default: hermes-website-credential
#   HERMES_TAT_COMMAND_TIMEOUT      Default: 300
#   HERMES_TAT_COMMAND_USER        Default: root
#   HERMES_TAT_COMMAND_WORKDIR     Default: /tmp
#   HERMES_TAT_COMMAND_ENV_FILE    Optional path to write shell exports

set -euo pipefail

REGION="${HERMES_TAT_REGION:-ap-singapore}"
SCRIPT_FILE="${HERMES_TAT_SCRIPT_FILE:-images/helpers/install-hermes-website-credential.sh}"
COMMAND_NAME_PREFIX="${HERMES_TAT_COMMAND_NAME_PREFIX:-hermes-website-credential}"
COMMAND_TIMEOUT="${HERMES_TAT_COMMAND_TIMEOUT:-300}"
COMMAND_USER="${HERMES_TAT_COMMAND_USER:-root}"
COMMAND_WORKDIR="${HERMES_TAT_COMMAND_WORKDIR:-/tmp}"
OUTPUT_ENV_FILE="${HERMES_TAT_COMMAND_ENV_FILE:-}"

usage() {
  cat <<'EOF'
Usage:
  HERMES_TAT_REGION=ap-singapore \
    bash .ci/runtime/commands/create_hermes_website_credential_command.sh

Create a reusable, parameterized Tencent Cloud TAT command for
delivering per-instance website credentials to Hermes CVMs.

The command uses:
  {{tat-hidden:website_key}}  — hidden parameter (the instance key)
  {{api_base}}                — regular parameter (the API base URL)

No secret is stored in the command itself.

Environment:
  HERMES_TAT_REGION
      Default: ap-singapore.
  HERMES_TAT_SCRIPT_FILE
      Default: images/helpers/install-hermes-website-credential.sh.
  HERMES_TAT_COMMAND_NAME_PREFIX
      Default: hermes-website-credential.
  HERMES_TAT_COMMAND_TIMEOUT
      Default: 300.
  HERMES_TAT_COMMAND_USER
      Default: root.
  HERMES_TAT_COMMAND_WORKDIR
      Default: /tmp.
  HERMES_TAT_COMMAND_ENV_FILE
      Optional path to write shell exports for the created command.
EOF
}

log() {
  printf '[create-website-credential-command] %s\n' "$*" >&2
}

fail() {
  printf '[create-website-credential-command] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

[[ "${1:-}" != "-h" && "${1:-}" != "--help" ]] || {
  usage
  exit 0
}

# Resolve script file relative to repo root
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_PATH="${SCRIPT_FILE}"
if [[ "$SCRIPT_FILE" != /* ]]; then
  SCRIPT_PATH="${REPO_ROOT}/${SCRIPT_FILE}"
fi
[[ -r "$SCRIPT_PATH" ]] || fail "script file is not readable: $SCRIPT_PATH"

[[ "$COMMAND_TIMEOUT" =~ ^[0-9]+$ && "$COMMAND_TIMEOUT" -gt 0 ]] || \
  fail "HERMES_TAT_COMMAND_TIMEOUT must be a positive integer"

require_cmd base64
require_cmd date
require_cmd python3
require_cmd tccli

# Validate the install script syntax
bash -n "$SCRIPT_PATH"

# Build command content: shebang + parameter exports + install script body
# The {{tat-hidden:website_key}} placeholder is a TAT hidden parameter:
# TAT replaces it with the actual value at invocation time, and never
# shows the value in the console, logs, or command metadata.
content_b64="$(
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export WEBSITE_KEY="%s"\n' '{{tat-hidden:website_key}}'
    printf 'export API_BASE="%s"\n' '{{api_base}}'
    sed '1{/^#!/d;}' "$SCRIPT_PATH"
  } | base64 | tr -d '\n'
)"

stamp="$(date +%Y%m%d%H%M%S)"
command_name="${COMMAND_NAME_PREFIX}-${REGION}-${stamp}"

log "creating TAT command region=${REGION} name=${command_name} script=${SCRIPT_FILE}"

response="$(
  tccli tat CreateCommand \
    --region "$REGION" \
    --CommandName "$command_name" \
    --Description "Deliver per-instance website credential to Hermes CVM (parameterized, no embedded secret)" \
    --Content "$content_b64" \
    --CommandType SHELL \
    --EnableParameter true \
    --Username "$COMMAND_USER" \
    --WorkingDirectory "$COMMAND_WORKDIR" \
    --Timeout "$COMMAND_TIMEOUT"
)"

command_id="$(printf '%s' "$response" | python3 -c 'import json,sys; data=json.load(sys.stdin); print(data.get("Response", data).get("CommandId", ""))')"
[[ -n "$command_id" ]] || fail "CreateCommand response missing CommandId"

printf 'HERMES_TAT_COMMAND_ID=%s\n' "$command_id"
if [[ -n "$OUTPUT_ENV_FILE" ]]; then
  mkdir -p "$(dirname "$OUTPUT_ENV_FILE")"
  printf 'HERMES_TAT_COMMAND_ID=%q\n' "$command_id" >"$OUTPUT_ENV_FILE"
fi
