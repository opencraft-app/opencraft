#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"
TMPDIR="$(mktemp -d)"
trap 'if [ "${LIGHTVELA_DSH_KEEP_TEST_TMP:-0}" = "1" ]; then printf "kept test tmp: %s\n" "${TMPDIR}"; else rm -rf "${TMPDIR}"; fi' EXIT

if grep -Eq '^  (providers|configure|remove-provider)\)' "${INSTALLER}"; then
  echo "installer must not expose Provider helper actions" >&2
  exit 1
fi

FAKE_BIN="${TMPDIR}/bin"
TEST_ROOT="${TMPDIR}/root"
CALLS="${TMPDIR}/calls.log"
mkdir -p "${FAKE_BIN}"

cat >"${FAKE_BIN}/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
prefix=""
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  if [ "${args[$index]}" = "--prefix" ]; then
    prefix="${args[$((index + 1))]}"
  fi
done
if [ -n "${prefix}" ] && [[ "$*" == *"pnpm@10.33.0"* ]]; then
  mkdir -p "${prefix}/node_modules/.bin"
  cat >"${prefix}/node_modules/.bin/pnpm" <<'INNER'
#!/usr/bin/env bash
LIGHTVELA_DSH_TEST_PNPM_VERSION=10.33.0 exec "${LIGHTVELA_DSH_TEST_FAKE_PNPM}" "$@"
INNER
  chmod +x "${prefix}/node_modules/.bin/pnpm"
  exit 0
fi
if [ "${1:-}" = "view" ]; then
  specification="${2:-}"
  if [ "${LIGHTVELA_DSH_TEST_METADATA_FAILURE_SPEC:-}" = "${specification}" ]; then
    exit 69
  fi
  case "${specification}" in
    '@deepseek-ai/dsh@latest') package_name='@deepseek-ai/dsh'; version='0.1.1-rc.2'; integrity='sha512-runtime' ;;
    '@cocofhu/skillhub@latest') package_name='@cocofhu/skillhub'; version='0.2.16'; integrity='sha512-skillhub' ;;
    'deepseek-harness-qqbot@latest') package_name='deepseek-harness-qqbot'; version='0.1.5'; integrity='sha512-qqbot' ;;
    'deepseek-harness-weixin@latest') package_name='deepseek-harness-weixin'; version='0.2.5'; integrity='sha512-weixin' ;;
    'deepseek-harness-wecom@latest') package_name='deepseek-harness-wecom'; version='0.1.5'; integrity='sha512-wecom' ;;
    'deepseek-harness-lark@latest') package_name='deepseek-harness-lark'; version='0.1.5'; integrity='sha512-lark' ;;
    'deepseek-harness-dingtalk@latest') package_name='deepseek-harness-dingtalk'; version='0.1.5'; integrity='sha512-dingtalk' ;;
    *) exit 97 ;;
  esac
  if [ "${LIGHTVELA_DSH_TEST_MISSING_INTEGRITY_SPEC:-}" = "${specification}" ]; then
    integrity=""
  fi
  printf '{"version":"%s","dist.integrity":"%s","dist.tarball":"https://registry.npmjs.org/%s.tgz"}\n' \
    "${version}" "${integrity}" "${package_name##*/}"
  exit 0
fi
exit 97
EOF

cat >"${FAKE_BIN}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "${LIGHTVELA_DSH_TEST_PNPM_VERSION:-10.33.0}"
  exit 0
fi
directory=""
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  if [ "${args[$index]}" = "--dir" ]; then
    directory="${args[$((index + 1))]}"
  fi
done
test -n "${directory}"
case "${directory}" in
  */releases/.staging-dshi-*)
    if [[ "$*" == *"--lockfile-only"* ]]; then
      printf '%s\n' 'sha512-runtime' >"${directory}/pnpm-lock.yaml"
    fi
    mkdir -p \
      "${directory}/node_modules/.bin" \
      "${directory}/node_modules/@deepseek-ai/dsh" \
      "${directory}/node_modules/@deepseek-ai/dsh-client-connection/lib"
    cat >"${directory}/node_modules/.bin/dsh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
printf 'dsh %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${1:-}" = "--version" ]; then
  printf '0.1.1-rc.2\n'
  exit 0
