#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_LIB="${SCRIPT_DIR}/../lib/ssh.sh"
if [ ! -f "${SSH_LIB}" ]; then
  echo "ERROR: ssh library not found: ${SSH_LIB}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "${SSH_LIB}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC} $*"; }
fail() { echo -e "${RED}FAIL${NC} $*"; FAILURES=$((FAILURES + 1)); }
info() { echo -e "${CYAN}INFO${NC} $*"; }

usage() {
  cat <<'EOF'
Usage:
  bash images/tests/test-hermes-runtime.sh <user@host> [options]

Options:
  --port <port>            SSH port. Default: 22
  --runtime-user <user>    Runtime user. Default: agentuser
  --expected-hermes-version <ver>
                           Expected Hermes Agent src version. Default: runtime_hermes.src_version
                           from build-manifest.json, or latest.json when the manifest leaves it empty.
  -h, --help               Show help
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

REMOTE_HOST="${1:-}"
if [ -z "${REMOTE_HOST}" ]; then
  usage >&2
  exit 1
fi
shift

SSH_PORT=22
FAILURES=0
RUNTIME_USER="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
RUNTIME_HOME="/home/${RUNTIME_USER}"
EXPECTED_HERMES_VERSION="${EXPECTED_HERMES_VERSION:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      SSH_PORT="$2"
      shift 2
      ;;
    --runtime-user)
      RUNTIME_USER="$2"
      RUNTIME_HOME="/home/${RUNTIME_USER}"
      shift 2
      ;;
    --expected-hermes-version)
      EXPECTED_HERMES_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

remote_exec() {
  sshlib_exec_retry_transport_safe "$1"
}

remote_exec_runtime() {
  local cmd="$1"
  if [ "${SSHLIB_REMOTE_USER:-}" = "${RUNTIME_USER}" ]; then
    remote_exec "${cmd}"
    return
  fi
  local escaped
  printf -v escaped '%q' "cd ${RUNTIME_HOME} && ${cmd}"
  remote_exec "sudo -u ${RUNTIME_USER} -H bash -lc ${escaped}"
}

resolve_expected_hermes_version() {
  if [ -n "${EXPECTED_HERMES_VERSION}" ]; then
    printf '%s\n' "${EXPECTED_HERMES_VERSION}"
    return 0
  fi

  python3 - "${SCRIPT_DIR}/../build-manifest.json" <<'PY'
import json
import sys
from urllib import request

manifest_path = sys.argv[1]
try:
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
except Exception:
    raise SystemExit(0)

runtime = manifest.get("runtime_hermes") or {}
src_version = str(runtime.get("src_version") or "").strip()
if src_version:
    print(src_version)
    raise SystemExit(0)

cos_base = str(runtime.get("cos_base") or "").rstrip("/")
if not cos_base:
    raise SystemExit(0)

try:
    req = request.Request(
        f"{cos_base}/latest.json",
        headers={"Accept": "application/json", "User-Agent": "lightclaw-hermes-runtime-test/1.0"},
    )
    with request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode(resp.headers.get_content_charset() or "utf-8"))
except Exception:
    raise SystemExit(0)

src_version = str(data.get("src_version") or "").strip()
if src_version:
    print(src_version)
PY
}

sshlib_init "${REMOTE_HOST}" "${SSH_PORT}"
sshlib_ensure_ready
EXPECTED_HERMES_VERSION="$(resolve_expected_hermes_version || true)"
if [ -n "${EXPECTED_HERMES_VERSION}" ]; then
  info "expected Hermes runtime version: ${EXPECTED_HERMES_VERSION}"
else
  info "expected Hermes runtime version: unknown"
fi

info "checking runtime user"
if remote_exec "id ${RUNTIME_USER}" >/dev/null 2>&1; then
  pass "runtime user ${RUNTIME_USER} exists"
else
  fail "runtime user ${RUNTIME_USER} is missing"
fi

info "checking linger"
LINGER_OUTPUT="$(remote_exec "loginctl show-user '${RUNTIME_USER}' -p Linger --value" 2>&1 || true)"
if [ "${LINGER_OUTPUT}" = "yes" ]; then
  pass "linger is enabled for ${RUNTIME_USER}"
