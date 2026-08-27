#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

readonly PNPM_VERSION="10.33.0"
readonly RUNTIME_USER="agentuser"
readonly DSH_PORT="3080"
readonly SERVICE_NAME="deepseek-harness.service"
readonly NPM_REGISTRY="https://registry.npmjs.org/"
readonly DSH_SPEC="@deepseek-ai/dsh@latest"
readonly SKILLHUB_SPEC="@cocofhu/skillhub@latest"
readonly QQBOT_SPEC="deepseek-harness-qqbot@latest"
readonly WEIXIN_SPEC="deepseek-harness-weixin@latest"
readonly WECOM_SPEC="deepseek-harness-wecom@latest"
readonly LARK_SPEC="deepseek-harness-lark@latest"
readonly DINGTALK_SPEC="deepseek-harness-dingtalk@latest"

TEST_MODE="${LIGHTVELA_DSH_TEST_MODE:-0}"
TEST_ROOT="${LIGHTVELA_DSH_TEST_ROOT:-}"
HEALTH_ATTEMPTS="${LIGHTVELA_DSH_HEALTH_ATTEMPTS:-60}"
STABILITY_CHECKS="${LIGHTVELA_DSH_STABILITY_CHECKS:-5}"

root_path() {
  if [ "${TEST_MODE}" = "1" ]; then
    printf '%s%s' "${TEST_ROOT}" "$1"
  else
    printf '%s' "$1"
  fi
}

RUNTIME_HOME="$(root_path "/home/${RUNTIME_USER}")"
DSH_HOME="${RUNTIME_HOME}/.dsh"
LIVE_PROFILE="${DSH_HOME}/profiles/web"
RELEASES_DIR="$(root_path /opt/lightvela/dsh/releases)"
CURRENT_LINK="$(root_path /opt/lightvela/dsh/current)"
TOOLING_ROOT="$(root_path /opt/lightvela/dsh/tooling)"
PNPM_TOOLING_DIR="${TOOLING_ROOT}/pnpm-${PNPM_VERSION}"
STATE_DIR="$(root_path /var/lib/lightvela/dsh/installations)"
WORK_ROOT="$(root_path /var/lib/lightvela/dsh/work)"
LOCK_FILE="$(root_path /var/lock/lightvela-deepseek-harness.lock)"
UNIT_PATH="$(root_path "/etc/systemd/system/${SERVICE_NAME}")"

TASK_ID=""
TRUSTED_BROWSER_HOST=""
CURRENT_STAGE="prepare"
DSH_VERSION=""
SKILLHUB_VERSION=""
SNAPSHOT_ID=""
TARGET_RELEASE=""
CANDIDATE_RUNTIME=""
RUNTIME_REUSED=false
PNPM_BIN="pnpm"

log() {
  printf '[lightvela-dsh] %s\n' "$*"
}

fail() {
  printf '[lightvela-dsh] ERROR: %s\n' "$*" >&2
  return 1
}

require_root() {
  if [ "${TEST_MODE}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
    fail "installer must run as root"
  fi
}

validate_task_id() {
  [[ "$1" =~ ^dshi-[0-9a-f]{32}$ ]]
}

parse_task_id() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --task-id)
        [ "$#" -ge 2 ] || return 1
        TASK_ID="$2"
        shift 2
        ;;
      *) return 1 ;;
    esac
  done
  validate_task_id "${TASK_ID}"
}

validate_trusted_browser_host() {
  [[ "$1" =~ ^ins-[0-9a-f]{32}\.dsh\.lightvela\.(site|tech)$ ]]
}

parse_install_arguments() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --task-id)
        [ "$#" -ge 2 ] || return 1
        TASK_ID="$2"
        shift 2
        ;;
      --trusted-browser-host)
        [ "$#" -ge 2 ] || return 1
        TRUSTED_BROWSER_HOST="$2"
        shift 2
        ;;
      *) return 1 ;;
    esac
  done
  validate_task_id "${TASK_ID}" && validate_trusted_browser_host "${TRUSTED_BROWSER_HOST}"
}

task_file() {
  printf '%s/%s.json' "${STATE_DIR}" "$1"
}

write_task() {
  local status="$1"
  local stage="$2"
  local progress="$3"
  local message="$4"
  local error_message="${5:-}"
  local manifest_path="${6:-}"
  local destination
  destination="$(task_file "${TASK_ID}")"
  mkdir -p "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}"
  python3 - "${destination}" "${TASK_ID}" "${status}" "${stage}" "${progress}" \
    "${message}" "${error_message}" "${manifest_path}" <<'PY'
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

path, task_id, status, stage, progress, message, error, manifest_path = sys.argv[1:]
payload = {
    "task_id": task_id,
    "status": status,
    "stage": stage,
    "progress": int(progress),
    "message": message,
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
if error:
    payload["error"] = error
if manifest_path and os.path.isfile(manifest_path):
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    payload["release_id"] = manifest.get("snapshotId")
    payload["resolved"] = {
        "dsh": manifest.get("runtime", {}),
        "plugins": manifest.get("profile", {}).get("plugins", []),
    }
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=f"{task_id}.", suffix=".tmp", dir=directory)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
        handle.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PY
}

