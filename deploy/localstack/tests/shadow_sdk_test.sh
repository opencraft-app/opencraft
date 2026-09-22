#!/usr/bin/env bash
set -euo pipefail

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

REPO_ROOT_ORIGINAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../localstack.sh
source "$REPO_ROOT_ORIGINAL/deploy/localstack/localstack.sh"

fail() {
  printf 'shadow SDK test failed: %s\n' "$*" >&2
  exit 1
}

parent="$TEST_ROOT/parent"
remote="$TEST_ROOT/tencentcloud-sdk-go.git"
source_repo="$TEST_ROOT/tencentcloud-sdk-go-source"
mkdir -p "$parent" "$source_repo/tencentcloud/common"
git -C "$parent" init -q
git -C "$parent" remote add origin https://git.woa.com/wisp/mono2.git

git -C "$source_repo" init -q
git -C "$source_repo" config user.email test@example.com
git -C "$source_repo" config user.name test
printf 'module example.test/tencentcloud-sdk-go/tencentcloud/common\n' \
  >"$source_repo/tencentcloud/common/go.mod"
git -C "$source_repo" add .
git -C "$source_repo" commit -qm initial
ref="$(git -C "$source_repo" rev-parse HEAD)"
git clone -q --bare "$source_repo" "$remote"

REPO_ROOT="$parent"
expected_https='https://git.woa.com/tencentcloud-internal/tencentcloud-sdk-go.git'
[[ "$(shadow_sdk_repository)" == "$expected_https" ]] \
  || fail 'HTTPS parent remote did not select the HTTPS Shadow SDK remote'

git -C "$parent" remote set-url origin git@git.woa.com:wisp/mono2.git
expected_ssh='git@git.woa.com:tencentcloud-internal/tencentcloud-sdk-go.git'
[[ "$(shadow_sdk_repository)" == "$expected_ssh" ]] \
  || fail 'SSH parent remote did not select the SSH Shadow SDK remote'

mkdir -p "$parent/shadow/tencentcloud-sdk-go"
git -C "$parent/shadow/tencentcloud-sdk-go" init -q
SHADOW_TENCENT_SDK_REPO="$remote"
SHADOW_TENCENT_SDK_REF="$ref"
prepare_shadow_sdk

[[ -f "$parent/shadow/tencentcloud-sdk-go/tencentcloud/common/go.mod" ]] \
  || fail 'incomplete .git-only Shadow SDK checkout was not repaired'
[[ "$(git -C "$parent/shadow/tencentcloud-sdk-go" rev-parse HEAD)" == "$ref" ]] \
  || fail 'repaired Shadow SDK checkout is not at the requested revision'

printf 'shadow SDK localstack contract passed\n'
