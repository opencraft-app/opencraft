#!/usr/bin/env bash
# Install Playwright Chromium and its system packages on CI runners.
#
# GitHub-hosted Ubuntu runners resolve the -security pocket from
# security.ubuntu.com. When that host is unreachable, `apt-get update`
# leaves the security indexes missing and `playwright install --with-deps`
# fails with exit code 100. The Azure archive mirror the runners already use
# also carries the -security pocket, so point security entries there first.
set -euo pipefail

if [[ "$(uname -s)" == "Linux" ]] && command -v apt-get >/dev/null 2>&1; then
  mirror="$(grep -rhoE 'https?://[a-z0-9.-]*archive\.ubuntu\.com' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | head -n 1 || true)"
  if [[ -n "${mirror}" ]]; then
    sudo find /etc/apt/sources.list /etc/apt/sources.list.d -type f \( -name '*.list' -o -name '*.sources' -o -name 'sources.list' \) \
      -exec sed -i -E "s#https?://security\.ubuntu\.com#${mirror}#g" {} +
  fi
fi

for attempt in 1 2; do
  if npx playwright install --with-deps chromium; then
    exit 0
  fi
  if [[ "${attempt}" == 1 ]]; then
    echo "playwright install failed; retrying once after 30s" >&2
    sleep 30
  fi
done
exit 1