run_as_runtime_user_in() {
  local dsh_home="$1"
  local runtime_dir="$2"
  shift 2
  local pnpm_dir=""
  local runtime_path=""
  if [[ "${PNPM_BIN}" == */* ]]; then
    pnpm_dir="$(dirname "${PNPM_BIN}"):"
  fi
  runtime_path="${runtime_dir}/node_modules/.bin:${pnpm_dir}/usr/local/bin:/usr/bin:/bin"
  if [ "${TEST_MODE}" = "1" ]; then
    runtime_path="${runtime_dir}/node_modules/.bin:${pnpm_dir}${PATH}"
  fi
  sudo -n -u "${RUNTIME_USER}" -H env \
    HOME="${RUNTIME_HOME}" \
    DSH_HOME="${dsh_home}" \
    PATH="${runtime_path}" \
    npm_config_registry="${NPM_REGISTRY}" \
    "$@"
}

ensure_base_tools() {
  local missing=()
  local command_name=""
  for command_name in curl python3 npm flock ss; do
    command -v "${command_name}" >/dev/null 2>&1 || missing+=("${command_name}")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    return 0
  fi
  if [ "${TEST_MODE}" = "1" ]; then
    fail "missing required test command: ${missing[*]}"
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=300 update -o Acquire::Retries=3
  apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends \
    ca-certificates curl iproute2 python3 npm util-linux
}

ensure_node_runtime() {
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed"
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if ! [[ "${major}" =~ ^[0-9]+$ ]] || [ "${major}" -lt 22 ]; then
    fail "DeepSeek Harness requires Node.js 22 or newer"
  fi
}

ensure_build_toolchain() {
  if command -v g++ >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
    return 0
  fi
  if [ "${TEST_MODE}" = "1" ]; then
    return 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=300 update -o Acquire::Retries=3
  apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends build-essential
}

normalize_pnpm_tooling_permissions() {
  [ -d "${PNPM_TOOLING_DIR}" ] || return 0
  chmod -R a+rX,u+w,go-w "${PNPM_TOOLING_DIR}"
}

ensure_pnpm_runtime() {
  local tooling_stage="$1"
  if command -v pnpm >/dev/null 2>&1 \
    && [ "$(pnpm --version | head -n 1 | tr -d '\r')" = "${PNPM_VERSION}" ]; then
    PNPM_BIN="$(command -v pnpm)"
    return 0
  fi
  PNPM_BIN="${PNPM_TOOLING_DIR}/node_modules/.bin/pnpm"
  normalize_pnpm_tooling_permissions
  if [ -x "${PNPM_BIN}" ] \
    && [ "$("${PNPM_BIN}" --version | head -n 1 | tr -d '\r')" = "${PNPM_VERSION}" ]; then
    return 0
  fi
  rm -rf -- "${tooling_stage}"
  npm_config_registry="${NPM_REGISTRY}" \
    npm_config_fetch_retries=4 \
    npm_config_fetch_retry_maxtimeout=300000 \
    npm install --prefix "${tooling_stage}" --no-save --package-lock=false \
      --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
  test -x "${tooling_stage}/node_modules/.bin/pnpm"
  test "$("${tooling_stage}/node_modules/.bin/pnpm" --version | head -n 1 | tr -d '\r')" = "${PNPM_VERSION}"
  mkdir -p "${TOOLING_ROOT}"
  rm -rf -- "${PNPM_TOOLING_DIR}"
  mv "${tooling_stage}" "${PNPM_TOOLING_DIR}"
  if [ "${TEST_MODE}" != "1" ]; then
    chown -R root:root "${PNPM_TOOLING_DIR}"
  fi
  normalize_pnpm_tooling_permissions
  PNPM_BIN="${PNPM_TOOLING_DIR}/node_modules/.bin/pnpm"
}

validate_existing_profile() {
  if [ ! -e "${LIVE_PROFILE}" ]; then
    return 0
  fi
  if [ ! -f "${LIVE_PROFILE}/package.json" ]; then
    fail "existing DeepSeek Harness web profile has no package.json"
  fi
  python3 - "${LIVE_PROFILE}/package.json" <<'PY'
import json
import sys

allowed = {
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@cocofhu/skillhub",
    "deepseek-harness-qqbot",
    "deepseek-harness-weixin",
    "deepseek-harness-wecom",
    "deepseek-harness-lark",
    "deepseek-harness-dingtalk",
}
with open(sys.argv[1], encoding="utf-8") as handle:
    profile = json.load(handle)
for field in ("dependencies", "devDependencies", "optionalDependencies"):
    unknown = set(profile.get(field, {})) - allowed
    if unknown:
        raise SystemExit(f"unmanaged DeepSeek Harness profile dependencies: {sorted(unknown)}")
bundles = profile.get("dsh", {}).get("profile", {}).get("bundles", [])
unknown = set(bundles) - allowed
if unknown:
    raise SystemExit(f"unmanaged DeepSeek Harness profile bundles: {sorted(unknown)}")
PY
}

profile_fingerprint() {
  python3 - "${LIVE_PROFILE}" <<'PY'
import hashlib
import os
import sys

root = sys.argv[1]
digest = hashlib.sha256()
if not os.path.exists(root):
    print("absent")
    raise SystemExit(0)
for name in ("package.json", "pnpm-lock.yaml", ".pnpmfile.cjs", "pnpm-workspace.yaml", "cordis.patch.yml"):
    path = os.path.join(root, name)
    digest.update(name.encode())
    if os.path.isfile(path):
        digest.update(b"\0present\0")
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    else:
        digest.update(b"\0absent\0")
print(digest.hexdigest())
PY
}

resolve_registry_metadata() {
  local specification="$1"
  local destination="$2"
  npm_config_registry="${NPM_REGISTRY}" \
    npm_config_fetch_retries=4 \
    npm_config_fetch_retry_maxtimeout=300000 \
    npm view "${specification}" version dist.integrity dist.tarball --json >"${destination}"
}

resolve_latest_snapshot() {
  local work_dir="$1"
  local manifest_path="$2"
  local dsh_metadata="${work_dir}/dsh-npm.json"
  local skillhub_metadata="${work_dir}/skillhub-npm.json"
  local qqbot_metadata="${work_dir}/qqbot-npm.json"
  local weixin_metadata="${work_dir}/weixin-npm.json"
  local wecom_metadata="${work_dir}/wecom-npm.json"
  local lark_metadata="${work_dir}/lark-npm.json"
  local dingtalk_metadata="${work_dir}/dingtalk-npm.json"
  resolve_registry_metadata "${DSH_SPEC}" "${dsh_metadata}"
  resolve_registry_metadata "${SKILLHUB_SPEC}" "${skillhub_metadata}"
  resolve_registry_metadata "${QQBOT_SPEC}" "${qqbot_metadata}"
  resolve_registry_metadata "${WEIXIN_SPEC}" "${weixin_metadata}"
  resolve_registry_metadata "${WECOM_SPEC}" "${wecom_metadata}"
  resolve_registry_metadata "${LARK_SPEC}" "${lark_metadata}"
  resolve_registry_metadata "${DINGTALK_SPEC}" "${dingtalk_metadata}"
  python3 - "${dsh_metadata}" "${skillhub_metadata}" \
    "${qqbot_metadata}" "${weixin_metadata}" "${wecom_metadata}" \
    "${lark_metadata}" "${dingtalk_metadata}" "${manifest_path}" \
    "${PNPM_VERSION}" "${TRUSTED_BROWSER_HOST}" <<'PY'
import json
import re
import sys
from datetime import datetime, timezone

(
    dsh_path, skillhub_path, qqbot_path, weixin_path, wecom_path,
    lark_path, dingtalk_path, output_path, pnpm_version, trusted_browser_host,
) = sys.argv[1:]

def registry(path, expected_name):
    with open(path, encoding="utf-8") as handle:
        value = json.load(handle)
    version = value.get("version")
    integrity = value.get("dist.integrity")
    tarball = value.get("dist.tarball")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", version):
        raise SystemExit(f"invalid latest version for {expected_name}")
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        raise SystemExit(f"missing npm integrity for {expected_name}")
    if not isinstance(tarball, str) or not tarball.startswith("https://"):
        raise SystemExit(f"invalid npm tarball for {expected_name}")
    return {
        "package": expected_name,
        "requested": "latest",
        "version": version,
        "integrity": integrity,
        "tarball": tarball,
    }

def plugin(plugin_id, path, package_name):
    return {"id": plugin_id, "source": "npm", **registry(path, package_name)}

manifest = {
    "schemaVersion": 3,
    "resolvedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "pnpmVersion": pnpm_version,
    "browserTrustPatch": {
        "version": 1,
        "hostname": trusted_browser_host,
    },
    "runtime": registry(dsh_path, "@deepseek-ai/dsh"),
    "profile": {
        "name": "web",
        "builtInBundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        "plugins": [
            plugin("skillhub", skillhub_path, "@cocofhu/skillhub"),
            plugin("qqbot", qqbot_path, "deepseek-harness-qqbot"),
            plugin("weixin", weixin_path, "deepseek-harness-weixin"),
            plugin("wecom", wecom_path, "deepseek-harness-wecom"),
            plugin("lark", lark_path, "deepseek-harness-lark"),
            plugin("dingtalk", dingtalk_path, "deepseek-harness-dingtalk"),
        ],
    },
}
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=True, indent=2, sort_keys=True)
    handle.write("\n")
PY
}

finalize_snapshot() {
  local manifest_path="$1"
  local resolved
  resolved="$(python3 - "${manifest_path}" <<'PY'
import hashlib
import json
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)
snapshot_material = dict(manifest)
snapshot_material.pop("resolvedAt", None)
snapshot_material.pop("snapshotId", None)
canonical = json.dumps(snapshot_material, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
snapshot_hash = hashlib.sha256(canonical).hexdigest()
version = manifest["runtime"]["version"]
if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._+-]*", version):
    raise SystemExit("invalid DSH version")
snapshot_id = f"{version}-{snapshot_hash[:12]}"
manifest["snapshotId"] = snapshot_id
with open(path, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=True, indent=2, sort_keys=True)
    handle.write("\n")
skillhub = next(item for item in manifest["profile"]["plugins"] if item["id"] == "skillhub")
print("\t".join((version, skillhub["version"], snapshot_id)))
PY
)"
  IFS=$'\t' read -r DSH_VERSION SKILLHUB_VERSION SNAPSHOT_ID <<<"${resolved}"
  test -n "${DSH_VERSION}"
  test -n "${SKILLHUB_VERSION}"
  [[ "${SNAPSHOT_ID}" =~ ^[0-9A-Za-z._+-]+-[0-9a-f]{12}$ ]]
}

find_reusable_release() {
  local manifest_path="$1"
  if python3 - "${RELEASES_DIR}" "${CURRENT_LINK}" "${manifest_path}" <<'PY'
import json
import os
import pathlib
import sys

releases_path, current_link, target_manifest_path = sys.argv[1:]
releases = pathlib.Path(releases_path)
if not releases.is_dir():
    raise SystemExit(1)

with open(target_manifest_path, encoding="utf-8") as handle:
    target = json.load(handle)

def snapshot_material(value):
    result = dict(value)
    result.pop("resolvedAt", None)
    result.pop("snapshotId", None)
    return result

candidates = []
try:
    current = pathlib.Path(current_link).resolve(strict=True)
except (FileNotFoundError, OSError):
    current = None
if current is not None:
    candidates.append(current)

for candidate in sorted(
    releases.iterdir(),
    key=lambda path: path.stat().st_mtime if path.exists() else 0,
    reverse=True,
):
    if candidate.name.startswith(".staging-") or candidate in candidates:
        continue
    candidates.append(candidate)

resolved_releases = releases.resolve()
for candidate in candidates:
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError):
        continue
    if not resolved.is_dir() or resolved.parent != resolved_releases:
        continue
    manifest_path = resolved / "install-manifest.json"
    dsh_binary = resolved / "node_modules" / ".bin" / "dsh"
    if not manifest_path.is_file() or not os.access(dsh_binary, os.X_OK):
        continue
    try:
        with manifest_path.open(encoding="utf-8") as handle:
            installed = json.load(handle)
    except (OSError, ValueError):
        continue
    if installed.get("snapshotId") != target.get("snapshotId"):
        continue
    if snapshot_material(installed) != snapshot_material(target):
        continue
    print(resolved)
    raise SystemExit(0)
raise SystemExit(1)
PY
  then
    return 0
  fi
  return 1
}

normalize_managed_release() {
  local candidate="$1"
  [ -n "${candidate}" ] || return 0
  if python3 - "${RELEASES_DIR}" "${candidate}" <<'PY'
import pathlib
import sys

releases_path, candidate_path = sys.argv[1:]
try:
    releases = pathlib.Path(releases_path).resolve(strict=True)
    candidate = pathlib.Path(candidate_path).resolve(strict=True)
except (FileNotFoundError, OSError):
    raise SystemExit(1)
if candidate.parent != releases or not candidate.is_dir() or candidate.name.startswith(".staging-"):
    raise SystemExit(1)
print(candidate)
PY
  then
    return 0
  fi
  return 0
}

newest_other_release() {
  local current_release="$1"
  if python3 - "${RELEASES_DIR}" "${current_release}" <<'PY'
import pathlib
import sys

releases_path, current_path = sys.argv[1:]
releases = pathlib.Path(releases_path).resolve(strict=True)
current = pathlib.Path(current_path).resolve(strict=True)
candidates = []
for child in releases.iterdir():
    if child.name.startswith(".staging-"):
        continue
    try:
        resolved = child.resolve(strict=True)
    except (FileNotFoundError, OSError):
        continue
    if resolved.parent == releases and resolved.is_dir() and resolved != current:
        candidates.append((resolved.stat().st_mtime, resolved.name, resolved))
if not candidates:
    raise SystemExit(1)
print(max(candidates)[2])
PY
  then
    return 0
  fi
  return 0
}

prune_old_releases() {
  local current_candidate="$1"
  local previous_candidate="${2:-}"
  local current_release previous_release="" release normalized
  current_release="$(normalize_managed_release "${current_candidate}")"
  [ -n "${current_release}" ] || fail "current DeepSeek Harness release is unmanaged"
  if normalized="$(normalize_managed_release "${previous_candidate}" 2>/dev/null)" \
    && [ -n "${normalized}" ] \
    && [ "${normalized}" != "${current_release}" ]; then
    previous_release="${normalized}"
  else
    previous_release="$(newest_other_release "${current_release}" 2>/dev/null)"
  fi

  while IFS= read -r -d '' release; do
    normalized="$(normalize_managed_release "${release}" 2>/dev/null)"
    [ -n "${normalized}" ] || continue
    if [ "${normalized}" = "${current_release}" ] \
      || { [ -n "${previous_release}" ] && [ "${normalized}" = "${previous_release}" ]; }; then
      continue
    fi
    rm -rf -- "${normalized}"
  done < <(find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d -print0)
}

remove_managed_install_artifacts() {
  local root="$1"
  local artifact_type="$2"
  local name_pattern="$3"
  local candidate=""
  local name=""
  local -a find_type=(-type f)
  [ -d "${root}" ] || return 0
  if [ "${artifact_type}" = "directory" ]; then
    find_type=(-type d)
  fi
  while IFS= read -r -d '' candidate; do
    name="${candidate##*/}"
    [[ "${name}" =~ ${name_pattern} ]] || continue
    if [ "${artifact_type}" = "directory" ]; then
      rm -rf -- "${candidate}"
    else
      rm -f -- "${candidate}"
    fi
  done < <(find "${root}" -mindepth 1 -maxdepth 1 "${find_type[@]}" -print0)
}

cleanup_abandoned_install_artifacts() {
  remove_managed_install_artifacts \
    "${RELEASES_DIR}" directory '^\.staging-dshi-[0-9a-f]{32}$'
  remove_managed_install_artifacts \
    "${DSH_HOME}" directory '^\.staging-dshi-[0-9a-f]{32}$'
  remove_managed_install_artifacts \
    "${DSH_HOME}/profiles" directory '^\.backup-dshi-[0-9a-f]{32}$'
  remove_managed_install_artifacts \
    "${TOOLING_ROOT}" directory '^\.pnpm-staging-dshi-[0-9a-f]{32}$'
  remove_managed_install_artifacts \
    "${WORK_ROOT}" directory '^dshi-[0-9a-f]{32}$'
  remove_managed_install_artifacts \
    "$(dirname "${UNIT_PATH}")" file \
    '^deepseek-harness\.service\.(candidate|backup)-dshi-[0-9a-f]{32}$'
}

write_candidate_inputs() {
  local manifest_path="$1"
  local runtime_dir="$2"
  local profile_dir="$3"
  mkdir -p "${profile_dir}"
  if [ -n "${runtime_dir}" ]; then
    mkdir -p "${runtime_dir}"
  fi
  python3 - "${manifest_path}" "${runtime_dir}" "${profile_dir}" <<'PY'
import json
import os
import pathlib
import sys

manifest_path, runtime_dir, profile_dir = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
dsh_version = manifest["runtime"]["version"]
pnpm_version = manifest["pnpmVersion"]
plugins = manifest["profile"]["plugins"]
common_pnpm = {
    "onlyBuiltDependencies": ["@deepseek-ai/dsh-subprocess-local", "koffi", "node-pty"],
    "ignoredBuiltDependencies": ["@google/genai", "protobufjs"],
}
runtime = {
    "name": "@lightvela/deepseek-harness-runtime",
    "private": True,
    "packageManager": f"pnpm@{pnpm_version}",
    "dependencies": {"@deepseek-ai/dsh": dsh_version},
    "pnpm": common_pnpm,
}
dependencies = {}
for item in plugins:
    if item["source"] != "npm":
        raise SystemExit(f"unsupported profile plugin source: {item['source']}")
    dependencies[item["package"]] = item["version"]
profile = {
    "name": "@lightvela/deepseek-harness-web-profile",
    "private": True,
    "packageManager": f"pnpm@{pnpm_version}",
    "dependencies": dependencies,
    "dsh": {"profile": {"bundles": [
        *manifest["profile"]["builtInBundles"],
        *(item["package"] for item in plugins),
    ]}},
    "pnpm": common_pnpm,
}
hook = f'''const DSH_RELEASE = {json.dumps(dsh_version)};

function pinDshRelease(dependencies) {{
  if (!dependencies) return;
  for (const name of Object.keys(dependencies)) {{
    if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) {{
      dependencies[name] = DSH_RELEASE;
    }}
  }}
}}

module.exports = {{
  hooks: {{
    readPackage(pkg) {{
      pinDshRelease(pkg.dependencies);
      pinDshRelease(pkg.optionalDependencies);
      pinDshRelease(pkg.peerDependencies);
      return pkg;
    }},
  }},
}};
'''
workspace = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"

def write_json(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=True, indent=2)
        handle.write("\n")

if runtime_dir:
    write_json(os.path.join(runtime_dir, "package.json"), runtime)
    pathlib.Path(runtime_dir, ".pnpmfile.cjs").write_text(hook, encoding="utf-8")
write_json(os.path.join(profile_dir, "package.json"), profile)
pathlib.Path(profile_dir, ".pnpmfile.cjs").write_text(hook, encoding="utf-8")
pathlib.Path(profile_dir, "pnpm-workspace.yaml").write_text(workspace, encoding="utf-8")
PY
}

validate_profile_tree() {
  local profile_dir="$1"
  local manifest_path="$2"
  python3 - "${profile_dir}" "${manifest_path}" <<'PY'
import json
import os
import sys

root, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
with open(os.path.join(root, "package.json"), encoding="utf-8") as handle:
    profile = json.load(handle)
plugins = manifest["profile"]["plugins"]
expected_bundles = [*manifest["profile"]["builtInBundles"], *(item["package"] for item in plugins)]
if profile.get("dsh", {}).get("profile", {}).get("bundles") != expected_bundles:
    raise SystemExit("DeepSeek Harness web profile bundle list does not match the snapshot")
for item in plugins:
    package_path = os.path.join(root, "node_modules", *item["package"].split("/"), "package.json")
    if not os.path.isfile(package_path):
        raise SystemExit(f"missing DeepSeek Harness profile plugin: {item['package']}")
    with open(package_path, encoding="utf-8") as handle:
        package = json.load(handle)
    if package.get("name") != item["package"] or package.get("version") != item["version"]:
        raise SystemExit(f"plugin snapshot mismatch: {item['package']}")
    if not package.get("dsh", {}).get("bundle", {}).get("patch"):
        raise SystemExit(f"plugin bundle declaration is missing: {item['package']}")
PY
}

validate_dsh_family() {
  local runtime_dir="$1"
  local manifest_path="$2"
  python3 - "${runtime_dir}" "${manifest_path}" <<'PY'
import json
import os
import sys

root, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    expected = json.load(handle)["runtime"]["version"]
seen = set()
for directory, _, files in os.walk(os.path.join(root, "node_modules")):
    if "package.json" not in files:
        continue
    path = os.path.join(directory, "package.json")
    try:
        with open(path, encoding="utf-8") as handle:
            package = json.load(handle)
    except (OSError, ValueError):
        continue
    name = package.get("name")
    if name == "@deepseek-ai/dsh" or (isinstance(name, str) and name.startswith("@deepseek-ai/dsh-")):
        version = package.get("version")
        seen.add((name, version))
        if version != expected:
            raise SystemExit(f"mixed DSH package family: {name}@{version}, expected {expected}")
if not any(name == "@deepseek-ai/dsh" for name, _ in seen):
    raise SystemExit("installed DSH package was not found")
PY
}

patch_browser_connection() {
  local runtime_dir="$1"
  local manifest_path="$2"
  python3 - "${runtime_dir}" "${manifest_path}" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

runtime_dir, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    patch = json.load(handle)["browserTrustPatch"]
hostname = patch["hostname"]
version = patch["version"]
if version != 1:
    raise SystemExit(f"unsupported browser trust patch version: {version}")

old = "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),"
new = (
    "isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) "
    f'|| pageLocation.hostname === {json.dumps(hostname)},'
)
targets = sorted(
    path for path in pathlib.Path(runtime_dir, "node_modules").rglob("client.js")
    if path.parts[-5:] == (
        "node_modules", "@deepseek-ai", "dsh-client-connection", "lib", "client.js"
    )
)
if not targets:
    raise SystemExit("DeepSeek Harness browser connection client was not found")

for path in targets:
    source = path.read_text(encoding="utf-8")
    if source.count(new) == 1 and old not in source:
        continue
    if source.count(old) != 1 or new in source:
        raise SystemExit(f"unexpected browser connection source: {path}")
    patched = source.replace(old, new, 1)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(patched)
        os.chmod(temporary, path.stat().st_mode & 0o777)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise

print(len(targets))
PY
}

validate_browser_connection_patch() {
  local runtime_dir="$1"
  local manifest_path="$2"
  python3 - "${runtime_dir}" "${manifest_path}" <<'PY'
import json
import pathlib
import sys

runtime_dir, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    hostname = json.load(handle)["browserTrustPatch"]["hostname"]
marker = f'pageLocation.hostname === {json.dumps(hostname)}'
targets = sorted(
    path for path in pathlib.Path(runtime_dir, "node_modules").rglob("client.js")
    if path.parts[-5:] == (
        "node_modules", "@deepseek-ai", "dsh-client-connection", "lib", "client.js"
    )
)
if not targets or any(path.read_text(encoding="utf-8").count(marker) != 1 for path in targets):
    raise SystemExit("DeepSeek Harness browser connection patch validation failed")
PY
}

validate_plugin_list() {
  local list_path="$1"
  local manifest_path="$2"
  python3 - "${list_path}" "${manifest_path}" <<'PY'
import json
import sys

list_path, manifest_path = sys.argv[1:]
with open(list_path, encoding="utf-8") as handle:
    rows = json.load(handle)
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if not isinstance(rows, list) or len(rows) != 1:
    raise SystemExit("unexpected DSH plugin list")
dependencies = rows[0].get("dependencies", {})
expected = {item["package"]: item["version"] for item in manifest["profile"]["plugins"]}
actual = {name: dependencies.get(name, {}).get("version") for name in expected}
if actual != expected:
    raise SystemExit(f"DSH plugin list does not match snapshot: {actual!r}")
PY
}

validate_lockfiles() {
  local runtime_dir="$1"
  local profile_dir="$2"
  local manifest_path="$3"
  python3 - "${runtime_dir}/pnpm-lock.yaml" "${profile_dir}/pnpm-lock.yaml" "${manifest_path}" <<'PY'
import json
import sys

runtime_lock_path, profile_lock_path, manifest_path = sys.argv[1:]
runtime_lock = open(runtime_lock_path, encoding="utf-8").read()
profile_lock = open(profile_lock_path, encoding="utf-8").read()
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
if manifest["runtime"]["integrity"] not in runtime_lock:
    raise SystemExit("DSH npm integrity is missing from runtime lockfile")
for item in manifest["profile"]["plugins"]:
    if item["source"] != "npm" or item["integrity"] not in profile_lock:
        raise SystemExit(f"{item['package']} npm integrity is missing from profile lockfile")
PY
}

validate_candidate() {
  local runtime_dir="$1"
  local candidate_home="$2"
  local manifest_path="$3"
  local output_dir="$4"
  local profile_dir="${candidate_home}/profiles/web"
  local dsh_bin="${runtime_dir}/node_modules/.bin/dsh"
  test -x "${dsh_bin}"
  test "$(run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" "${dsh_bin}" --version | head -n 1 | tr -d '\r')" = "${DSH_VERSION}"
  validate_dsh_family "${runtime_dir}" "${manifest_path}"
  validate_browser_connection_patch "${runtime_dir}" "${manifest_path}"
  validate_profile_tree "${profile_dir}" "${manifest_path}"
  mkdir -p "${output_dir}"
  run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
    "${dsh_bin}" plugin --profile web list --depth 0 --json >"${output_dir}/plugin-list.json"
  validate_plugin_list "${output_dir}/plugin-list.json" "${manifest_path}"
  run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
    "${dsh_bin}" --profile web --dump-config >"${output_dir}/dump-config.yml"
  test -s "${output_dir}/dump-config.yml"
}

