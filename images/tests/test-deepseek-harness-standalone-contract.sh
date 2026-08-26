#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"

bash -n "${INSTALLER}"

if grep -Eq 'readonly DSH_VERSION=|0\.1\.0-rc\.7|0\.2\.13' "${INSTALLER}"; then
  echo "installer must not pin DSH or plugin versions" >&2
  exit 1
fi

if grep -Eq 'LIGHTVELA_DSH_ASSETS_DIR|DEFAULT_ASSETS_DIR|runtime/pnpm-lock\.yaml|web-profile/pnpm-lock\.yaml' "${INSTALLER}"; then
  echo "installer must not depend on external runtime assets" >&2
  exit 1
fi

for marker in \
  '@deepseek-ai/dsh@latest' \
  '@cocofhu/skillhub@latest' \
  'deepseek-harness-qqbot@latest' \
  'deepseek-harness-weixin@latest' \
  'deepseek-harness-wecom@latest' \
  'deepseek-harness-lark@latest' \
  'deepseek-harness-dingtalk@latest' \
  'write_task running snapshot_resolved 28' \
  'write_task running runtime_lockfile 35' \
  'write_task running runtime_install 48' \
  'write_task running profile_lockfile 56' \
  'write_task running profile_install 68' \
  'plugin --profile web list --depth 0 --json' \
  '--profile web --dump-config' \
  'ControlGroup' \
  'NRestarts'; do
  grep -Fq -- "${marker}" "${INSTALLER}" || {
    echo "installer is missing standalone contract marker: ${marker}" >&2
    exit 1
  }
done

if grep -Fq 'dsh-auth' "${INSTALLER}"; then
  echo "installer must not install dsh-auth" >&2
  exit 1
fi

if grep -Eiq 'github|codeload|refs/heads/main|ls-remote' "${INSTALLER}"; then
  echo "installer must not depend on GitHub for profile plugins" >&2
  exit 1
fi

echo "deepseek harness standalone contract tests passed"
