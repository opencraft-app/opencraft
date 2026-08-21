#!/usr/bin/env bash
set -Eeuo pipefail

readonly DSH_VERSION="0.1.0-rc.7"
readonly PNPM_VERSION="10.33.0"
readonly RUNTIME_USER="agentuser"
readonly DSH_PORT="3080"
readonly SERVICE_NAME="deepseek-harness.service"
readonly INSTALLER_PUBLIC_PATH="/usr/local/libexec/lightvela/install-deepseek-harness"
readonly DEFAULT_CONFIG_HELPER="/usr/local/libexec/lightvela/configure-deepseek-harness.py"

TEST_MODE="${LIGHTVELA_DSH_TEST_MODE:-0}"
TEST_ROOT="${LIGHTVELA_DSH_TEST_ROOT:-}"

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
STATE_DIR="$(root_path /var/lib/lightvela/dsh/installations)"
WORK_ROOT="$(root_path /var/lib/lightvela/dsh/work)"
LOCK_FILE="$(root_path /var/lock/lightvela-deepseek-harness.lock)"
UNIT_PATH="$(root_path "/etc/systemd/system/${SERVICE_NAME}")"
TARGET_RELEASE="${RELEASES_DIR}/${DSH_VERSION}"
DEFAULT_ASSETS_DIR="$(root_path /usr/local/share/lightvela/deepseek-harness)"
ASSETS_DIR="${LIGHTVELA_DSH_ASSETS_DIR:-${DEFAULT_ASSETS_DIR}}"
CONFIG_HELPER="${LIGHTVELA_DSH_CONFIG_HELPER:-${DEFAULT_CONFIG_HELPER}}"
HEALTH_ATTEMPTS="${LIGHTVELA_DSH_HEALTH_ATTEMPTS:-60}"
TASK_ID=""

require_root() {
  if [ "${TEST_MODE}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
    echo "deepseek harness installer must run as root" >&2
    exit 1
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

task_file() {
  printf '%s/%s.json' "${STATE_DIR}" "$1"
}

write_task() {
  local status="$1"
  local stage="$2"
  local progress="$3"
  local message="$4"
  local error_message="${5:-}"
  local destination
  destination="$(task_file "${TASK_ID}")"
  mkdir -p "${STATE_DIR}"
  chmod 0700 "${STATE_DIR}"
  python3 - "${destination}" "${TASK_ID}" "${status}" "${stage}" "${progress}" "${message}" "${error_message}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, task_id, status, stage, progress, message, error = sys.argv[1:]
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
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=True, separators=(",", ":"))
    handle.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, path)
PY
}

run_as_runtime_user_in() {
  local dsh_home="$1"
  local runtime_dir="$2"
  shift 2
  local runtime_path="${runtime_dir}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
  if [ "${TEST_MODE}" = "1" ]; then
    runtime_path="${PATH}"
  fi
  sudo -n -u "${RUNTIME_USER}" -H env \
    HOME="${RUNTIME_HOME}" \
    DSH_HOME="${dsh_home}" \
    PATH="${runtime_path}" \
    "$@"
}

run_as_runtime_user() {
  run_as_runtime_user_in "${DSH_HOME}" "${CURRENT_LINK}" "$@"
}

ensure_build_toolchain() {
  if command -v g++ >/dev/null 2>&1 && command -v make >/dev/null 2>&1; then
    return
  fi
  if [ "${TEST_MODE}" = "1" ]; then
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o DPkg::Lock::Timeout=300 update -o Acquire::Retries=3
  apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends build-essential
}

ensure_node_runtime() {
  local major
  major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if ! [[ "${major}" =~ ^[0-9]+$ ]] || [ "${major}" -lt 22 ]; then
    echo "DeepSeek Harness requires Node.js 22 or newer" >&2
    return 1
  fi
}

ensure_pnpm_runtime() {
  command -v pnpm >/dev/null 2>&1
  test "$(pnpm --version | head -n 1 | tr -d '\r')" = "${PNPM_VERSION}"
}

