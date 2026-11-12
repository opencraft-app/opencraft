#!/usr/bin/env bash
# Use the same display setup for preflight, native probes and the packaged app.
set -euo pipefail
args=(-a -e /dev/stderr)
if [[ ! -w /tmp ]]; then
  export TMPDIR=${TMPDIR:-/var/tmp}
  # Xvfb uses a hardcoded /tmp for its display lock. On Linux its abstract
  # Unix socket still enforces exclusive ownership of the display number.
  args+=(-s '-screen 0 1280x1024x24 -nolock')
fi
exec xvfb-run "${args[@]}" "$@"