else
  fail "linger is not enabled for ${RUNTIME_USER}"
  echo "${LINGER_OUTPUT}"
fi

info "checking Node.js major version"
NODE_VERSION_OUTPUT="$(remote_exec "node -p 'process.versions.node'" 2>&1 || true)"
if echo "${NODE_VERSION_OUTPUT}" | grep -Eq '^22\.'; then
  pass "Node.js 22.x is installed"
else
  fail "Node.js 22.x is not installed"
  echo "${NODE_VERSION_OUTPUT}"
fi

info "checking qwen command"
QWEN_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/local/bin:/usr/bin:/bin qwen --version" 2>&1 || true)"
if echo "${QWEN_OUTPUT}" | grep -Eq '(^[0-9]+\.[0-9]+\.[0-9]+$)|qwen'; then
  pass "qwen command is available"
else
  fail "qwen command is not available"
  echo "${QWEN_OUTPUT}"
fi

info "checking hermes runtime command"
HERMES_OUTPUT="$(remote_exec_runtime '
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/hermes-agent/venv/bin
  if command -v hermes-agent >/dev/null 2>&1; then
    hermes-agent --help
  elif command -v hermes >/dev/null 2>&1; then
    hermes --help
  else
    echo MISSING
    exit 1
  fi
' 2>&1 || true)"
HERMES_COMMAND_PATHS="$(remote_exec_runtime '
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/hermes-agent/venv/bin
  command -v hermes || true
  command -v hermes-agent || true
' 2>&1 || true)"
info "hermes command paths:"
printf '%s\n' "${HERMES_COMMAND_PATHS}"
if echo "${HERMES_OUTPUT}" | grep -q 'MISSING'; then
  fail "hermes command is not available"
  echo "${HERMES_OUTPUT}"
else
  pass "hermes runtime command is available"
fi

info "checking hermes runtime version"
HERMES_VERSION_OUTPUT="$(remote_exec_runtime '
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/hermes-agent/venv/bin
  hermes --version
' 2>&1 || true)"
HERMES_BIN_VERSION="$(printf '%s\n' "${HERMES_VERSION_OUTPUT}" | grep -Eo '[0-9]+(\.[0-9]+){1,2}' | head -1 || true)"
HERMES_IDENTITY_VERSION="$(remote_exec "awk -F': *' '/^runtime_version:/ {print \$2}' /etc/acli/identity.yaml 2>/dev/null" 2>&1 || true)"
info "hermes --version output: ${HERMES_VERSION_OUTPUT}"
info "parsed hermes version: ${HERMES_BIN_VERSION}"
info "identity runtime_version: ${HERMES_IDENTITY_VERSION}"
HERMES_DIAGNOSTICS="$(remote_exec_runtime '
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  export PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.hermes/hermes-agent/venv/bin
  echo "source_pyproject_version=$(python3 - "$HOME/.hermes/hermes-agent/pyproject.toml" <<'"'"'PY'"'"'
import sys
path = sys.argv[1]
version = ""
try:
    with open(path, "r", encoding="utf-8") as fh:
        in_project = False
        for raw in fh:
            line = raw.strip()
            if line == "[project]":
                in_project = True
                continue
            if in_project and line.startswith("[") and line.endswith("]"):
                break
            if in_project and line.startswith("version"):
                version = line.split("=", 1)[1].strip().strip("\"").strip("'"'"'")
                break
except Exception as exc:
    version = f"ERROR:{exc}"
print(version)
PY
)"
  "$HOME/.hermes/hermes-agent/venv/bin/python" - <<'"'"'PY'"'"'
import importlib.metadata as md
import pathlib
import sys

try:
    import hermes_cli
except Exception as exc:
    print(f"import_error={exc}")
    raise SystemExit(0)

print(f"import_version={getattr(hermes_cli, '"'"'__version__'"'"', '"'"''"'"')}")
print(f"import_file={getattr(hermes_cli, '"'"'__file__'"'"', '"'"''"'"')}")
try:
    dist = md.distribution("hermes-agent")
except Exception as exc:
    print(f"dist_error={exc}")
    raise SystemExit(0)
