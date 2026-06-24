#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

URL_FILE="${VELAD_URL_FILE:-target-linux-amd64/velad-linux-amd64.url}"
SHA_FILE="${VELAD_SHA_FILE:-target-linux-amd64/velad-linux-amd64.sha256}"

PUBLIC_URL="${VELAD_PUBLIC_URL:-}"
if [ -z "$PUBLIC_URL" ] && [ -f "$URL_FILE" ]; then
  PUBLIC_URL="$(tr -d '\r\n' <"$URL_FILE")"
fi
if [ -z "$PUBLIC_URL" ]; then
  printf 'missing VELAD_PUBLIC_URL or %s; run make server-upload-cos first\n' "$URL_FILE" >&2
  exit 2
fi

EXPECTED_SHA256="${VELAD_EXPECTED_SHA256:-}"
if [ -z "$EXPECTED_SHA256" ] && [ -f "$SHA_FILE" ]; then
  EXPECTED_SHA256="$(tr -d '\r\n' <"$SHA_FILE")"
fi

VM_LISTEN_ADDR="${VELAD_VM_LISTEN_ADDR:-127.0.0.1:3857}"
quote() {
  python3 - "$1" <<'PY'
import shlex
import sys
print(shlex.quote(sys.argv[1]))
PY
}

assignment_line() {
  local name="$1"
  local override="$2"
  local fallback="$3"
  if [ -n "$override" ]; then
    printf '%s=%s\n' "$name" "$(quote "$override")"
  else
    printf '%s=%s\n' "$name" "$fallback"
  fi
}

cat <<EOF
set -euo pipefail
VELAD_URL=$(quote "$PUBLIC_URL")
VELAD_SHA256=$(quote "$EXPECTED_SHA256")
VELAD_LISTEN_ADDR_VALUE=$(quote "$VM_LISTEN_ADDR")
$(assignment_line VELAD_BIN_DIR "${VELAD_VM_BIN_DIR:-}" '${HOME}/.local/bin')
$(assignment_line VELAD_DATA_DIR "${VELAD_VM_DATA_DIR:-}" '${HOME}/.local/share/velalink')
$(assignment_line VELAD_LOG_DIR "${VELAD_VM_LOG_DIR:-}" '${HOME}/.local/state/velalink')
$(assignment_line VELAD_BACKEND_CWD_VALUE "${VELAD_VM_BACKEND_CWD:-}" '${HOME}')
VELAD_ACP_API_KEY_VALUE="\${VELA_CLOUDAGENTS_API_KEY:-\${VELAD_ACP_API_KEY:-\${OPENAI_API_KEY:-}}}"
VELAD_ACP_COMMAND_VALUE="hermes"
VELAD_ACP_ARGS_VALUE="acp"
VELAD_ACP_BASE_URL_VALUE="\${OPENAI_BASE_URL:-\${OPENAI_API_BASE:-https://tokenhub.tencentmaas.com/v1}}"
VELAD_ACP_MODEL_VALUE="\${VELAD_ACP_MODEL:-\${HERMES_INFERENCE_MODEL:-\${OPENAI_MODEL:-minimax-m2.7}}}"
VELAD_ACP_PROVIDER_VALUE="\${HERMES_INFERENCE_PROVIDER:-custom}"
mkdir -p "\$VELAD_BIN_DIR" "\$VELAD_DATA_DIR" "\$VELAD_LOG_DIR"
VELAD_BIN="\$VELAD_BIN_DIR/velad"
curl -fL "\$VELAD_URL" -o "\$VELAD_BIN.tmp"
chmod +x "\$VELAD_BIN.tmp"
if [ -n "\$VELAD_SHA256" ]; then
  printf '%s  %s\n' "\$VELAD_SHA256" "\$VELAD_BIN.tmp" | sha256sum -c -
fi
mv "\$VELAD_BIN.tmp" "\$VELAD_BIN"
pkill -x velad 2>/dev/null || true
nohup env \\
  VELAD_LISTEN_ADDR="\$VELAD_LISTEN_ADDR_VALUE" \\
  VELAD_DATABASE_URL="sqlite://\$VELAD_DATA_DIR/velad.sqlite?mode=rwc" \\
  VELAD_BACKEND_CWD="\$VELAD_BACKEND_CWD_VALUE" \\
  VELA_CLOUDAGENTS_API_KEY="\$VELAD_ACP_API_KEY_VALUE" \\
  VELAD_ACP_API_KEY="\$VELAD_ACP_API_KEY_VALUE" \\
  VELAD_ACP_COMMAND="\$VELAD_ACP_COMMAND_VALUE" \\
  VELAD_ACP_ARGS="\$VELAD_ACP_ARGS_VALUE" \\
  VELAD_ACP_MODEL="\$VELAD_ACP_MODEL_VALUE" \\
  OPENAI_BASE_URL="\$VELAD_ACP_BASE_URL_VALUE" \\
  OPENAI_API_BASE="\$VELAD_ACP_BASE_URL_VALUE" \\
  HERMES_INFERENCE_PROVIDER="\$VELAD_ACP_PROVIDER_VALUE" \\
  HERMES_INFERENCE_MODEL="\$VELAD_ACP_MODEL_VALUE" \\
  OPENAI_MODEL="\$VELAD_ACP_MODEL_VALUE" \\
  "\$VELAD_BIN" >"\$VELAD_LOG_DIR/velad.log" 2>&1 &
for i in \$(seq 1 60); do
  if curl -fsS "http://\$VELAD_LISTEN_ADDR_VALUE/api/v1/backends" >/dev/null; then
    printf 'velad ready at http://%s/api/v1\n' "\$VELAD_LISTEN_ADDR_VALUE"
    exit 0
  fi
  sleep 0.5
done
tail -100 "\$VELAD_LOG_DIR/velad.log" >&2 || true
exit 1
EOF
