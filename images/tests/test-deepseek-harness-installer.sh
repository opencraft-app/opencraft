#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"
ASSETS_DIR="${ROOT_DIR}/images/runtime/deepseek-harness"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

for required in \
  manifest.json \
  runtime/package.json \
  runtime/pnpm-lock.yaml \
  runtime/.pnpmfile.cjs \
  web-profile/package.json \
  web-profile/pnpm-lock.yaml \
  web-profile/.pnpmfile.cjs \
  web-profile/pnpm-workspace.yaml; do
  test -s "${ASSETS_DIR}/${required}" || {
    echo "missing frozen DeepSeek Harness input: ${required}" >&2
    exit 1
  }
done

python3 - "${ASSETS_DIR}/manifest.json" "${ASSETS_DIR}/runtime/package.json" "${ASSETS_DIR}/web-profile/package.json" "${ASSETS_DIR}/runtime/pnpm-lock.yaml" "${ASSETS_DIR}/web-profile/pnpm-lock.yaml" <<'PY'
import json
import re
import sys

manifest_path, runtime_path, profile_path, runtime_lock_path, profile_lock_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)
with open(runtime_path, encoding="utf-8") as handle:
    runtime = json.load(handle)
with open(profile_path, encoding="utf-8") as handle:
    profile = json.load(handle)

assert manifest["pnpmVersion"] == "10.33.0", manifest
assert runtime["dependencies"] == {"@deepseek-ai/dsh": "0.1.0-rc.7"}, runtime
expected_plugins = {
    "@cocofhu/skillhub": "0.2.13",
    "deepseek-harness-qqbot": "0.1.5",
    "deepseek-harness-weixin": "0.2.5",
    "deepseek-harness-wecom": "0.1.5",
    "deepseek-harness-lark": "0.1.5",
}
managed = {item["package"]: item["version"] for item in manifest["profile"]["plugins"]}
assert managed == expected_plugins, managed
assert "dsh-auth" not in json.dumps(manifest), manifest
assert profile["dsh"]["profile"]["bundles"] == [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    *expected_plugins,
], profile
assert set(profile["dependencies"]) == set(expected_plugins), profile

for lock_path in (runtime_lock_path, profile_lock_path):
    text = open(lock_path, encoding="utf-8").read()
    versions = {
        version
        for _, version in re.findall(r"\s+'?(@deepseek-ai/dsh[^'@: ]*)@([^':( ]+)", text)
    }
    assert versions == {"0.1.0-rc.7"}, (lock_path, versions)
assert manifest["runtime"]["integrity"] in open(runtime_lock_path, encoding="utf-8").read()
skillhub = next(item for item in manifest["profile"]["plugins"] if item["id"] == "skillhub")
assert skillhub["integrity"] in open(profile_lock_path, encoding="utf-8").read()
PY

FAKE_BIN="${TMPDIR}/bin"
TEST_ROOT="${TMPDIR}/root"
CALLS="${TMPDIR}/calls.log"
ARCHIVES="${TMPDIR}/archives"
mkdir -p "${FAKE_BIN}" "${ARCHIVES}"

make_archive() {
  local id="$1"
  local package_name="$2"
  local version="$3"
  local source_dir="${TMPDIR}/archive-source-${id}/fixture-${id}"
  mkdir -p "${source_dir}"
  python3 - "${source_dir}/package.json" "${package_name}" "${version}" <<'PY'
import json
import sys

path, name, version = sys.argv[1:]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(
        {
            "name": name,
            "version": version,
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
        },
        handle,
        separators=(",", ":"),
    )
PY
  printf '%s\n' '- $patch: bundle' >"${source_dir}/cordis.patch.yml"
  tar -czf "${ARCHIVES}/${id}.tar.gz" -C "$(dirname "${source_dir}")" "$(basename "${source_dir}")"
}

make_archive qqbot deepseek-harness-qqbot 0.1.5
make_archive weixin deepseek-harness-weixin 0.2.5
make_archive wecom deepseek-harness-wecom 0.1.5
make_archive lark deepseek-harness-lark 0.1.5

CONFIG_HELPER="${TMPDIR}/configure-deepseek-harness.py"
cat >"${CONFIG_HELPER}" <<'EOF'
#!/usr/bin/env python3
import json
import sys