validate_frozen_inputs() {
  local required=""
  for required in \
    manifest.json \
    runtime/package.json \
    runtime/pnpm-lock.yaml \
    runtime/.pnpmfile.cjs \
    web-profile/package.json \
    web-profile/pnpm-lock.yaml \
    web-profile/.pnpmfile.cjs \
    web-profile/pnpm-workspace.yaml; do
    test -s "${ASSETS_DIR}/${required}"
  done

  if [ "${TEST_MODE}" != "1" ]; then
    if find "${ASSETS_DIR}" \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
      echo "DeepSeek Harness frozen inputs must be root-owned and not group/world writable" >&2
      return 1
    fi
  fi

  python3 - \
    "${ASSETS_DIR}/manifest.json" \
    "${ASSETS_DIR}/runtime/package.json" \
    "${ASSETS_DIR}/runtime/pnpm-lock.yaml" \
    "${ASSETS_DIR}/runtime/.pnpmfile.cjs" \
    "${ASSETS_DIR}/web-profile/package.json" \
    "${ASSETS_DIR}/web-profile/pnpm-lock.yaml" \
    "${ASSETS_DIR}/web-profile/.pnpmfile.cjs" \
    "${ASSETS_DIR}/web-profile/pnpm-workspace.yaml" \
    "${DSH_VERSION}" "${PNPM_VERSION}" <<'PY'
import json
import sys

(
    manifest_path,
    runtime_package_path,
    runtime_lock_path,
    runtime_hook_path,
    profile_package_path,
    profile_lock_path,
    profile_hook_path,
    profile_workspace_path,
    dsh_version,
    pnpm_version,
) = sys.argv[1:]

def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)

manifest = load_json(manifest_path)
runtime = load_json(runtime_package_path)
profile = load_json(profile_package_path)
assert manifest.get("schemaVersion") == 1
assert manifest.get("pnpmVersion") == pnpm_version
assert manifest.get("runtime", {}).get("package") == "@deepseek-ai/dsh"
assert manifest.get("runtime", {}).get("version") == dsh_version
assert runtime.get("packageManager") == f"pnpm@{pnpm_version}"
assert runtime.get("dependencies") == {"@deepseek-ai/dsh": dsh_version}
assert profile.get("packageManager") == f"pnpm@{pnpm_version}"
workspace = open(profile_workspace_path, encoding="utf-8").read()
assert "nodeLinker: hoisted" in workspace
assert "autoInstallPeers: false" in workspace
expected_built = ["@deepseek-ai/dsh-subprocess-local", "koffi", "node-pty"]
expected_ignored = ["@google/genai", "protobufjs"]
for package in (runtime, profile):
    assert package.get("pnpm", {}).get("onlyBuiltDependencies") == expected_built
    assert package.get("pnpm", {}).get("ignoredBuiltDependencies") == expected_ignored

plugins = manifest.get("profile", {}).get("plugins", [])
expected_plugins = {
    "@cocofhu/skillhub": "0.2.13",
    "deepseek-harness-qqbot": "0.1.5",
    "deepseek-harness-weixin": "0.2.5",
    "deepseek-harness-wecom": "0.1.5",
    "deepseek-harness-lark": "0.1.5",
}
assert {item["package"]: item["version"] for item in plugins} == expected_plugins
assert [item["id"] for item in plugins if item["source"] == "archive"] == [
    "qqbot", "weixin", "wecom", "lark"
]
builtins = manifest.get("profile", {}).get("builtInBundles", [])
assert builtins == ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
assert profile.get("dsh", {}).get("profile", {}).get("bundles") == [*builtins, *expected_plugins]
expected_dependencies = {
    "@cocofhu/skillhub": "0.2.13",
}
for item in plugins:
    if item["source"] == "archive":
        expected_dependencies[item["package"]] = f"file:../artifacts/{item['filename']}"
