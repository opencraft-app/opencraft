#!/usr/bin/env bash
# Install Playwright Chromium on CI runners.
#
# `playwright install --with-deps` installs system packages through apt.
# When the Ubuntu archives are unreachable from GitHub-hosted runners (as on
# 2026-11-11, when every *.ubuntu.com host failed DNS resolution), that step
# exits 100 and blocks every browser job. The runner images already ship
# Google Chrome and its shared libraries, and the Chromium build itself comes
# from the Playwright CDN, not apt. So if the apt-backed install fails, fall
# back to installing the browser alone and let the tests run.
set -euo pipefail

if npx playwright install --with-deps chromium; then
  exit 0
fi

echo "::warning::playwright install --with-deps failed (apt unavailable?); installing Chromium without system packages" >&2
npx playwright install chromium