prepare_candidate() {
  local work_dir="$1"
  local runtime_dir="$2"
  local candidate_home="$3"
  local manifest_path="$4"
  local profile_dir="${candidate_home}/profiles/web"
  local reusable_release=""
  mkdir -p "${profile_dir}"
  resolve_latest_snapshot "${work_dir}" "${manifest_path}"
  finalize_snapshot "${manifest_path}"
  test -f "${manifest_path}" || fail "resolved installation manifest is missing"
  CURRENT_STAGE="snapshot_resolved"
  write_task running snapshot_resolved 28 "已锁定安装版本" "" "${manifest_path}"
  CANDIDATE_RUNTIME="${runtime_dir}"
  RUNTIME_REUSED=false
  reusable_release="$(find_reusable_release "${manifest_path}" 2>/dev/null || true)"
  if [ -n "${reusable_release}" ]; then
    CANDIDATE_RUNTIME="${reusable_release}"
    TARGET_RELEASE="${reusable_release}"
    RUNTIME_REUSED=true
    write_candidate_inputs "${manifest_path}" "" "${profile_dir}"
  else
    TARGET_RELEASE="${RELEASES_DIR}/${SNAPSHOT_ID}-$(printf '%s' "${TASK_ID#dshi-}" | cut -c1-8)"
    test -f "${manifest_path}" || fail "installation manifest disappeared before candidate preparation"
    write_candidate_inputs "${manifest_path}" "${runtime_dir}" "${profile_dir}"
    cp "${manifest_path}" "${runtime_dir}/install-manifest.json"
  fi
  if [ -f "${LIVE_PROFILE}/cordis.patch.yml" ]; then
    cp "${LIVE_PROFILE}/cordis.patch.yml" "${profile_dir}/cordis.patch.yml"
  fi
  if [ "${TEST_MODE}" != "1" ]; then
    chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${candidate_home}"
    if [ "${RUNTIME_REUSED}" != true ]; then
      chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${runtime_dir}"
    fi
  fi
  if [ "${RUNTIME_REUSED}" != true ]; then
    CURRENT_STAGE="runtime_lockfile"
    write_task running runtime_lockfile 35 "正在生成 DSH 依赖锁" "" "${manifest_path}"
    run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
      "${PNPM_BIN}" --dir "${runtime_dir}" install --lockfile-only --prod --ignore-scripts \
        --fetch-retries 4 --fetch-timeout 300000
    CURRENT_STAGE="runtime_install"
    write_task running runtime_install 48 "正在安装 DSH 运行环境" "" "${manifest_path}"
    run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
      "${PNPM_BIN}" --dir "${runtime_dir}" install --frozen-lockfile --prod \
        --fetch-retries 4 --fetch-timeout 300000
    CURRENT_STAGE="browser_trust_patch"
    write_task running browser_trust_patch 52 "正在配置 WebUI 访问" "" "${manifest_path}"
    patch_browser_connection "${runtime_dir}" "${manifest_path}" >/dev/null
  fi
  CURRENT_STAGE="profile_lockfile"
  write_task running profile_lockfile 56 "正在生成插件依赖锁" "" "${manifest_path}"
  run_as_runtime_user_in "${candidate_home}" "${CANDIDATE_RUNTIME}" \
    "${PNPM_BIN}" --dir "${profile_dir}" install --lockfile-only --prod --ignore-scripts \
      --fetch-retries 4 --fetch-timeout 300000
  CURRENT_STAGE="profile_install"
  write_task running profile_install 68 "正在安装 SkillHub 与渠道插件" "" "${manifest_path}"
  run_as_runtime_user_in "${candidate_home}" "${CANDIDATE_RUNTIME}" \
    "${PNPM_BIN}" --dir "${profile_dir}" install --frozen-lockfile --prod --ignore-scripts \
      --fetch-retries 4 --fetch-timeout 300000
  validate_lockfiles "${CANDIDATE_RUNTIME}" "${profile_dir}" "${manifest_path}"
  validate_candidate "${CANDIDATE_RUNTIME}" "${candidate_home}" "${manifest_path}" "${work_dir}/candidate-validation"
  if [ "${TEST_MODE}" != "1" ] && [ "${RUNTIME_REUSED}" != true ]; then
    chown -R root:root "${runtime_dir}"
    chmod -R go-w "${runtime_dir}"
    validate_candidate "${runtime_dir}" "${candidate_home}" "${manifest_path}" "${work_dir}/sealed-validation"
  fi
}

write_service_unit() {
  local destination="$1"
  cat >"${destination}" <<EOF
[Unit]
Description=LightVela DeepSeek Harness WebUI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUNTIME_USER}
Group=${RUNTIME_USER}
Environment=HOME=/home/${RUNTIME_USER}
Environment=DSH_HOME=/home/${RUNTIME_USER}/.dsh
Environment=PATH=/opt/lightvela/dsh/current/node_modules/.bin:/opt/lightvela/dsh/tooling/pnpm-${PNPM_VERSION}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/${RUNTIME_USER}
ExecStart=/opt/lightvela/dsh/current/node_modules/.bin/dsh web --host 127.0.0.1 --port ${DSH_PORT}
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${destination}"
}

