#!/usr/bin/env bash
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([a-f0-9]{40})\ ([a-f0-9]{64})$ ]]; then
  exec sudo -n /usr/local/libexec/opencraft-relay-activate "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
fi
printf '%s\n' 'Only an identified relay deployment is allowed.' >&2
exit 1
