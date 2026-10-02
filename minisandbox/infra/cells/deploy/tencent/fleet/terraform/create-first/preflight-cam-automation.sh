#!/usr/bin/env bash
set -euo pipefail

# Creating a Cell deliberately creates two API-only CAM users. Tencent CAM
# rejects AddUser while account-level operation protection is enabled, so fail
# before Terraform creates any billable infrastructure instead of discovering
# the account gate near the end of apply.

region=${TENCENT_REGION:-ap-beijing}
tccli=${TCCLI:-tccli}

command -v jq >/dev/null 2>&1 || {
	echo "jq is required for the CAM automation preflight" >&2
	exit 1
}

if [[ -n ${CAM_SAFE_AUTH_JSON:-} ]]; then
	response=$CAM_SAFE_AUTH_JSON
else
	command -v "$tccli" >/dev/null 2>&1 || {
		echo "tccli is unavailable; set TCCLI to a verified binary" >&2
		exit 1
	}
	response=$($tccli cam DescribeSafeAuthFlag --region "$region")
fi

jq -e '.ActionFlag | type == "object"' >/dev/null <<<"$response" || {
	echo "CAM DescribeSafeAuthFlag returned a malformed ActionFlag" >&2
	exit 1
}

enabled=$(jq -r '[.ActionFlag | to_entries[] | select((.value // 0) != 0) | .key] | sort | join(",")' <<<"$response")
if [[ -n $enabled ]]; then
	echo "CAM operation protection blocks unattended per-Cell AddUser (enabled methods: $enabled)" >&2
	echo "Disable operation protection for the bounded Terraform apply, then re-enable it immediately after apply." >&2
	exit 1
fi

echo "CAM unattended AddUser preflight passed"
