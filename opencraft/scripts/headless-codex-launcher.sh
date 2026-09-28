#!/bin/sh
set -eu

opencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd -P)
exec "$opencraft_root/bin/node" "$opencraft_root/runtime/codex/node_modules/@openai/codex/bin/codex.js" "$@"