fi
if [ "${1:-}" = "plugin" ]; then
  if [ "$(pnpm --version | head -n 1 | tr -d '\r')" != "10.33.0" ]; then
    echo "dsh: pnpm 10.33.0 not found on PATH" >&2
    exit 127
  fi
  cat <<'JSON'
[{"name":"@lightvela/deepseek-harness-web-profile","dependencies":{"@cocofhu/skillhub":{"version":"0.2.16"},"deepseek-harness-qqbot":{"version":"0.1.5"},"deepseek-harness-weixin":{"version":"0.2.5"},"deepseek-harness-wecom":{"version":"0.1.5"},"deepseek-harness-lark":{"version":"0.1.5"},"deepseek-harness-dingtalk":{"version":"0.1.5"}}}]
JSON
  exit 0
fi
if [ "${1:-}" = "--profile" ] && [ "${3:-}" = "--dump-config" ]; then
  if [ "${LIGHTVELA_DSH_TEST_MUTATE_ON_DUMP:-0}" = "1" ] && [ -n "${LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH:-}" ]; then
    python3 - "${LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH}/package.json" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
data["externalMutation"] = True
with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, separators=(",", ":"))
PY
  fi
  printf '%s\n' 'bundles: []'
  exit 0
fi
exit 0
INNER
    chmod +x "${directory}/node_modules/.bin/dsh"
    printf '%s\n' '{"name":"@deepseek-ai/dsh","version":"0.1.1-rc.2"}' >"${directory}/node_modules/@deepseek-ai/dsh/package.json"
    cat >"${directory}/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js" <<'INNER'
const handle = {
  api,
  isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
};
INNER
    ;;
  */profiles/web)
    if [[ "$*" == *"--lockfile-only"* ]]; then
      printf '%s\n' \
        'sha512-skillhub' \
        'sha512-qqbot' \
        'sha512-weixin' \
        'sha512-wecom' \
        'sha512-lark' \
        'sha512-dingtalk' >"${directory}/pnpm-lock.yaml"
    fi
    python3 - "${directory}" "${LIGHTVELA_DSH_TEST_MISSING_PLUGIN:-}" <<'PY'
import json
import os
import sys

root, missing = sys.argv[1:]
plugins = {
    "@cocofhu/skillhub": "0.2.16",
    "deepseek-harness-qqbot": "0.1.5",
    "deepseek-harness-weixin": "0.2.5",
    "deepseek-harness-wecom": "0.1.5",
    "deepseek-harness-lark": "0.1.5",
    "deepseek-harness-dingtalk": "0.1.5",
}
for name, version in plugins.items():
    if name == missing:
        continue
    package_dir = os.path.join(root, "node_modules", *name.split("/"))
    os.makedirs(package_dir, exist_ok=True)
    payload = {"name": name, "version": version}
    if name not in {"@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"}:
        payload["dsh"] = {"bundle": {"patch": "./cordis.patch.yml"}}
    with open(os.path.join(package_dir, "package.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    with open(os.path.join(package_dir, "cordis.patch.yml"), "w", encoding="utf-8") as handle:
        handle.write("name: test-plugin\n")

with open(os.path.join(root, "package.json"), encoding="utf-8") as handle:
    profile = json.load(handle)
for name, version in profile.get("dependencies", {}).items():
    if name in plugins:
        continue
    package_dir = os.path.join(root, "node_modules", *name.split("/"))
    os.makedirs(package_dir, exist_ok=True)
    payload = {
        "name": name,
        "version": version,
        "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
    }
    with open(os.path.join(package_dir, "package.json"), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
    with open(os.path.join(package_dir, "cordis.patch.yml"), "w", encoding="utf-8") as handle:
        handle.write("name: test-custom-plugin\n")
PY
    ;;
  *) exit 98 ;;
esac
EOF

cat >"${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
url=""
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    http://*|https://*) url="${args[$index]}" ;;
  esac
done
if [[ "${url}" == http://127.0.0.1:* ]]; then
  [ "${LIGHTVELA_DSH_TEST_FAIL_HEALTH:-0}" != "1" ] || exit 1
  if [ -n "${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE:-}" ]; then
    : >"${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE}"
  fi
  exit
fi
exit 64
EOF

cat >"${FAKE_BIN}/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'mv %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP:-0}" = "1" ] \
  && [ "${1:-}" = "${LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH:-}" ] \
  && [[ "${2:-}" == */profiles/.backup-dshi-* ]]; then
  exit 73
fi
exec /bin/mv "$@"
EOF

cat >"${FAKE_BIN}/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'sudo %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -u) shift 2 ;;
    -H|-n) shift ;;
    env) shift; while [ "$#" -gt 0 ] && [[ "$1" == *=* ]]; do export "$1"; shift; done ;;
    *) exec "$@" ;;
  esac
