#!/usr/bin/env bash
# Xvfb itself uses /tmp for display locks and compiled keyboard maps.
set -euo pipefail
if [[ ! -w /tmp ]]; then
  exec bwrap --dev-bind / / --tmpfs /tmp -- xvfb-run -a "$@"
fi
exec xvfb-run -a "$@"
