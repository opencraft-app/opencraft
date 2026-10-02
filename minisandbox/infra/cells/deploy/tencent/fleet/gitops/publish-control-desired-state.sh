#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export ACTOR_GIT_TARGET_PATH=platform/actor-bj-q01/current
exec "$script_dir/publish-desired-state.sh" "$@"