print(f"dist_version={dist.version}")
for file_name in ("direct_url.json", "METADATA"):
    try:
        path = pathlib.Path(dist.locate_file("")) / f"{dist.metadata['"'"'Name'"'"'].replace('"'"'-'"'"', '"'"'_'"'"')}-{dist.version}.dist-info" / file_name
        if path.exists():
            print(f"dist_{file_name}={path}")
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[:8]:
                print(f"  {line}")
    except Exception as exc:
        print(f"dist_{file_name}_error={exc}")
PY
' 2>&1 || true)"
info "hermes package diagnostics:"
printf '%s\n' "${HERMES_DIAGNOSTICS}"
if [ -n "${HERMES_BIN_VERSION}" ] && [ -n "${HERMES_IDENTITY_VERSION}" ] && [ "${HERMES_BIN_VERSION}" = "${HERMES_IDENTITY_VERSION}" ]; then
  pass "hermes runtime version matches identity: ${HERMES_BIN_VERSION}"
else
  fail "hermes runtime version does not match identity"
  echo "hermes --version output: ${HERMES_VERSION_OUTPUT}"
  echo "parsed hermes version: ${HERMES_BIN_VERSION}"
  echo "identity runtime_version: ${HERMES_IDENTITY_VERSION}"
fi
if [ -z "${EXPECTED_HERMES_VERSION}" ]; then
  info "skipping exact Hermes latest metadata version check"
elif [ "${HERMES_BIN_VERSION}" = "${EXPECTED_HERMES_VERSION}" ]; then
  pass "hermes runtime version matches expected metadata: ${EXPECTED_HERMES_VERSION}"
else
  fail "hermes runtime version does not match expected metadata"
  echo "expected hermes version: ${EXPECTED_HERMES_VERSION}"
  echo "actual hermes version: ${HERMES_BIN_VERSION:-<empty>}"
  echo "hermes --version output: ${HERMES_VERSION_OUTPUT}"
fi

info "checking hermes command topology"
HERMES_TOPOLOGY_OUTPUT="$(remote_exec_runtime '
  set -e
  export HOME='"${RUNTIME_HOME}"'
  export USER='"${RUNTIME_USER}"'
  for p in /usr/local/bin/hermes /usr/local/bin/hermes-agent; do
    test -x "$p"
    test ! -L "$p"
  done
  test "$(readlink -f /usr/bin/hermes)" = /usr/local/bin/hermes
  test "$(readlink -f /usr/bin/hermes-agent)" = /usr/local/bin/hermes-agent
  head -1 "$HOME/.hermes/hermes-agent/venv/bin/hermes"
  head -1 "$HOME/.hermes/hermes-agent/venv/bin/hermes-agent"
' 2>&1 || true)"
info "hermes topology output:"
printf '%s\n' "${HERMES_TOPOLOGY_OUTPUT}"
if echo "${HERMES_TOPOLOGY_OUTPUT}" | grep -q '^#!.*python'; then
  pass "hermes command topology is standardized"
else
  fail "hermes command topology is not standardized"
  echo "${HERMES_TOPOLOGY_OUTPUT}"
fi

info "checking hermes profile"
PROFILE_OUTPUT="$(remote_exec "test -f /etc/profile.d/hermes-env.sh && cat /etc/profile.d/hermes-env.sh" 2>&1 || true)"
if echo "${PROFILE_OUTPUT}" | grep -q '\$HOME/.hermes/hermes-agent/venv/bin' && echo "${PROFILE_OUTPUT}" | grep -q '\$HOME/.local/bin'; then
  pass "hermes profile exports hermes and local bin paths"
else
  fail "hermes profile is missing expected PATH exports"
  echo "${PROFILE_OUTPUT}"
fi

info "checking skillhub command"
SKILLHUB_OUTPUT="$(remote_exec_runtime "env -i HOME=${RUNTIME_HOME} USER=${RUNTIME_USER} PATH=/usr/local/bin:/usr/bin:/bin:${RUNTIME_HOME}/.local/bin skillhub --help" 2>&1 || true)"
if echo "${SKILLHUB_OUTPUT}" | grep -Eqi 'skillhub|usage'; then
  pass "skillhub command is available"
else
  fail "skillhub command is not available"
  echo "${SKILLHUB_OUTPUT}"
fi