port_listener_pids() {
  ss -H -ltnp "sport = :${DSH_PORT}" 2>/dev/null \
    | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
    | sort -u
}

wait_for_port_free() {
  local attempt=""
  for attempt in $(seq 1 15); do
    if [ -z "$(ss -H -ltn "sport = :${DSH_PORT}" 2>/dev/null)" ]; then
      return 0
    fi
    if [ "${TEST_MODE}" != "1" ]; then
      sleep 1
    fi
  done
  fail "port ${DSH_PORT} is occupied by another process"
}

listener_owned_by_service() {
  if [ "${TEST_MODE}" = "1" ]; then
    [ "${LIGHTVELA_DSH_TEST_PORT_OWNER:-service}" = "service" ]
    return
  fi
  local control_group="$1"
  local pid=""
  local found=false
  while IFS= read -r pid; do
    [ -n "${pid}" ] || continue
    found=true
    if ! grep -Fq ":${control_group}" "/proc/${pid}/cgroup" 2>/dev/null; then
      return 1
    fi
  done < <(port_listener_pids)
  [ "${found}" = true ]
}

wait_for_stable_health() {
  local expected_pid=""
  local expected_restarts=""
  local control_group=""
  local attempt=""
  for attempt in $(seq 1 "${HEALTH_ATTEMPTS}"); do
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      expected_pid="$(systemctl show --property=MainPID --value "${SERVICE_NAME}")"
      expected_restarts="$(systemctl show --property=NRestarts --value "${SERVICE_NAME}")"
      control_group="$(systemctl show --property=ControlGroup --value "${SERVICE_NAME}")"
      if [[ "${expected_pid}" =~ ^[1-9][0-9]*$ ]] \
        && [[ "${expected_restarts}" =~ ^[0-9]+$ ]] \
        && [ -n "${control_group}" ] \
        && listener_owned_by_service "${control_group}" \
        && curl --silent --show-error --fail --max-time 3 --output /dev/null \
          "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null; then
        break
      fi
    fi
    if [ "${attempt}" -eq "${HEALTH_ATTEMPTS}" ]; then
      return 1
    fi
    if [ "${TEST_MODE}" != "1" ]; then
      sleep 1
    fi
  done
  for attempt in $(seq 1 "${STABILITY_CHECKS}"); do
    systemctl is-active --quiet "${SERVICE_NAME}"
    test "$(systemctl show --property=MainPID --value "${SERVICE_NAME}")" = "${expected_pid}"
    test "$(systemctl show --property=NRestarts --value "${SERVICE_NAME}")" = "${expected_restarts}"
    listener_owned_by_service "${control_group}"
    curl --silent --show-error --fail --max-time 3 --output /dev/null \
      "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null
    if [ "${TEST_MODE}" != "1" ]; then
      sleep 1
    fi
  done
}