done
EOF

cat >"${FAKE_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
case "$*" in
  *'show --property=MainPID'*) printf '1234\n' ;;
  *'show --property=NRestarts'*) printf '0\n' ;;
  *'show --property=ControlGroup'*) printf '/system.slice/deepseek-harness.service\n' ;;
  *'stop deepseek-harness.service'*) rm -f "${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE:-}" ;;
  *is-active*) exit 0 ;;
  *is-enabled*) [ "${LIGHTVELA_DSH_TEST_SERVICE_ENABLED:-1}" = "1" ] ;;
esac
EOF

cat >"${FAKE_BIN}/ss" <<'EOF'
#!/usr/bin/env bash
if [ -z "${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE:-}" ] \
  || [ -f "${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE}" ]; then
  printf 'LISTEN 0 128 127.0.0.1:3080 0.0.0.0:*\n'
fi
EOF

cat >"${FAKE_BIN}/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "${FAKE_BIN}"/*

export LIGHTVELA_DSH_TEST_MODE=1
export LIGHTVELA_DSH_TEST_ROOT="${TEST_ROOT}"
export LIGHTVELA_DSH_TEST_CALLS="${CALLS}"
export LIGHTVELA_DSH_TEST_FAKE_PNPM="${FAKE_BIN}/pnpm"
export LIGHTVELA_DSH_TEST_HEALTH_READY_FILE="${TMPDIR}/health-ready"
export LIGHTVELA_DSH_HEALTH_ATTEMPTS=2
export PATH="${FAKE_BIN}:${PATH}"
umask 077

mode_of() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

reset_instance() {
  rm -rf "${TEST_ROOT}"
  rm -f "${LIGHTVELA_DSH_TEST_HEALTH_READY_FILE}"
  mkdir -p "${TEST_ROOT}/home/agentuser" "${TEST_ROOT}/run/user/1000"
  : >"${CALLS}"
  unset LIGHTVELA_DSH_TEST_METADATA_FAILURE_SPEC
  unset LIGHTVELA_DSH_TEST_MISSING_INTEGRITY_SPEC
  unset LIGHTVELA_DSH_TEST_MISSING_PLUGIN
  unset LIGHTVELA_DSH_TEST_FAIL_HEALTH
  unset LIGHTVELA_DSH_TEST_MUTATE_ON_DUMP
  unset LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH
  unset LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP
  unset LIGHTVELA_DSH_TEST_SERVICE_ENABLED
  unset LIGHTVELA_DSH_TEST_PNPM_VERSION
}

assert_task_status() {
  local task_id="$1"
  local expected="$2"
  local task
  task="$(${INSTALLER} installation --task-id "${task_id}")"
  python3 - "${task}" "${expected}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
assert data["status"] == sys.argv[2], data
if sys.argv[2] == "succeeded":
    assert data["progress"] == 100, data
PY
}

assert_no_worktree() {
  local work_root="${TEST_ROOT}/var/lib/lightvela/dsh/work"
  if [ -d "${work_root}" ] && find "${work_root}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "DeepSeek Harness task workspace was not cleaned" >&2
    exit 1
  fi
}

reset_instance
first_task="dshi-0123456789abcdef0123456789abcdef"
trusted_browser_host="ins-0123456789abcdef0123456789abcdef.dsh.lightvela.site"
${INSTALLER} install --task-id "${first_task}" --trusted-browser-host "${trusted_browser_host}"

current="${TEST_ROOT}/opt/lightvela/dsh/current"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
test -L "${current}"
release="$(readlink "${current}")"
test "$(readlink "${current}")" = "${release}"
grep -Fq 'ExecStart=/opt/lightvela/dsh/current/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080' "${unit}"
if grep -Fq -- '--no-open' "${unit}"; then
  echo 'unsupported DSH web option --no-open was written to the service unit' >&2
  exit 1