assert profile.get("dependencies") == expected_dependencies
assert "dsh-auth" not in json.dumps(manifest)

runtime_lock = open(runtime_lock_path, encoding="utf-8").read()
profile_lock = open(profile_lock_path, encoding="utf-8").read()
assert manifest["runtime"]["integrity"] in runtime_lock
skillhub = next(item for item in plugins if item["id"] == "skillhub")
assert skillhub["integrity"] in profile_lock
assert "0.1.0-rc.8" not in runtime_lock
assert "0.1.0-rc.8" not in profile_lock
for hook_path in (runtime_hook_path, profile_hook_path):
    hook = open(hook_path, encoding="utf-8").read()
    assert dsh_version in hook
PY
}

archive_rows() {
  python3 - "${ASSETS_DIR}/manifest.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)
for item in manifest["profile"]["plugins"]:
    if item["source"] == "archive":
        print("\t".join(item[key] for key in ("id", "package", "version", "url", "filename", "sha256")))
PY
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

download_archive() {
  local url="$1"
  local destination="$2"
  local expected_sha256="$3"
  local attempt=""
  local actual_sha256=""
  local retry_delay=""
  for attempt in 1 2 3 4 5; do
    rm -f "${destination}"
    if curl --fail --silent --show-error --location \
      --connect-timeout 10 --max-time 300 \
      --output "${destination}" "${url}"; then
      actual_sha256="$(sha256_file "${destination}")"
      if [ "${actual_sha256}" = "${expected_sha256}" ]; then
        return 0
      fi
    fi
    rm -f "${destination}"
    if [ "${attempt}" -lt 5 ] && [ "${TEST_MODE}" != "1" ]; then
      retry_delay=$((1 << attempt))
      sleep "${retry_delay}"
    fi
  done
  echo "failed to download or verify DeepSeek Harness plugin archive" >&2
  return 1
}

validate_plugin_archive() {
  python3 - "$1" "$2" "$3" <<'PY'
import json
import pathlib
import sys
import tarfile

archive_path, expected_name, expected_version = sys.argv[1:]
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        assert not path.is_absolute()
        assert ".." not in path.parts
        assert not member.issym() and not member.islnk()
    candidates = [member for member in members if pathlib.PurePosixPath(member.name).name == "package.json"]
    assert len(candidates) == 1, [member.name for member in candidates]
    handle = archive.extractfile(candidates[0])
    assert handle is not None
    package = json.load(handle)
assert package.get("name") == expected_name, package
assert package.get("version") == expected_version, package
assert package.get("dsh", {}).get("bundle", {}).get("patch"), package
PY
}

validate_existing_profile() {
  if [ ! -e "${LIVE_PROFILE}" ]; then
    return 0
  fi
  if [ ! -f "${LIVE_PROFILE}/package.json" ]; then
    echo "existing DeepSeek Harness web profile has no package.json" >&2
    return 1
  fi
  python3 - "${LIVE_PROFILE}/package.json" "${ASSETS_DIR}/manifest.json" <<'PY'
import json
import sys

profile_path, manifest_path = sys.argv[1:]
with open(profile_path, encoding="utf-8") as handle:
    profile = json.load(handle)
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
allowed = set(manifest["profile"]["builtInBundles"])
allowed.update(item["package"] for item in manifest["profile"]["plugins"])
for field in ("dependencies", "devDependencies", "optionalDependencies"):
    unknown = set(profile.get(field, {})) - allowed
    if unknown:
        print(f"unmanaged DeepSeek Harness profile dependencies: {sorted(unknown)}", file=sys.stderr)
        raise SystemExit(1)
bundles = profile.get("dsh", {}).get("profile", {}).get("bundles", [])
unknown_bundles = set(bundles) - allowed
if unknown_bundles:
    print(f"unmanaged DeepSeek Harness profile bundles: {sorted(unknown_bundles)}", file=sys.stderr)
    raise SystemExit(1)
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

copy_frozen_inputs() {
  local candidate_runtime="$1"
  local candidate_profile="$2"
  mkdir -p "${candidate_runtime}" "${candidate_profile}"
  cp \
    "${ASSETS_DIR}/runtime/package.json" \
    "${ASSETS_DIR}/runtime/pnpm-lock.yaml" \
    "${ASSETS_DIR}/runtime/.pnpmfile.cjs" \
    "${candidate_runtime}/"
  cp \
    "${ASSETS_DIR}/web-profile/package.json" \
    "${ASSETS_DIR}/web-profile/pnpm-lock.yaml" \
    "${ASSETS_DIR}/web-profile/.pnpmfile.cjs" \
    "${ASSETS_DIR}/web-profile/pnpm-workspace.yaml" \
    "${candidate_profile}/"
  if [ -f "${LIVE_PROFILE}/cordis.patch.yml" ]; then
    cp "${LIVE_PROFILE}/cordis.patch.yml" "${candidate_profile}/cordis.patch.yml"
  fi
}

validate_profile_tree() {
  local profile_dir="$1"
  python3 - "${profile_dir}" "${ASSETS_DIR}/manifest.json" <<'PY'
import json
import os
import sys

root, manifest_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
with open(os.path.join(root, "package.json"), encoding="utf-8") as handle:
    profile = json.load(handle)
expected_bundles = [
    *manifest["profile"]["builtInBundles"],
    *(item["package"] for item in manifest["profile"]["plugins"]),
]
assert profile.get("dsh", {}).get("profile", {}).get("bundles") == expected_bundles
assert "dsh-auth" not in profile.get("dependencies", {})
for item in manifest["profile"]["plugins"]:
    package_path = os.path.join(root, "node_modules", *item["package"].split("/"), "package.json")
    if not os.path.isfile(package_path):
        print(f"missing DeepSeek Harness profile plugin: {item['package']}", file=sys.stderr)
        raise SystemExit(1)
    with open(package_path, encoding="utf-8") as handle:
        package = json.load(handle)
    assert package.get("name") == item["package"], package
    assert package.get("version") == item["version"], package
    assert package.get("dsh", {}).get("bundle", {}).get("patch"), package
PY
}

validate_plugin_list() {
  local list_path="$1"
  python3 - "${list_path}" "${ASSETS_DIR}/manifest.json" "${DSH_VERSION}" <<'PY'
import json
import sys

list_path, manifest_path, dsh_version = sys.argv[1:]
with open(list_path, encoding="utf-8") as handle:
    rows = json.load(handle)
assert isinstance(rows, list) and len(rows) == 1, rows
dependencies = rows[0].get("dependencies", {})
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
expected = {
    **{item["package"]: item["version"] for item in manifest["profile"]["plugins"]},
}
actual = {name: dependencies.get(name, {}).get("version") for name in expected}
assert actual == expected, (actual, expected)
PY
}

validate_candidate() {
  local runtime_dir="$1"
  local candidate_home="$2"
  local output_dir="$3"
  local profile_dir="${candidate_home}/profiles/web"
  local dsh_bin="${runtime_dir}/node_modules/.bin/dsh"
  local runtime_package="${runtime_dir}/node_modules/@deepseek-ai/dsh/package.json"
  test -x "${dsh_bin}"
  test -f "${runtime_package}"
  test "$(run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" "${dsh_bin}" --version | head -n 1 | tr -d '\r')" = "${DSH_VERSION}"
  validate_profile_tree "${profile_dir}"
  mkdir -p "${output_dir}"
  run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
    "${dsh_bin}" plugin --profile web list --depth 0 --json >"${output_dir}/plugin-list.json"
  validate_plugin_list "${output_dir}/plugin-list.json"
  run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
    "${dsh_bin}" --profile web --dump-config >"${output_dir}/dump-config.yml"
  test -s "${output_dir}/dump-config.yml"
}

validate_sealed_candidate() {
  local runtime_dir="$1"
  local candidate_home="$2"
  local output_dir="$3"
  local profile_dir="${candidate_home}/profiles/web"
  local dsh_bin="${runtime_dir}/node_modules/.bin/dsh"
  test -x "${dsh_bin}"
  test "$(run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" "${dsh_bin}" --version | head -n 1 | tr -d '\r')" = "${DSH_VERSION}"
  validate_profile_tree "${profile_dir}"
  mkdir -p "${output_dir}"
  run_as_runtime_user_in "${candidate_home}" "${runtime_dir}" \
    "${dsh_bin}" plugin --profile web list --depth 0 --json >"${output_dir}/plugin-list.json"
  validate_plugin_list "${output_dir}/plugin-list.json"
}

