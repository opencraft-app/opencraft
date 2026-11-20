#!/usr/bin/env bash
set -Eeuo pipefail
# Run on the Docker host, under an independent supervisor when self-hosted.
[[ $# == 2 || ( $# == 3 && $3 == --rollback ) ]] || { echo 'Usage: publish.sh PLAN.json DEPLOYMENT_LOCK [--rollback]' >&2; exit 2; }
release_plan=$(realpath -- "$1")
release_lock=$(realpath -m -- "$2")
release_wait=${OPENCRAFT_DEPLOY_WAIT_SECONDS:-0}
[[ "$release_wait" =~ ^(0|[1-9][0-9]{0,3})$ ]] && (( release_wait <= 1800 )) || { echo 'Deployment wait must be 0..1800 seconds' >&2; exit 2; }
exec 9>"$release_lock"
flock -w "$release_wait" 9 || { echo 'Another deployment holds this lock; nothing changed.' >&2; exit 75; }
release_script=$(dirname -- "$(realpath -- "${BASH_SOURCE[0]}")")/publish.mjs
exec "${OPENCRAFT_NODE:-node}" "$release_script" "$release_plan" "${3:-}"