do_install() {
  require_root
  ensure_base_tools
  mkdir -p \
    "$(dirname "${LOCK_FILE}")" "${RELEASES_DIR}" "${TOOLING_ROOT}" \
    "${DSH_HOME}/profiles" "${STATE_DIR}" "${WORK_ROOT}" "$(dirname "${UNIT_PATH}")"
  chmod 0755 "$(dirname "${RELEASES_DIR}")" "${RELEASES_DIR}" "${TOOLING_ROOT}"
  chmod 0700 "${DSH_HOME}" "${STATE_DIR}"
  chmod 0711 "${WORK_ROOT}"
  if [ "${TEST_MODE}" != "1" ]; then
    id "${RUNTIME_USER}" >/dev/null 2>&1 || fail "runtime user ${RUNTIME_USER} does not exist"
    chown "${RUNTIME_USER}:${RUNTIME_USER}" "${DSH_HOME}" "${DSH_HOME}/profiles"
  fi
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    write_task failed lock 0 "安装任务冲突" "已有安装任务正在运行"
    return 1
  fi
  cleanup_abandoned_install_artifacts

  local work_dir="${WORK_ROOT}/${TASK_ID}"
  local runtime_stage="${RELEASES_DIR}/.staging-${TASK_ID}"
  local candidate_home="${DSH_HOME}/.staging-${TASK_ID}"
  local candidate_profile="${candidate_home}/profiles/web"
  local profile_backup="${DSH_HOME}/profiles/.backup-${TASK_ID}"
  local unit_candidate="${UNIT_PATH}.candidate-${TASK_ID}"
  local unit_backup="${UNIT_PATH}.backup-${TASK_ID}"
  local tooling_stage="${TOOLING_ROOT}/.pnpm-staging-${TASK_ID}"
  local manifest_path="${work_dir}/install-manifest.json"
  local previous_current=""
  local initial_fingerprint=""
  local had_profile=false
  local had_unit=false
  local service_was_active=false
  local service_was_enabled=false
  local switched=false
  local profile_activated=false
  local unit_activated=false
  local current_updated=false
  local release_activated=false

  cleanup_staging() {
    rm -rf -- "${runtime_stage}" "${candidate_home}" "${tooling_stage}" "${work_dir}"
    rm -f -- "${unit_candidate}"
  }

  rollback_install() {
    local exit_code="$1"
    trap - ERR INT TERM HUP
    set +e
    if [ "${switched}" = true ]; then
      systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
      if [ "${current_updated}" = true ]; then
        rm -f -- "${CURRENT_LINK}"
        if [ -n "${previous_current}" ]; then
          ln -sfn "${previous_current}" "${CURRENT_LINK}"
        fi
      fi
      if [ "${profile_activated}" = true ]; then
        rm -rf -- "${LIVE_PROFILE}"
      fi
      if [ "${had_profile}" = true ] && [ -d "${profile_backup}" ]; then
        mv "${profile_backup}" "${LIVE_PROFILE}"
      fi
      if [ "${unit_activated}" = true ]; then
        rm -f -- "${UNIT_PATH}"
      fi
      if [ "${had_unit}" = true ] && [ -f "${unit_backup}" ]; then
        mv "${unit_backup}" "${UNIT_PATH}"
      fi
      if [ "${release_activated}" = true ] && [ -n "${TARGET_RELEASE}" ]; then
        rm -rf -- "${TARGET_RELEASE}"
      fi
      systemctl daemon-reload >/dev/null 2>&1 || true
      if [ "${had_unit}" = true ]; then
        if [ "${service_was_enabled}" = true ]; then
          systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
        else
          systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
        fi
        if [ "${service_was_active}" = true ]; then
          systemctl restart "${SERVICE_NAME}" >/dev/null 2>&1 || true
        fi
      else
        systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
      fi
    fi
    rm -rf -- "${profile_backup}"
    rm -f -- "${unit_backup}"
    cleanup_staging
    write_task failed "${CURRENT_STAGE}" 0 "安装失败" \
      "DeepSeek Harness 安装未完成（阶段：${CURRENT_STAGE}）" "${manifest_path}" || true
    return "${exit_code}"
  }

  trap 'rc=$?; rollback_install "${rc}"; exit "${rc}"' ERR
  trap 'rollback_install 130; exit 130' INT TERM HUP
  rm -rf -- "${work_dir}" "${runtime_stage}" "${candidate_home}" "${profile_backup}" "${tooling_stage}"
  rm -f -- "${unit_candidate}" "${unit_backup}"
  mkdir -p "${work_dir}" "${candidate_home}/profiles"
  chmod 0711 "${work_dir}"

  CURRENT_STAGE="preflight"
  write_task running preflight 10 "正在检查实例环境"
  ensure_node_runtime
  ensure_build_toolchain
  ensure_pnpm_runtime "${tooling_stage}"
  [[ "${HEALTH_ATTEMPTS}" =~ ^[0-9]+$ ]]
  [ "${HEALTH_ATTEMPTS}" -ge 1 ] && [ "${HEALTH_ATTEMPTS}" -le 300 ]
  [[ "${STABILITY_CHECKS}" =~ ^[0-9]+$ ]]
  [ "${STABILITY_CHECKS}" -ge 2 ] && [ "${STABILITY_CHECKS}" -le 30 ]
  validate_existing_profile
  initial_fingerprint="$(profile_fingerprint)"

  CURRENT_STAGE="resolve_latest"
  write_task running resolve_latest 20 "正在获取最新版本"
  prepare_candidate "${work_dir}" "${runtime_stage}" "${candidate_home}" "${manifest_path}"

  CURRENT_STAGE="validate_candidate"
  write_task running validate_candidate 75 "正在检查安装内容" "" "${manifest_path}"
  if [ "$(profile_fingerprint)" != "${initial_fingerprint}" ]; then
    fail "DeepSeek Harness web profile changed during installation"
  fi
  if [ -L "${CURRENT_LINK}" ]; then
    previous_current="$(readlink "${CURRENT_LINK}")"
  fi
  if [ -d "${LIVE_PROFILE}" ]; then
    had_profile=true
  fi
  if [ -f "${UNIT_PATH}" ]; then
    had_unit=true
    systemctl is-active --quiet "${SERVICE_NAME}" && service_was_active=true || true
    systemctl is-enabled --quiet "${SERVICE_NAME}" && service_was_enabled=true || true
  fi

  CURRENT_STAGE="activate"
  write_task running activate 85 "正在切换运行环境" "" "${manifest_path}"
  switched=true
  if [ "${had_unit}" = true ]; then
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
  wait_for_port_free
  if [ "${had_profile}" = true ]; then
    mv "${LIVE_PROFILE}" "${profile_backup}"
  fi
  if [ "${had_unit}" = true ]; then
    mv "${UNIT_PATH}" "${unit_backup}"
  fi
  if [ "${RUNTIME_REUSED}" != true ]; then
    mv "${runtime_stage}" "${TARGET_RELEASE}"
    release_activated=true
  fi
  mv "${candidate_profile}" "${LIVE_PROFILE}"
  profile_activated=true
  if [ "${TEST_MODE}" != "1" ]; then
    chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${LIVE_PROFILE}"
  fi
  ln -sfn "${TARGET_RELEASE}" "${CURRENT_LINK}"
  current_updated=true
  write_service_unit "${unit_candidate}"
  mv "${unit_candidate}" "${UNIT_PATH}"
  unit_activated=true
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"

  CURRENT_STAGE="health_check"
  write_task running health_check 95 "正在检查运行状态" "" "${manifest_path}"
  wait_for_stable_health
  validate_candidate "${TARGET_RELEASE}" "${DSH_HOME}" "${manifest_path}" "${work_dir}/live-validation"

  CURRENT_STAGE="cleanup"
  write_task running cleanup 99 "正在清理旧运行环境" "" "${manifest_path}"
  prune_old_releases "${TARGET_RELEASE}" "${previous_current}"
  rm -rf -- "${profile_backup}" "${candidate_home}" "${work_dir}"
  rm -f -- "${unit_backup}"
  write_task succeeded completed 100 "安装完成" "" "${TARGET_RELEASE}/install-manifest.json"
  trap - ERR INT TERM HUP
}

main() {
  local action="${1:-}"
  shift || true
  case "${action}" in
    install)
      parse_install_arguments "$@" || exit 2
      do_install
      ;;
    installation)
      parse_task_id "$@" || exit 2
      require_root
      local file
      file="$(task_file "${TASK_ID}")"
      [ -f "${file}" ] || exit 4
      cat "${file}"
      ;;
    *)
      echo "usage: ${0##*/} {install --task-id ID --trusted-browser-host HOST|installation --task-id ID}" >&2
      exit 2
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