prepare_candidate() {
  local work_dir="$1"
  local candidate_runtime="$2"
  local candidate_home="$3"
  local candidate_profile="${candidate_home}/profiles/web"
  local artifacts_dir="${candidate_home}/profiles/artifacts"
  local id="" package_name="" version="" url="" filename="" sha256=""

  mkdir -p "${candidate_profile}" "${artifacts_dir}"
  copy_frozen_inputs "${candidate_runtime}" "${candidate_profile}"
  while IFS=$'\t' read -r id package_name version url filename sha256; do
    download_archive "${url}" "${artifacts_dir}/${filename}" "${sha256}"
    validate_plugin_archive "${artifacts_dir}/${filename}" "${package_name}" "${version}"
  done < <(archive_rows)

  if [ "${TEST_MODE}" != "1" ]; then
    chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${candidate_runtime}" "${candidate_home}"
  fi
  run_as_runtime_user_in "${candidate_home}" "${candidate_runtime}" \
    pnpm --dir "${candidate_runtime}" install --frozen-lockfile --prod \
    --fetch-retries 4 --fetch-timeout 300000
  run_as_runtime_user_in "${candidate_home}" "${candidate_runtime}" \
    pnpm --dir "${candidate_profile}" install --frozen-lockfile --prod \
    --fetch-retries 4 --fetch-timeout 300000
  validate_candidate "${candidate_runtime}" "${candidate_home}" "${work_dir}/candidate-validation"
  if [ "${TEST_MODE}" != "1" ]; then
    chown -R root:root "${candidate_runtime}" "${candidate_home}"
    validate_sealed_candidate "${candidate_runtime}" "${candidate_home}" "${work_dir}/sealed-validation"
  fi
}

