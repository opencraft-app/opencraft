#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT

export LIGHTVELA_DSH_TEST_MODE=1
export LIGHTVELA_DSH_TEST_ROOT="${TMPDIR}/root"

# shellcheck source=../helpers/install-deepseek-harness.sh
source "${INSTALLER}"

task_id="dshi-0123456789abcdef0123456789abcdef"
mkdir -p \
  "${RELEASES_DIR}/.staging-${task_id}" \
  "${DSH_HOME}/.staging-${task_id}" \
  "${DSH_HOME}/profiles/.backup-${task_id}" \
  "${TOOLING_ROOT}/.pnpm-staging-${task_id}" \
  "${WORK_ROOT}/${task_id}" \
  "${RELEASES_DIR}/.staging-user-data"
mkdir -p "$(dirname "${UNIT_PATH}")"
touch "${UNIT_PATH}.candidate-${task_id}" "${UNIT_PATH}.backup-${task_id}"

cleanup_abandoned_install_artifacts

test ! -e "${RELEASES_DIR}/.staging-${task_id}"
test ! -e "${DSH_HOME}/.staging-${task_id}"
test ! -e "${DSH_HOME}/profiles/.backup-${task_id}"
test ! -e "${TOOLING_ROOT}/.pnpm-staging-${task_id}"
test ! -e "${WORK_ROOT}/${task_id}"
test ! -e "${UNIT_PATH}.candidate-${task_id}"
test ! -e "${UNIT_PATH}.backup-${task_id}"
test -d "${RELEASES_DIR}/.staging-user-data"
rm -rf -- "${RELEASES_DIR}/.staging-user-data"

write_manifest() {
  local destination="$1"
  local resolved_at="$2"
  python3 - "${destination}" "${resolved_at}" <<'PY'
import json
import sys

destination, resolved_at = sys.argv[1:]
manifest = {
    "schemaVersion": 3,
    "resolvedAt": resolved_at,
    "pnpmVersion": "10.33.0",
    "runtime": {
        "package": "@deepseek-ai/dsh",
        "requested": "latest",
        "version": "9.9.9",
        "integrity": "sha512-runtime",
        "tarball": "https://registry.npmjs.org/runtime.tgz",
    },
    "profile": {
        "name": "web",
        "builtInBundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
        "plugins": [
            {
                "id": "skillhub",
                "source": "npm",
                "package": "@cocofhu/skillhub",
                "requested": "latest",
                "version": "8.8.8",
                "integrity": "sha512-skillhub",
                "tarball": "https://registry.npmjs.org/skillhub.tgz",
            },
            *(
                {
                    "id": plugin_id,
                    "source": "npm",
                    "package": f"deepseek-harness-{plugin_id}",
                    "requested": "latest",
                    "version": version,
                    "integrity": f"sha512-{plugin_id}",
                    "tarball": f"https://registry.npmjs.org/deepseek-harness-{plugin_id}.tgz",
                }
                for plugin_id, version in (
                    ("qqbot", "1.0.0"),
                    ("weixin", "1.0.1"),
                    ("wecom", "1.0.2"),
                    ("lark", "1.0.3"),
                    ("dingtalk", "1.0.4"),
                )
            ),
        ],
    },
}
with open(destination, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, sort_keys=True)
PY
}

mkdir -p "${RELEASES_DIR}"
first_manifest="${TMPDIR}/first.json"
second_manifest="${TMPDIR}/second.json"
write_manifest "${first_manifest}" "2026-08-25T00:00:00Z"
write_manifest "${second_manifest}" "2026-08-25T01:00:00Z"

finalize_snapshot "${first_manifest}"
first_snapshot="${SNAPSHOT_ID}"
finalize_snapshot "${second_manifest}"
second_snapshot="${SNAPSHOT_ID}"
test "${first_snapshot}" = "${second_snapshot}"

if find_reusable_release "${second_manifest}" >/dev/null; then
  echo "find_reusable_release must fail when no matching release exists" >&2
  exit 1
fi

profile_dir="${TMPDIR}/profile"
runtime_dir="${TMPDIR}/runtime"
write_candidate_inputs "${first_manifest}" "${runtime_dir}" "${profile_dir}"
python3 - "${profile_dir}/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    profile = json.load(handle)
expected = {
    "@cocofhu/skillhub": "8.8.8",
    "deepseek-harness-qqbot": "1.0.0",
    "deepseek-harness-weixin": "1.0.1",
    "deepseek-harness-wecom": "1.0.2",
    "deepseek-harness-lark": "1.0.3",
    "deepseek-harness-dingtalk": "1.0.4",
}
if profile.get("dependencies") != expected:
    raise SystemExit(f"unexpected npm profile dependencies: {profile.get('dependencies')!r}")
PY

printf 'sha512-runtime\n' >"${runtime_dir}/pnpm-lock.yaml"
printf '%s\n' \
  'sha512-skillhub' \
  'sha512-qqbot' \
  'sha512-weixin' \
  'sha512-wecom' \
  'sha512-lark' \
  'sha512-dingtalk' >"${profile_dir}/pnpm-lock.yaml"
validate_lockfiles "${runtime_dir}" "${profile_dir}" "${first_manifest}"
grep -Fv 'sha512-dingtalk' "${profile_dir}/pnpm-lock.yaml" >"${profile_dir}/pnpm-lock-missing.yaml"
mv "${profile_dir}/pnpm-lock-missing.yaml" "${profile_dir}/pnpm-lock.yaml"
if validate_lockfiles "${runtime_dir}" "${profile_dir}" "${first_manifest}" 2>/dev/null; then
  echo "profile lockfile validation must reject a missing channel integrity" >&2
  exit 1
fi

reusable_release="${RELEASES_DIR}/${first_snapshot}-existing"
mkdir -p "${reusable_release}/node_modules/.bin"
cp "${first_manifest}" "${reusable_release}/install-manifest.json"
printf '#!/usr/bin/env bash\n' >"${reusable_release}/node_modules/.bin/dsh"
chmod +x "${reusable_release}/node_modules/.bin/dsh"
normalized_reusable="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${reusable_release}")"
test "$(find_reusable_release "${second_manifest}")" = "${normalized_reusable}"

current_release="${RELEASES_DIR}/${first_snapshot}-current"
previous_release="${RELEASES_DIR}/8.8.8-previous"
old_release="${RELEASES_DIR}/7.7.7-old"
mkdir -p "${current_release}" "${previous_release}" "${old_release}"
touch -t 202608250100 "${previous_release}"
touch -t 202608250000 "${old_release}"
prune_old_releases "${current_release}" "${previous_release}"
test -d "${current_release}"
test -d "${previous_release}"
test ! -e "${old_release}"
test ! -e "${reusable_release}"
test "$(find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = "2"

newer_previous="${RELEASES_DIR}/8.8.9-newer"
older_previous="${RELEASES_DIR}/8.8.7-older"
mkdir -p "${newer_previous}" "${older_previous}"
touch -t 202608250300 "${newer_previous}"
touch -t 202608250200 "${older_previous}"
prune_old_releases "${current_release}" "${current_release}"
test -d "${current_release}"
test -d "${newer_previous}"
test ! -e "${previous_release}"
test ! -e "${older_previous}"
test "$(find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = "2"

echo "deepseek harness release retention tests passed"
