#!/usr/bin/env bash
# Claude Code cloud sessions start on a generic Ubuntu VM. Bring it to the
# toolchain CI uses (Node from .nvmrc, test system packages, npm ci) so local
# results in the session match CI. Local sessions are left alone.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
log="${TMPDIR:-/tmp}/opencraft-session-start.log"
if bin="$(bash "$root/scripts/ci/setup-toolchain.sh" all 2>"$log")"; then
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
    # The test isolation CI enables after npm ci (.github/workflows/build-matrix.yml).
    echo "export NODE_OPTIONS=\"--import $root/tests/support/test-isolation.mjs --test-global-setup=$root/tests/support/test-isolation-global.mjs\"" >> "$CLAUDE_ENV_FILE"
  fi
  echo "OpenCraft toolchain ready: Node $("$bin/node" -v), npm $(PATH="$bin:$PATH" npm -v), dependencies installed (scripts/ci/setup-toolchain.sh)."
else
  # Never block the session; tell Claude what is missing instead.
  echo "OpenCraft toolchain setup failed; the session may not match CI. Log: $log. Last lines:"
  tail -n 5 "$log"
  echo "Retry with: bash scripts/ci/setup-toolchain.sh all"
fi
exit 0
