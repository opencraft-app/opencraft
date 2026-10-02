#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/create-first-zone-preflight.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

three_zones='{"ZoneSet":[{"Zone":"ap-beijing-8","ZoneState":"AVAILABLE"},{"Zone":"ap-beijing-6","ZoneState":"AVAILABLE"},{"Zone":"ap-beijing-7","ZoneState":"AVAILABLE"}]}'
TENCENT_REGION=ap-beijing AVAILABILITY_MODE=production-multi-zone CVM_ZONES_JSON=$three_zones \
	"$script_dir/preflight-region-zones.sh" >"$temporary/production-pass.log"
grep -Fq 'available=3 zones=ap-beijing-6,ap-beijing-7,ap-beijing-8' "$temporary/production-pass.log"

one_zone='{"ZoneSet":[{"Zone":"ap-chengdu-1","ZoneState":"AVAILABLE"}]}'
if TENCENT_REGION=ap-chengdu AVAILABILITY_MODE=production-multi-zone CVM_ZONES_JSON=$one_zone \
	"$script_dir/preflight-region-zones.sh" >"$temporary/production-fail.log" 2>&1; then
	echo "single-zone region unexpectedly passed the production preflight" >&2
	exit 1
fi
grep -Fq 'requires at least 3: ap-chengdu-1' "$temporary/production-fail.log"

TENCENT_REGION=ap-chengdu AVAILABILITY_MODE=qualification-single-zone CVM_ZONES_JSON=$one_zone \
	"$script_dir/preflight-region-zones.sh" >"$temporary/qualification-pass.log"
grep -Fq 'mode=qualification-single-zone available=1 zones=ap-chengdu-1' "$temporary/qualification-pass.log"

unavailable='{"ZoneSet":[{"Zone":"ap-chengdu-1","ZoneState":"UNAVAILABLE"}]}'
if TENCENT_REGION=ap-chengdu AVAILABILITY_MODE=qualification-single-zone CVM_ZONES_JSON=$unavailable \
	"$script_dir/preflight-region-zones.sh" >"$temporary/unavailable.log" 2>&1; then
	echo "unavailable zone unexpectedly passed qualification" >&2
	exit 1
fi
grep -Fq 'requires at least 1: none' "$temporary/unavailable.log"

cross_region='{"ZoneSet":[{"Zone":"ap-beijing-8","ZoneState":"AVAILABLE"}]}'
if TENCENT_REGION=ap-chengdu AVAILABILITY_MODE=qualification-single-zone CVM_ZONES_JSON=$cross_region \
	"$script_dir/preflight-region-zones.sh" >"$temporary/cross-region.log" 2>&1; then
	echo "cross-region zone response unexpectedly passed" >&2
	exit 1
fi
grep -Fq 'cross-region ZoneSet' "$temporary/cross-region.log"

echo "regional zone preflight tests passed"