write_service_unit() {
  local unit_dir
  unit_dir="$(dirname "${UNIT_PATH}")"
  mkdir -p "${unit_dir}"
  cat >"${UNIT_PATH}.tmp" <<EOF
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
Environment=PATH=/opt/lightvela/dsh/current/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/home/${RUNTIME_USER}
ExecStart=/opt/lightvela/dsh/current/node_modules/.bin/dsh web --host 127.0.0.1 --port ${DSH_PORT} --no-open
Restart=always
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "${UNIT_PATH}.tmp"
  mv "${UNIT_PATH}.tmp" "${UNIT_PATH}"
}

wait_for_health() {
  local attempt=""
  for attempt in $(seq 1 "${HEALTH_ATTEMPTS}"); do
    if curl --silent --show-error --fail --max-time 3 --output /dev/null \
      "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null; then
      return 0
    fi
    if [ "${TEST_MODE}" != "1" ]; then
      sleep 1
    fi
  done
  return 1
}

validate_live_installation() {
  test "$(systemctl is-active "${SERVICE_NAME}")" = "active"
  ss -tln 2>/dev/null | awk '{print $4}' | grep -Eq "^127\\.0\\.0\\.1:${DSH_PORT}$"
  wait_for_health
  validate_candidate "${TARGET_RELEASE}" "${DSH_HOME}" "$1"
}

