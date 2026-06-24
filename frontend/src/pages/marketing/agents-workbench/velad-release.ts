const DEFAULT_VELAD_RELEASE_URL =
  "https://velalink-1388575217.cos.ap-beijing.myqcloud.com/velad/releases/velad-linux-amd64-1888761da748";
const DEFAULT_VELAD_RELEASE_SHA256 =
  "1888761da748c5f01a2403a25f069b0a726e3d40eccbce3d65d7e7f249e216fb";
const CLOUDAGENTS_OPENAI_BASE_URL = "https://tokenhub.tencentmaas.com/v1";
const CLOUDAGENTS_DEFAULT_MODEL = "minimax-m2.7";

function envValue(name: string) {
  if (typeof process === "undefined") return "";
  return process.env[name]?.trim() ?? "";
}

export function hasVeladRelease() {
  return Boolean(resolveVeladRelease().url);
}

export function buildVeladVmInstallCommand() {
  const release = resolveVeladRelease();
  if (!release.url) {
    throw new Error("Missing NEXT_PUBLIC_VELAD_RELEASE_URL.");
  }

  return [
    "set -euo pipefail",
    `VELAD_URL=${shellQuote(release.url)}`,
    `VELAD_SHA256=${shellQuote(release.sha256)}`,
    "VELAD_LISTEN_ADDR_VALUE=127.0.0.1:3857",
    'VELAD_BIN_DIR="${HOME}/.local/bin"',
    'VELAD_DATA_DIR="${HOME}/.local/share/velalink"',
    'VELAD_LOG_DIR="${HOME}/.local/state/velalink"',
    'VELAD_BACKEND_CWD_VALUE="${HOME}"',
    'VELAD_ACP_API_KEY_VALUE="${VELA_CLOUDAGENTS_API_KEY:-${VELAD_ACP_API_KEY:-${OPENAI_API_KEY:-}}}"',
    'VELAD_ACP_COMMAND_VALUE="hermes"',
    'VELAD_ACP_ARGS_VALUE="acp"',
    `VELAD_ACP_BASE_URL_VALUE="\${OPENAI_BASE_URL:-\${OPENAI_API_BASE:-${CLOUDAGENTS_OPENAI_BASE_URL}}}"`,
    `VELAD_ACP_MODEL_VALUE="\${VELAD_ACP_MODEL:-\${HERMES_INFERENCE_MODEL:-\${OPENAI_MODEL:-${CLOUDAGENTS_DEFAULT_MODEL}}}}"`,
    'VELAD_ACP_PROVIDER_VALUE="${HERMES_INFERENCE_PROVIDER:-custom}"',
    'mkdir -p "$VELAD_BIN_DIR" "$VELAD_DATA_DIR" "$VELAD_LOG_DIR"',
    'VELAD_BIN="$VELAD_BIN_DIR/velad"',
    'curl -fL "$VELAD_URL" -o "$VELAD_BIN.tmp"',
    'chmod +x "$VELAD_BIN.tmp"',
    'if [ -n "$VELAD_SHA256" ]; then printf "%s  %s\\n" "$VELAD_SHA256" "$VELAD_BIN.tmp" | sha256sum -c -; fi',
    'mv "$VELAD_BIN.tmp" "$VELAD_BIN"',
    "pkill -x velad 2>/dev/null || true",
    "nohup env \\",
    '  VELAD_LISTEN_ADDR="$VELAD_LISTEN_ADDR_VALUE" \\',
    '  VELAD_DATABASE_URL="sqlite://$VELAD_DATA_DIR/velad.sqlite?mode=rwc" \\',
    '  VELAD_BACKEND_CWD="$VELAD_BACKEND_CWD_VALUE" \\',
    '  VELA_CLOUDAGENTS_API_KEY="$VELAD_ACP_API_KEY_VALUE" \\',
    '  VELAD_ACP_API_KEY="$VELAD_ACP_API_KEY_VALUE" \\',
    '  VELAD_ACP_COMMAND="$VELAD_ACP_COMMAND_VALUE" \\',
    '  VELAD_ACP_ARGS="$VELAD_ACP_ARGS_VALUE" \\',
    '  VELAD_ACP_MODEL="$VELAD_ACP_MODEL_VALUE" \\',
    '  OPENAI_BASE_URL="$VELAD_ACP_BASE_URL_VALUE" \\',
    '  OPENAI_API_BASE="$VELAD_ACP_BASE_URL_VALUE" \\',
    '  HERMES_INFERENCE_PROVIDER="$VELAD_ACP_PROVIDER_VALUE" \\',
    '  HERMES_INFERENCE_MODEL="$VELAD_ACP_MODEL_VALUE" \\',
    '  OPENAI_MODEL="$VELAD_ACP_MODEL_VALUE" \\',
    '  "$VELAD_BIN" >"$VELAD_LOG_DIR/velad.log" 2>&1 &',
    "for i in $(seq 1 60); do",
    '  if curl -fsS "http://$VELAD_LISTEN_ADDR_VALUE/api/v1/backends" >/dev/null; then',
    '    printf "velad ready at http://%s/api/v1\\n" "$VELAD_LISTEN_ADDR_VALUE"',
    "    exit 0",
    "  fi",
    "  sleep 0.5",
    "done",
    'tail -100 "$VELAD_LOG_DIR/velad.log" >&2 || true',
    "exit 1",
  ].join("\n");
}

function resolveVeladRelease() {
  return {
    url: envValue("NEXT_PUBLIC_VELAD_RELEASE_URL") || DEFAULT_VELAD_RELEASE_URL,
    sha256: envValue("NEXT_PUBLIC_VELAD_RELEASE_SHA256") || DEFAULT_VELAD_RELEASE_SHA256,
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