info "checking lightclawbot Hermes plugin"
LIGHTCLAWBOT_OUTPUT="$(remote_exec_runtime '
  set -euo pipefail
  export HOME='"${RUNTIME_HOME}"'
  plugin_dir="$HOME/.hermes/plugins/lightclawbot"
  config_file="$HOME/.hermes/config.yaml"
  test -f "$plugin_dir/plugin.yaml"
  grep -q "^name: lightclawbot$" "$plugin_dir/plugin.yaml"
  grep -q "lightclawbot" "$config_file"
  if [ -f "$HOME/.hermes/.env" ]; then
    ! grep -q "^LIGHTCLAW_API_KEY" "$HOME/.hermes/.env"
  fi
  echo "lightclawbot-plugin-ok"
' 2>&1 || true)"
if echo "${LIGHTCLAWBOT_OUTPUT}" | grep -q 'lightclawbot-plugin-ok' \
  && ! echo "${LIGHTCLAWBOT_OUTPUT}" | grep -Eqi 'no such file|not found|error'; then
  pass "lightclawbot plugin is preinstalled and enabled"
else
  fail "lightclawbot plugin is not preinstalled correctly"
  echo "${LIGHTCLAWBOT_OUTPUT}"
fi

info "checking Hermes bundled skill curation"
HERMES_SKILLS_OUTPUT="$(remote_exec_runtime '
  set -euo pipefail
  export HOME='"${RUNTIME_HOME}"'
  skills_root="$HOME/.hermes/skills"
  if [ ! -d "$skills_root" ]; then
    echo "skills-root-missing"
    exit 0
  fi
  python3 - "$skills_root" <<'"'"'PY'"'"'
import os
import sys

root = sys.argv[1]
keep = {
    "autonomous-ai-agents/hermes-agent",
    "software-development/hermes-agent-skill-authoring",
    "software-development/plan",
    "software-development/spike",
    "software-development/systematic-debugging",
    "software-development/test-driven-development",
    "software-development/requesting-code-review",
    "github/codebase-inspection",
    "software-development/node-inspect-debugger",
    "software-development/python-debugpy",
    "dogfood",
    "productivity/ocr-and-documents",
    "productivity/nano-pdf",
    "productivity/powerpoint",
    "research/arxiv",
    "productivity/maps",
    "creative/architecture-diagram",
    "creative/humanizer",
}
found = []
for dirpath, _, filenames in os.walk(root):
    if "SKILL.md" in filenames:
        found.append(os.path.relpath(dirpath, root))
extra = sorted(set(found) - keep)
if extra:
    print("extra-skills:")
    print("\n".join(extra))
    raise SystemExit(1)
print("curated-skills-ok")
PY
' 2>&1 || true)"
if echo "${HERMES_SKILLS_OUTPUT}" | grep -Eq 'curated-skills-ok|skills-root-missing' \
  && ! echo "${HERMES_SKILLS_OUTPUT}" | grep -q '^extra-skills:'; then
  pass "Hermes bundled skills are curated"
else
  fail "Hermes bundled skills are not curated"
  echo "${HERMES_SKILLS_OUTPUT}"
fi

info "checking WhatsApp bridge Node dependencies"
WHATSAPP_BRIDGE_OUTPUT="$(remote_exec_runtime 'set -euo pipefail; export HOME='"${RUNTIME_HOME}"'; export HERMES_HOME='"${RUNTIME_HOME}"'/.hermes; cd '"${RUNTIME_HOME}"'/.hermes/hermes-agent/scripts/whatsapp-bridge; node -e '"'"'for (const m of ["@whiskeysockets/baileys","qrcode-terminal","express","pino"]) console.log(m, require.resolve(m))'"'" 2>&1 || true)"
info "whatsapp bridge dependency output:"
printf '%s\n' "${WHATSAPP_BRIDGE_OUTPUT}"
if echo "${WHATSAPP_BRIDGE_OUTPUT}" | grep -q '@whiskeysockets/baileys' \
  && echo "${WHATSAPP_BRIDGE_OUTPUT}" | grep -q 'qrcode-terminal' \
  && echo "${WHATSAPP_BRIDGE_OUTPUT}" | grep -q 'express' \
  && echo "${WHATSAPP_BRIDGE_OUTPUT}" | grep -q 'pino' \
  && ! echo "${WHATSAPP_BRIDGE_OUTPUT}" | grep -Eqi 'cannot find module|error|no such file'; then
  pass "WhatsApp bridge Node dependencies are available"