fi
grep -Fq 'Environment=PATH=/opt/lightvela/dsh/current/node_modules/.bin:/opt/lightvela/dsh/tooling/pnpm-10.33.0/node_modules/.bin:/usr/local/bin:/usr/bin:/bin' "${unit}"
grep -Fq 'Environment=DSH_HOME=/home/agentuser/.dsh' "${unit}"
grep -Fq 'User=agentuser' "${unit}"
grep -Fq 'Group=agentuser' "${unit}"
grep -Fq 'Restart=always' "${unit}"
grep -Fq 'UMask=0077' "${unit}"
for package_name in \
  '@cocofhu/skillhub' \
  deepseek-harness-qqbot \
  deepseek-harness-weixin \
  deepseek-harness-wecom \
  deepseek-harness-lark \
  deepseek-harness-dingtalk; do
  test -f "${profile}/node_modules/${package_name}/package.json"
done
! grep -Fq 'npm install' "${CALLS}"
test "$(grep -Ec '^pnpm --dir' "${CALLS}")" -eq 4
test "$(grep -Ec '^pnpm .*install --frozen-lockfile' "${CALLS}")" -eq 2
grep -Fq -- '--fetch-retries 4' "${CALLS}"
grep -Fq -- '--fetch-timeout 300000' "${CALLS}"
grep -Fq 'plugin --profile web list --depth 0 --json' "${CALLS}"
grep -Fq -- '--profile web --dump-config' "${CALLS}"
grep -Fq 'systemctl enable deepseek-harness.service' "${CALLS}"
grep -Fq 'systemctl restart deepseek-harness.service' "${CALLS}"
! grep -Fq 'systemctl --user' "${CALLS}"
assert_task_status "${first_task}" succeeded
assert_no_worktree
test "$(stat -f '%Lp' "${TEST_ROOT}/var/lib/lightvela/dsh/work" 2>/dev/null || stat -c '%a' "${TEST_ROOT}/var/lib/lightvela/dsh/work")" = "711"
for runtime_root in \
  "${TEST_ROOT}/opt/lightvela/dsh" \
  "${TEST_ROOT}/opt/lightvela/dsh/releases" \
  "${TEST_ROOT}/opt/lightvela/dsh/tooling"; do
  test "$(mode_of "${runtime_root}")" = "755"
done
test "$(mode_of "${release}")" = "755"
test "$(mode_of "${release}/node_modules/.bin/dsh")" = "755"
connection_client="${release}/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js"
grep -Fq "pageLocation.hostname === \"${trusted_browser_host}\"" "${connection_client}"
test "$(grep -Fc "pageLocation.hostname === \"${trusted_browser_host}\"" "${connection_client}")" -eq 1
python3 - "${release}/install-manifest.json" "${trusted_browser_host}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    patch = json.load(handle)["browserTrustPatch"]
assert patch == {"version": 1, "hostname": sys.argv[2]}, patch
PY

printf '%s\n' 'custom-provider-patch' >"${profile}/cordis.patch.yml"
: >"${CALLS}"
second_task="dshi-1123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${second_task}" --trusted-browser-host "${trusted_browser_host}"
grep -Fq 'custom-provider-patch' "${profile}/cordis.patch.yml"
assert_task_status "${second_task}" succeeded
assert_no_worktree

: >"${CALLS}"
export LIGHTVELA_DSH_TEST_MUTATE_ON_DUMP=1
export LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH="${profile}"
concurrent_task="dshi-2123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${concurrent_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'profile mutation unexpectedly allowed installation' >&2
  exit 1
fi
python3 - "${profile}/package.json" <<'PY'
import json
import sys

assert json.load(open(sys.argv[1], encoding="utf-8"))["externalMutation"] is True
PY
! grep -Fq 'systemctl stop deepseek-harness.service' "${CALLS}"
assert_task_status "${concurrent_task}" failed
assert_no_worktree

