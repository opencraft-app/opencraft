#!/usr/bin/env bash
set -euo pipefail

export GUARD_REPO_ROOT="${GUARD_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
exec bash "$GUARD_REPO_ROOT/.ci/checks/frontend_guard.sh" "$@"