do_install() {
  require_root
  mkdir -p \
    "$(dirname "${LOCK_FILE}")" \
    "${RELEASES_DIR}" \
    "${DSH_HOME}/profiles" \
    "${STATE_DIR}" \
    "${WORK_ROOT}" \
    "$(dirname "${UNIT_PATH}")"
  chmod 0700 "${DSH_HOME}" "${STATE_DIR}"
  chmod 0711 "${WORK_ROOT}"
  if [ "${TEST_MODE}" != "1" ]; then
    chown "${RUNTIME_USER}:${RUNTIME_USER}" "${DSH_HOME}" "${DSH_HOME}/profiles"
  fi
  exec 9>"${LOCK_FILE}"
  if [ "${TEST_MODE}" != "1" ] && ! flock -n 9; then
    write_task failed lock 0 "安装任务冲突" "已有安装任务正在运行"
    return 1
  fi

  local work_dir="${WORK_ROOT}/${TASK_ID}"
  local candidate_runtime="${work_dir}/candidate-runtime"
  local candidate_home="${work_dir}/candidate-home"
  local candidate_profile="${candidate_home}/profiles/web"
  local backup_dir="${work_dir}/backup"
  local previous_current=""
  local initial_fingerprint=""
  local had_release=false
  local had_profile=false
  local had_unit=false
  local service_was_active=false
  local service_was_enabled=false
  local switched=false
  local release_backed_up=false
  local profile_backed_up=false
  local unit_backed_up=false
  local new_release_active=false
  local new_profile_active=false
  local new_unit_active=false
  local current_link_updated=false

  rollback_install() {
    local exit_code="$1"
    trap - ERR
    if [ "${switched}" = true ]; then
      systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
      if [ "${current_link_updated}" = true ]; then
        rm -f "${CURRENT_LINK}"
      fi
      if [ "${new_release_active}" = true ]; then
        rm -rf "${TARGET_RELEASE}"
      fi
      if [ "${new_profile_active}" = true ]; then
        rm -rf "${LIVE_PROFILE}"
      fi
      if [ "${new_unit_active}" = true ]; then
        rm -f "${UNIT_PATH}"
      fi
      rm -f "${UNIT_PATH}.tmp"
      if [ "${release_backed_up}" = true ] && [ -d "${backup_dir}/release" ]; then
        mv "${backup_dir}/release" "${TARGET_RELEASE}"
      fi
      if [ "${profile_backed_up}" = true ] && [ -d "${backup_dir}/profile" ]; then
        mv "${backup_dir}/profile" "${LIVE_PROFILE}"
      fi
      if [ "${unit_backed_up}" = true ] && [ -f "${backup_dir}/unit" ]; then
        mv "${backup_dir}/unit" "${UNIT_PATH}"
      fi
      if [ "${current_link_updated}" = true ] && [ -n "${previous_current}" ]; then
        ln -sfn "${previous_current}" "${CURRENT_LINK}"
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
    rm -rf "${work_dir}"
    write_task failed failed 0 "安装失败" "DeepSeek Harness 安装未完成，请稍后重试"
    return "${exit_code}"
  }
  trap 'rollback_install $?' ERR

  rm -rf "${work_dir}"
  mkdir -p "${work_dir}"
  chmod 0711 "${work_dir}"

  write_task running preflight 10 "正在检查实例环境"
  ensure_node_runtime
  ensure_pnpm_runtime
  ensure_build_toolchain
  [[ "${HEALTH_ATTEMPTS}" =~ ^[0-9]+$ ]]
  [ "${HEALTH_ATTEMPTS}" -ge 1 ] && [ "${HEALTH_ATTEMPTS}" -le 300 ]
  validate_frozen_inputs
  validate_existing_profile
  initial_fingerprint="$(profile_fingerprint)"

  write_task running download_plugins 30 "正在下载并校验插件"
  prepare_candidate "${work_dir}" "${candidate_runtime}" "${candidate_home}"

  write_task running validate_candidate 70 "正在检查安装内容"
  if [ "$(profile_fingerprint)" != "${initial_fingerprint}" ]; then
    echo "DeepSeek Harness web profile changed during installation" >&2
    rollback_install 1
    return 1
  fi

  mkdir -p "${backup_dir}"
  if [ -L "${CURRENT_LINK}" ]; then
    previous_current="$(readlink "${CURRENT_LINK}")"
  fi
  if [ -d "${TARGET_RELEASE}" ]; then
    had_release=true
  fi
  if [ -d "${LIVE_PROFILE}" ]; then
    had_profile=true
  fi
  if [ -f "${UNIT_PATH}" ]; then
    had_unit=true
    if systemctl is-active --quiet "${SERVICE_NAME}" >/dev/null 2>&1; then
      service_was_active=true
    fi
    if systemctl is-enabled --quiet "${SERVICE_NAME}" >/dev/null 2>&1; then
      service_was_enabled=true
    fi
  fi

  write_task running activate 80 "正在切换运行环境"
  switched=true
  if [ "${had_unit}" = true ]; then
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
  if [ "${had_release}" = true ]; then
    mv "${TARGET_RELEASE}" "${backup_dir}/release"
    release_backed_up=true
  fi
  if [ "${had_profile}" = true ]; then
    mv "${LIVE_PROFILE}" "${backup_dir}/profile"
    profile_backed_up=true
  fi
  if [ "${had_unit}" = true ]; then
    mv "${UNIT_PATH}" "${backup_dir}/unit"
    unit_backed_up=true
  fi
  mv "${candidate_runtime}" "${TARGET_RELEASE}"
  new_release_active=true
  mv "${candidate_profile}" "${LIVE_PROFILE}"
  new_profile_active=true
  if [ "${TEST_MODE}" != "1" ]; then
    chown -R "${RUNTIME_USER}:${RUNTIME_USER}" "${LIVE_PROFILE}"
  fi
  ln -sfn "${TARGET_RELEASE}" "${CURRENT_LINK}"
  current_link_updated=true
  write_service_unit
  new_unit_active=true
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"

  write_task running health_check 95 "正在检查运行状态"
  validate_live_installation "${work_dir}/live-validation"

  trap - ERR
  rm -rf "${work_dir}"
  write_task succeeded completed 100 "安装完成"
}

