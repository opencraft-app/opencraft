#!/usr/bin/env bash
set -euo pipefail

# Check live CVM zones before creating billable regional infrastructure.
# Cell and management Terraform also enforce this contract at VPC creation;
# this preflight runs earlier, before foundation bootstrap.

region=${TENCENT_REGION:-ap-beijing}
availability_mode=${AVAILABILITY_MODE:-production-multi-zone}
tccli=${TCCLI:-tccli}

case "$availability_mode" in
production-multi-zone) required_zones=3 ;;
qualification-single-zone) required_zones=1 ;;
*)
	echo "invalid AVAILABILITY_MODE: $availability_mode" >&2
	exit 2
	;;
esac

[[ $region =~ ^[a-z]+-[a-z]+$ ]] || {
	echo "invalid TENCENT_REGION: $region" >&2
	exit 2
}

command -v jq >/dev/null 2>&1 || {
	echo "jq is required for the regional zone preflight" >&2
	exit 1
}

if [[ -n ${CVM_ZONES_JSON:-} ]]; then
	response=$CVM_ZONES_JSON
else
	command -v "$tccli" >/dev/null 2>&1 || {
		echo "tccli is unavailable; set TCCLI to a verified binary" >&2
		exit 1
	}
	response=$("$tccli" cvm DescribeZones --region "$region")
fi

jq -e --arg region "$region" '
	(.ZoneSet | type == "array") and
	(all(.ZoneSet[];
		(.Zone | type == "string") and
		(.Zone | startswith($region + "-")) and
		(.ZoneState | type == "string")))
' >/dev/null <<<"$response" || {
	echo "CVM DescribeZones returned a malformed or cross-region ZoneSet" >&2
	exit 1
}

mapfile -t zones < <(jq -r '
	[.ZoneSet[] | select(.ZoneState == "AVAILABLE") | .Zone] | unique[]
' <<<"$response")

if (( ${#zones[@]} < required_zones )); then
	visible=$(IFS=,; echo "${zones[*]:-none}")
	echo "region $region exposes ${#zones[@]} AVAILABLE CVM zone(s), but $availability_mode requires at least $required_zones: $visible" >&2
	exit 1
fi

printf 'regional zone preflight passed region=%s mode=%s available=%d zones=%s\n' \
	"$region" "$availability_mode" "${#zones[@]}" "$(IFS=,; echo "${zones[*]}")"