else
  fail "WhatsApp bridge Node dependencies are not available"
  echo "${WHATSAPP_BRIDGE_OUTPUT}"
fi

info "checking Hermes Python integration dependencies"
HERMES_PYTHON_DEPS_OUTPUT="$(remote_exec_runtime 'set -euo pipefail; '"${RUNTIME_HOME}"'/.hermes/hermes-agent/venv/bin/python -c '"'"'import lark_oapi, qrcode; print("hermes-python-deps-ok")'"'" 2>&1 || true)"
if echo "${HERMES_PYTHON_DEPS_OUTPUT}" | grep -q 'hermes-python-deps-ok' \
  && ! echo "${HERMES_PYTHON_DEPS_OUTPUT}" | grep -Eqi 'moduleNotFoundError|importError|no such file|error'; then
  pass "Hermes Python integration dependencies are available"
else
  fail "Hermes Python integration dependencies are not available"
  echo "${HERMES_PYTHON_DEPS_OUTPUT}"
fi

info "checking acli command"
ACLI_OUTPUT="$(remote_exec_runtime "if command -v acli >/dev/null 2>&1; then acli --help >/dev/null && acli doctor; else echo MISSING; exit 1; fi" 2>&1 || true)"
if echo "${ACLI_OUTPUT}" | grep -Eqi 'error|failed|missing'; then
  fail "acli doctor failed"
  echo "${ACLI_OUTPUT}"
  info "acli diagnostic context"
  remote_exec_runtime '
    set +e
    echo "acli_path=$(command -v acli || true)"
    acli --version 2>&1 || true
    echo "--- /etc/acli/identity.yaml ---"
    sed -n "1,120p" /etc/acli/identity.yaml 2>/dev/null || true
    echo "--- hermes version ---"
    hermes --version 2>&1 || true
    echo "--- runtime paths ---"
    ls -ld "$HOME" "$HOME/.hermes" "$HOME/.hermes/hermes-agent" "$HOME/.hermes/hermes-agent/venv/bin" 2>&1 || true
  ' 2>&1 || true
else
  pass "acli command is available"
fi

info "checking acli identity"
ACLI_IDENTITY_OUTPUT="$(remote_exec "test -f /etc/acli/identity.yaml && grep -E '^(product|run_as|runtime|runtime_bin|runtime_home|runtime_version):' /etc/acli/identity.yaml" 2>&1 || true)"
info "acli identity runtime fields:"
printf '%s\n' "${ACLI_IDENTITY_OUTPUT}"
if echo "${ACLI_IDENTITY_OUTPUT}" | grep -q '^product: lightvela$' \
  && echo "${ACLI_IDENTITY_OUTPUT}" | grep -q '^run_as: '"${RUNTIME_USER}"'$' \
  && echo "${ACLI_IDENTITY_OUTPUT}" | grep -q '^runtime: hermes$' \
  && echo "${ACLI_IDENTITY_OUTPUT}" | grep -q '^runtime_bin: '"${RUNTIME_HOME}"'/.hermes/hermes-agent/venv/bin/hermes$' \
  && echo "${ACLI_IDENTITY_OUTPUT}" | grep -q '^runtime_home: '"${RUNTIME_HOME}"'/.hermes$'; then
  pass "acli identity targets lightvela hermes runtime"
else
  fail "acli identity does not target lightvela hermes runtime"
  echo "${ACLI_IDENTITY_OUTPUT}"
fi

info "checking root account lock"
ROOT_STATUS="$(remote_exec "sudo passwd -S root 2>/dev/null | awk '{print \$2}'" 2>&1 || true)"
if [ "${ROOT_STATUS}" = "L" ]; then
  pass "root account is locked"
else
  fail "root account is not locked"
  echo "${ROOT_STATUS}"
fi

if [ "${FAILURES}" -eq 0 ]; then
  echo -e "${GREEN}all hermes runtime checks passed${NC}"
  exit 0
fi

echo -e "${RED}${FAILURES} hermes runtime check(s) failed${NC}"
exit 1
