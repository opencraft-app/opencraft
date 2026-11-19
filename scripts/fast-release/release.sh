#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -ge 4 && $3 == -- ]] || { echo 'Usage: release.sh PLAN.json DEPLOYMENT_LOCK -- BUILD_COMMAND [ARGS...]' >&2; exit 2; }
release_plan=$(realpath -m -- "$1")
release_lock=$(realpath -m -- "$2")
release_directory=$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")
release_node=${OPENCRAFT_NODE:-node}
shift 3
"$release_node" "$release_directory/prepare.mjs" assert-unlocked "$release_lock"
# Trusted argv, executed once outside the lease. Candidate verification belongs here.
"$@"
release_prepared=$("$release_node" "$release_directory/prepare.mjs" seal "$release_plan" "$release_lock")
printf 'Prepared release plan: %s\n' "$release_prepared"
exec "$release_directory/publish.sh" "$release_prepared" "$release_lock"
