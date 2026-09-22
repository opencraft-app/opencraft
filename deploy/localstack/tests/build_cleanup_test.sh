#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

FAKE_DOCKER="$TEST_ROOT/docker"
FAKE_STATE="$TEST_ROOT/state"
FAKE_REMOVED="$TEST_ROOT/removed"
printf 'before\n' >"$FAKE_STATE"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  "image ls --filter dangling=true --quiet --no-trunc")' \
  '    printf "%s\\n" sha256:old' \
  '    if [[ "$(<"$FAKE_STATE")" == after ]]; then printf "%s\\n" sha256:new; fi' \
  '    ;;' \
  '  "image rm sha256:new") printf "%s\\n" sha256:new >>"$FAKE_REMOVED" ;;' \
  '  *) exit 1 ;;' \
  'esac' >"$FAKE_DOCKER"
chmod 700 "$FAKE_DOCKER"

export FAKE_STATE FAKE_REMOVED
export LOCALSTACK_STATE_DIR="$TEST_ROOT/localstack"
export DOCKER="$FAKE_DOCKER"
source "$REPO_ROOT/deploy/localstack/localstack.sh"

build_image() {
  [[ "$1" == probe ]]
  printf 'after\n' >"$FAKE_STATE"
}

build_component_with_cleanup probe
test "$(cat "$FAKE_REMOVED")" = 'sha256:new'

printf 'localstack build cleanup test passed\n'