if sys.argv[1:3] == ["providers", "--region"]:
    print(json.dumps({"providers": [{"id": "deepseek", "displayName": "DeepSeek", "configured": False, "active": True, "writable": True}]}))
elif sys.argv[1:3] == ["configure", "--provider"]:
    value = sys.stdin.read()
    if not value:
        raise SystemExit(2)
    print(json.dumps({"ok": True, "provider": sys.argv[3], "configured": True}))
elif sys.argv[1:3] == ["remove-provider", "--provider"]:
    print(json.dumps({"ok": True, "provider": sys.argv[3], "configured": False}))
else:
    raise SystemExit(2)
EOF
chmod +x "${CONFIG_HELPER}"

cat >"${FAKE_BIN}/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
exit 97
EOF

cat >"${FAKE_BIN}/pnpm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${1:-}" = "--version" ]; then
  printf '10.33.0\n'
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
  */candidate-runtime)
    mkdir -p "${directory}/node_modules/.bin" "${directory}/node_modules/@deepseek-ai/dsh"
    cat >"${directory}/node_modules/.bin/dsh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
printf 'dsh %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${1:-}" = "--version" ]; then
  printf '0.1.0-rc.7\n'
  exit 0
fi
if [ "${1:-}" = "plugin" ]; then
  cat <<'JSON'
[{"name":"@lightvela/deepseek-harness-web-profile","dependencies":{"@cocofhu/skillhub":{"version":"0.2.13"},"deepseek-harness-qqbot":{"version":"0.1.5"},"deepseek-harness-weixin":{"version":"0.2.5"},"deepseek-harness-wecom":{"version":"0.1.5"},"deepseek-harness-lark":{"version":"0.1.5"}}}]
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
    printf '%s\n' '{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.7"}' >"${directory}/node_modules/@deepseek-ai/dsh/package.json"
    ;;
  */profiles/web)
    python3 - "${directory}" "${LIGHTVELA_DSH_TEST_MISSING_PLUGIN:-}" <<'PY'
import json
import os
import sys

root, missing = sys.argv[1:]
plugins = {
    "@cocofhu/skillhub": "0.2.13",
    "deepseek-harness-qqbot": "0.1.5",
    "deepseek-harness-weixin": "0.2.5",
    "deepseek-harness-wecom": "0.1.5",
    "deepseek-harness-lark": "0.1.5",
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
PY
    ;;
  *) exit 98 ;;
esac
EOF

cat >"${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
output=""
url=""
args=("$@")
for ((index = 0; index < ${#args[@]}; index++)); do
  case "${args[$index]}" in
    --output|-o) output="${args[$((index + 1))]}" ;;
    http://*|https://*) url="${args[$index]}" ;;
  esac
done
if [[ "${url}" == http://127.0.0.1:* ]]; then
  [ "${LIGHTVELA_DSH_TEST_FAIL_HEALTH:-0}" != "1" ]
  exit
fi
id=""
case "${url}" in
  */qqbot/*) id="qqbot" ;;
  */weixin/*) id="weixin" ;;
  */wecom/*) id="wecom" ;;
  */lark/*) id="lark" ;;
esac
test -n "${id}"
if [ "${LIGHTVELA_DSH_TEST_DOWNLOAD_FAILURE_ID:-}" = "${id}" ]; then
  exit 22
fi
cp "${LIGHTVELA_DSH_TEST_ARCHIVES}/${id}.tar.gz" "${output}"
EOF

cat >"${FAKE_BIN}/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
path="$1"
id=""
case "$(basename "${path}")" in
  qqbot-*) id="qqbot"; expected="4d2e5c06dc3934569e7a19137c99dabfdbdafb9b6fb0bb7b87167a6ea69be68a" ;;
  weixin-*) id="weixin"; expected="20369d311752211550b178e6e519b80cbd949148d37cbde38ff1974af5afe6b0" ;;
  wecom-*) id="wecom"; expected="870194ca4055afae87ff8b25261ab1d10d5604c2b0c07e17a961128c84ebe6ac" ;;
  lark-*) id="lark"; expected="e3a0aacdd3c2f4926cc5d976d32f152c8e76af204d4315a4c57ccb69b120c153" ;;
  *) exec shasum -a 256 "${path}" ;;
esac
if [ "${LIGHTVELA_DSH_TEST_BAD_SHA_FOR:-}" = "${id}" ]; then
  expected="0000000000000000000000000000000000000000000000000000000000000000"
fi
printf '%s  %s\n' "${expected}" "${path}"
EOF

cat >"${FAKE_BIN}/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'mv %s\n' "$*" >>"${LIGHTVELA_DSH_TEST_CALLS}"
if [ "${LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP:-0}" = "1" ] \
  && [ "${1:-}" = "${LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH:-}" ] \
  && [[ "${2:-}" == */backup/profile ]]; then
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
  *is-active*) printf 'active\n' ;;
  *is-enabled*) [ "${LIGHTVELA_DSH_TEST_SERVICE_ENABLED:-1}" = "1" ] ;;