reset_instance
mkdir -p "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
cat >"${TEST_ROOT}/home/agentuser/.dsh/profiles/web/package.json" <<'JSON'
{"dependencies":{"third-party-plugin":"1.0.0"},"dsh":{"profile":{"bundles":["third-party-plugin"]}}}
JSON
printf '%s\n' 'keep-me' >"${TEST_ROOT}/home/agentuser/.dsh/profiles/web/unknown-marker"
printf '%s\n' 'custom-provider-patch' >"${TEST_ROOT}/home/agentuser/.dsh/profiles/web/cordis.patch.yml"
unknown_task="dshi-3123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${unknown_task}" --trusted-browser-host "${trusted_browser_host}"
test -f "${TEST_ROOT}/home/agentuser/.dsh/profiles/web/unknown-marker"
grep -Fq 'third-party-plugin' "${TEST_ROOT}/home/agentuser/.dsh/profiles/web/package.json"
grep -Fq 'custom-provider-patch' "${profile}/cordis.patch.yml"
assert_task_status "${unknown_task}" succeeded
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_METADATA_FAILURE_SPEC='deepseek-harness-weixin@latest'
metadata_task="dshi-4123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${metadata_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'failed npm metadata lookup unexpectedly completed installation' >&2
  exit 1
fi
grep -Fq 'npm view deepseek-harness-weixin@latest' "${CALLS}"
test ! -e "${TEST_ROOT}/opt/lightvela/dsh/current"
test ! -e "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
test ! -e "${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
assert_task_status "${metadata_task}" failed
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_MISSING_INTEGRITY_SPEC='deepseek-harness-wecom@latest'
integrity_task="dshi-8123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${integrity_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'missing npm integrity unexpectedly completed installation' >&2
  exit 1
fi
grep -Fq 'npm view deepseek-harness-wecom@latest' "${CALLS}"
test ! -e "${TEST_ROOT}/opt/lightvela/dsh/current"
test ! -e "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
assert_task_status "${integrity_task}" failed
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_MISSING_PLUGIN=deepseek-harness-lark
plugin_task="dshi-5123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${plugin_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'missing DSH plugin unexpectedly completed installation' >&2
  exit 1
fi
test ! -e "${TEST_ROOT}/opt/lightvela/dsh/current"
test ! -e "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
! grep -Fq 'systemctl restart deepseek-harness.service' "${CALLS}"
assert_task_status "${plugin_task}" failed
assert_no_worktree

reset_instance
partial_baseline_task="dshi-9123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${partial_baseline_task}" --trusted-browser-host "${trusted_browser_host}"
release="$(readlink "${TEST_ROOT}/opt/lightvela/dsh/current")"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
printf '%s\n' 'partial-old-release' >"${release}/rollback-marker"
printf '%s\n' 'partial-old-profile' >"${profile}/cordis.patch.yml"
printf '%s\n' '# partial-old-unit' >>"${unit}"
: >"${CALLS}"
export LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP=1
export LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH="${profile}"
partial_task="dshi-a123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${partial_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'partial profile backup failure unexpectedly completed installation' >&2
  exit 1
fi
test "$(readlink "${TEST_ROOT}/opt/lightvela/dsh/current")" = "${release}"
grep -Fq 'partial-old-release' "${release}/rollback-marker"
grep -Fq 'partial-old-profile' "${profile}/cordis.patch.yml"
grep -Fq 'partial-old-unit' "${unit}"
assert_task_status "${partial_task}" failed
assert_no_worktree

reset_instance
baseline_task="dshi-6123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${baseline_task}" --trusted-browser-host "${trusted_browser_host}"
release="$(readlink "${TEST_ROOT}/opt/lightvela/dsh/current")"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
printf '%s\n' 'old-release' >"${release}/rollback-marker"
printf '%s\n' 'old-profile' >"${profile}/cordis.patch.yml"
printf '%s\n' 'old-unit' >"${unit}"
: >"${CALLS}"
export LIGHTVELA_DSH_TEST_FAIL_HEALTH=1
export LIGHTVELA_DSH_TEST_SERVICE_ENABLED=0
rollback_task="dshi-7123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${rollback_task}" --trusted-browser-host "${trusted_browser_host}"; then
  echo 'failed health check unexpectedly completed installation' >&2
  exit 1
fi
test "$(readlink "${TEST_ROOT}/opt/lightvela/dsh/current")" = "${release}"
grep -Fq 'old-release' "${release}/rollback-marker"
grep -Fq 'old-profile' "${profile}/cordis.patch.yml"
grep -Fq 'old-unit' "${unit}"
test "$(grep -Fc 'systemctl restart deepseek-harness.service' "${CALLS}")" -ge 2
grep -Fq 'systemctl disable deepseek-harness.service' "${CALLS}"
assert_task_status "${rollback_task}" failed
assert_no_worktree

