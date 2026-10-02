#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/create-first-cam-preflight.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

CAM_SAFE_AUTH_JSON='{"ActionFlag":{"Wechat":0,"Token":0}}' \
	"$script_dir/preflight-cam-automation.sh" >"$temporary/pass.log"
grep -Fq 'preflight passed' "$temporary/pass.log"

if CAM_SAFE_AUTH_JSON='{"ActionFlag":{"Wechat":1,"Token":0}}' \
	"$script_dir/preflight-cam-automation.sh" >"$temporary/fail.log" 2>&1; then
	echo "operation-protected CAM unexpectedly passed" >&2
	exit 1
fi
grep -Fq 'enabled methods: Wechat' "$temporary/fail.log"

if CAM_SAFE_AUTH_JSON='{"RequestId":"missing-action-flag"}' \
	"$script_dir/preflight-cam-automation.sh" >"$temporary/malformed.log" 2>&1; then
	echo "malformed CAM response unexpectedly passed" >&2
	exit 1
fi
grep -Fq 'malformed ActionFlag' "$temporary/malformed.log"

echo "CAM automation preflight tests passed"