esac
EOF

cat >"${FAKE_BIN}/ss" <<'EOF'
#!/usr/bin/env bash
printf 'LISTEN 0 128 127.0.0.1:3080 0.0.0.0:*\n'
EOF

chmod +x "${FAKE_BIN}"/*

export LIGHTVELA_DSH_TEST_MODE=1
export LIGHTVELA_DSH_TEST_ROOT="${TEST_ROOT}"
export LIGHTVELA_DSH_TEST_CALLS="${CALLS}"
export LIGHTVELA_DSH_TEST_ARCHIVES="${ARCHIVES}"
export LIGHTVELA_DSH_CONFIG_HELPER="${CONFIG_HELPER}"
export LIGHTVELA_DSH_ASSETS_DIR="${ASSETS_DIR}"
export LIGHTVELA_DSH_HEALTH_ATTEMPTS=2
export PATH="${FAKE_BIN}:${PATH}"

reset_instance() {
  rm -rf "${TEST_ROOT}"
  mkdir -p "${TEST_ROOT}/home/agentuser" "${TEST_ROOT}/run/user/1000"
  : >"${CALLS}"
  unset LIGHTVELA_DSH_TEST_DOWNLOAD_FAILURE_ID
  unset LIGHTVELA_DSH_TEST_BAD_SHA_FOR
  unset LIGHTVELA_DSH_TEST_MISSING_PLUGIN
  unset LIGHTVELA_DSH_TEST_FAIL_HEALTH
  unset LIGHTVELA_DSH_TEST_MUTATE_ON_DUMP
  unset LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH
  unset LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP
  unset LIGHTVELA_DSH_TEST_SERVICE_ENABLED
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
${INSTALLER} install --task-id "${first_task}"

current="${TEST_ROOT}/opt/lightvela/dsh/current"
release="${TEST_ROOT}/opt/lightvela/dsh/releases/0.1.0-rc.7"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
test -L "${current}"
test "$(readlink "${current}")" = "${release}"
grep -Fq 'ExecStart=/opt/lightvela/dsh/current/node_modules/.bin/dsh web --host 127.0.0.1 --port 3080 --no-open' "${unit}"
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
  deepseek-harness-lark; do
  test -f "${profile}/node_modules/${package_name}/package.json"
done
! grep -Fq 'npm install' "${CALLS}"
test "$(grep -Ec '^pnpm --dir' "${CALLS}")" -eq 2
test "$(grep -Ec '^pnpm .*install --frozen-lockfile' "${CALLS}")" -eq 2
grep -Fq -- '--fetch-retries 4' "${CALLS}"
grep -Fq -- '--fetch-timeout 300000' "${CALLS}"
grep -Fq -- '--connect-timeout 10 --max-time 300' "${CALLS}"
grep -Fq 'plugin --profile web list --depth 0 --json' "${CALLS}"
grep -Fq -- '--profile web --dump-config' "${CALLS}"
grep -Fq 'systemctl enable deepseek-harness.service' "${CALLS}"
grep -Fq 'systemctl restart deepseek-harness.service' "${CALLS}"
! grep -Fq 'systemctl --user' "${CALLS}"
assert_task_status "${first_task}" succeeded
assert_no_worktree
test "$(stat -f '%Lp' "${TEST_ROOT}/var/lib/lightvela/dsh/work" 2>/dev/null || stat -c '%a' "${TEST_ROOT}/var/lib/lightvela/dsh/work")" = "711"

printf '%s\n' 'custom-provider-patch' >"${profile}/cordis.patch.yml"
: >"${CALLS}"
second_task="dshi-1123456789abcdef0123456789abcdef"
${INSTALLER} install --task-id "${second_task}"
grep -Fq 'custom-provider-patch' "${profile}/cordis.patch.yml"
assert_task_status "${second_task}" succeeded
assert_no_worktree

: >"${CALLS}"
export LIGHTVELA_DSH_TEST_MUTATE_ON_DUMP=1
export LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH="${profile}"
concurrent_task="dshi-2123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${concurrent_task}"; then
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
unknown_task="dshi-3123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${unknown_task}"; then
  echo 'unknown profile plugin unexpectedly allowed installation' >&2
  exit 1
fi
test -f "${TEST_ROOT}/home/agentuser/.dsh/profiles/web/unknown-marker"
! grep -Fq 'curl ' "${CALLS}"
! grep -Fq 'pnpm ' "${CALLS}"
assert_task_status "${unknown_task}" failed
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_DOWNLOAD_FAILURE_ID=weixin
download_task="dshi-4123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${download_task}"; then
  echo 'failed plugin download unexpectedly completed installation' >&2
  exit 1
fi
test "$(grep -Fc '/plugins/weixin/' "${CALLS}")" -eq 5
test ! -e "${TEST_ROOT}/opt/lightvela/dsh/current"
test ! -e "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
test ! -e "${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
assert_task_status "${download_task}" failed
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_BAD_SHA_FOR=wecom
checksum_task="dshi-8123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${checksum_task}"; then
  echo 'checksum mismatch unexpectedly completed installation' >&2
  exit 1
fi
test "$(grep -Fc '/plugins/wecom/' "${CALLS}")" -eq 5
test ! -e "${TEST_ROOT}/opt/lightvela/dsh/current"
test ! -e "${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
assert_task_status "${checksum_task}" failed
assert_no_worktree

reset_instance
export LIGHTVELA_DSH_TEST_MISSING_PLUGIN=deepseek-harness-lark
plugin_task="dshi-5123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${plugin_task}"; then
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
${INSTALLER} install --task-id "${partial_baseline_task}"
release="${TEST_ROOT}/opt/lightvela/dsh/releases/0.1.0-rc.7"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
printf '%s\n' 'partial-old-release' >"${release}/rollback-marker"
printf '%s\n' 'partial-old-profile' >"${profile}/cordis.patch.yml"
printf '%s\n' '# partial-old-unit' >>"${unit}"
: >"${CALLS}"
export LIGHTVELA_DSH_TEST_FAIL_PROFILE_BACKUP=1
export LIGHTVELA_DSH_TEST_LIVE_PROFILE_PATH="${profile}"
partial_task="dshi-a123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${partial_task}"; then
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
${INSTALLER} install --task-id "${baseline_task}"
release="${TEST_ROOT}/opt/lightvela/dsh/releases/0.1.0-rc.7"
profile="${TEST_ROOT}/home/agentuser/.dsh/profiles/web"
unit="${TEST_ROOT}/etc/systemd/system/deepseek-harness.service"
printf '%s\n' 'old-release' >"${release}/rollback-marker"
printf '%s\n' 'old-profile' >"${profile}/cordis.patch.yml"
printf '%s\n' 'old-unit' >"${unit}"
: >"${CALLS}"
export LIGHTVELA_DSH_TEST_FAIL_HEALTH=1
export LIGHTVELA_DSH_TEST_SERVICE_ENABLED=0
rollback_task="dshi-7123456789abcdef0123456789abcdef"
if ${INSTALLER} install --task-id "${rollback_task}"; then
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

providers="$(${INSTALLER} providers --region cn)"
python3 - "${providers}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
assert [item["id"] for item in data["providers"]] == ["deepseek"], data
PY

configured="$(printf '%s' 'secret-value' | ${INSTALLER} configure --provider deepseek)"
python3 - "${configured}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
assert data == {"ok": True, "provider": "deepseek", "configured": True}, data
PY

if printf '%s' 'secret-value' | ${INSTALLER} configure --provider unsupported >/dev/null 2>&1; then
  echo 'unsupported provider unexpectedly accepted' >&2
  exit 1
fi

removed="$(${INSTALLER} remove-provider --provider deepseek)"
python3 - "${removed}" <<'PY'
import json
import sys

data = json.loads(sys.argv[1])
assert data == {"ok": True, "provider": "deepseek", "configured": False}, data
PY

if ${INSTALLER} remove-provider --provider unsupported >/dev/null 2>&1; then
  echo 'unsupported provider removal unexpectedly accepted' >&2
  exit 1
fi

echo "deepseek harness installer tests passed"