if ${INSTALLER} installation --task-id '../../etc/passwd' >/dev/null 2>&1; then
  echo 'invalid task id unexpectedly accepted' >&2
  exit 1
fi

invalid_host_task="dshi-d123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${invalid_host_task}" \
  --trusted-browser-host 'attacker.example.com' >/dev/null 2>&1; then
  echo 'invalid trusted browser host unexpectedly accepted' >&2
  exit 1
fi

drift_runtime="${TMPDIR}/drift-runtime"
drift_manifest="${TMPDIR}/drift-manifest.json"
mkdir -p "${drift_runtime}/node_modules/@deepseek-ai/dsh-client-connection/lib"
printf '%s\n' 'const handle = { isLoopback: false };' \
  >"${drift_runtime}/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js"
printf '{"browserTrustPatch":{"version":1,"hostname":"%s"}}\n' \
  "${trusted_browser_host}" >"${drift_manifest}"
if bash -c 'source "$1"; patch_browser_connection "$2" "$3"' \
  lightvela-dsh-test "${INSTALLER}" "${drift_runtime}" "${drift_manifest}" >/dev/null 2>&1; then
  echo 'unexpected DSH connection source was patched' >&2
  exit 1
fi

reset_instance
export LIGHTVELA_DSH_TEST_PNPM_VERSION=9.0.0
fallback_task="dshi-b123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${fallback_task}" --trusted-browser-host "${trusted_browser_host}"
grep -Fq 'npm install --prefix' "${CALLS}"
grep -Fq 'pnpm@10.33.0' "${CALLS}"
stable_pnpm="${TEST_ROOT}/opt/lightvela/dsh/tooling/pnpm-10.33.0/node_modules/.bin/pnpm"
test -x "${stable_pnpm}"
test "$("${stable_pnpm}" --version | head -n 1 | tr -d '\r')" = "10.33.0"
for tooling_path in \
  "${TEST_ROOT}/opt/lightvela/dsh/tooling/pnpm-10.33.0" \
  "${TEST_ROOT}/opt/lightvela/dsh/tooling/pnpm-10.33.0/node_modules" \
  "${TEST_ROOT}/opt/lightvela/dsh/tooling/pnpm-10.33.0/node_modules/.bin" \
  "${stable_pnpm}"; do
  test "$(mode_of "${tooling_path}")" = "755"
done
grep -Fq '/opt/lightvela/dsh/tooling/pnpm-10.33.0/node_modules/.bin/pnpm --dir' "${CALLS}"
PATH="$(dirname "${stable_pnpm}"):${PATH}" \
  "${TEST_ROOT}/opt/lightvela/dsh/current/node_modules/.bin/dsh" \
  plugin --profile web list --depth 0 --json >/dev/null
assert_task_status "${fallback_task}" succeeded
unset LIGHTVELA_DSH_TEST_PNPM_VERSION

reset_instance
export LIGHTVELA_DSH_TEST_PNPM_VERSION=9.0.0
legacy_pnpm_root="${TEST_ROOT}/opt/lightvela/dsh/tooling/pnpm-10.33.0"
legacy_pnpm="${legacy_pnpm_root}/node_modules/.bin/pnpm"
mkdir -p "$(dirname "${legacy_pnpm}")"
cat >"${legacy_pnpm}" <<'EOF'
#!/usr/bin/env bash
LIGHTVELA_DSH_TEST_PNPM_VERSION=10.33.0 exec "${LIGHTVELA_DSH_TEST_FAKE_PNPM}" "$@"
EOF
chmod -R 0700 "${legacy_pnpm_root}"
legacy_tooling_task="dshi-c123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${legacy_tooling_task}" --trusted-browser-host "${trusted_browser_host}"
for tooling_path in \
  "${legacy_pnpm_root}" \
  "${legacy_pnpm_root}/node_modules" \
  "${legacy_pnpm_root}/node_modules/.bin" \
  "${legacy_pnpm}"; do
  test "$(mode_of "${tooling_path}")" = "755"
done
! grep -Fq 'npm install --prefix' "${CALLS}"
assert_task_status "${legacy_tooling_task}" succeeded
unset LIGHTVELA_DSH_TEST_PNPM_VERSION

if ${INSTALLER} providers --region cn >/dev/null 2>&1; then
  echo 'installer unexpectedly accepted a Provider helper action' >&2
  exit 1
fi

echo "deepseek harness installer tests passed"