validate_region() {
  [ "$1" = "cn" ] || [ "$1" = "global" ]
}

validate_provider() {
  case "$1" in
    deepseek|minimax|minimax-cn|moonshotai|moonshotai-cn|qwen-token-plan-cn|openrouter|anthropic|groq|openai) return 0 ;;
    *) return 1 ;;
  esac
}

run_config_helper() {
  require_root
  test -r "${CONFIG_HELPER}"
  run_as_runtime_user python3 "${CONFIG_HELPER}" "$@"
}

action="${1:-}"
shift || true

case "${action}" in
  install)
    parse_task_id "$@" || exit 2
    do_install
    ;;
  installation)
    parse_task_id "$@" || exit 2
    require_root
    file="$(task_file "${TASK_ID}")"
    [ -f "${file}" ] || exit 4
    cat "${file}"
    ;;
  providers)
    [ "$#" -eq 2 ] && [ "$1" = "--region" ] && validate_region "$2" || exit 2
    run_config_helper providers --region "$2"
    ;;
  configure)
    [ "$#" -eq 2 ] && [ "$1" = "--provider" ] && validate_provider "$2" || exit 2
    run_config_helper configure --provider "$2"
    ;;
  remove-provider)
    [ "$#" -eq 2 ] && [ "$1" = "--provider" ] && validate_provider "$2" || exit 2
    run_config_helper remove-provider --provider "$2"
    ;;
  *)
    echo "usage: ${INSTALLER_PUBLIC_PATH} {install --task-id ID|installation --task-id ID|providers --region REGION|configure --provider PROVIDER|remove-provider --provider PROVIDER}" >&2
    exit 2
    ;;
esac
