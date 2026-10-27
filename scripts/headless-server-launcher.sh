#!/bin/sh
set -eu

opencraft_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
exec "$opencraft_root/bin/node" "$opencraft_root/runtime/server.mjs" "$@"
