#!/usr/bin/env bash

tat_die() {
	echo "tat: $*" >&2
	return 1
}

tat_require_command() {
	command -v "$1" >/dev/null 2>&1 || tat_die "required command not found: $1"
}

tat_require_environment() {
	local name
	for name in "$@"; do
		if [[ -z ${!name:-} ]]; then
			tat_die "required environment variable is empty: $name"
			return 1
		fi
	done
}

tat_require_authentication() {
	local name oidc_present=0 static_present=0
	if [[ -n ${TENCENT_PROFILE:-} ]]; then
		return 0
	fi
	for name in TKE_REGION TKE_PROVIDER_ID TKE_ROLE_ARN TKE_WEB_IDENTITY_TOKEN_FILE; do
		[[ -z ${!name:-} ]] || oidc_present=$((oidc_present + 1))
	done
	if ((oidc_present == 4)); then
		[[ -r $TKE_WEB_IDENTITY_TOKEN_FILE ]] || {
			tat_die "TKE web identity token is not readable"
			return 1
		}
		return 0
	fi
	if ((oidc_present != 0)); then
		tat_die "TKE OIDC authentication requires region, provider, role, and token file"
		return 1
	fi
	for name in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
		[[ -z ${!name:-} ]] || static_present=$((static_present + 1))
	done
	if ((static_present == 2)); then
		return 0
	fi
	if ((static_present != 0)); then
		tat_die "static Tencent authentication requires both secret ID and secret key"
		return 1
	fi
	tat_die "Tencent authentication is not configured"
	return 1
}

tat_exchange_tke_oidc() {
	local endpoint=$1 credential_json
	[[ $endpoint == sts.internal.tencentcloudapi.com ]] || {
		tat_die "unsupported TKE OIDC endpoint"
		return 1
	}
	tat_require_command python3 || return
	credential_json=$(python3 - "$endpoint" <<'PY'
import json
import os
import sys
import time

from tencentcloud.common.credential import OIDCRoleArnCredential

with open(os.environ["TKE_WEB_IDENTITY_TOKEN_FILE"]) as token_file:
    web_identity_token = token_file.read()

credential = OIDCRoleArnCredential(
    os.environ["TKE_REGION"],
    os.environ["TKE_PROVIDER_ID"],
    web_identity_token,
    os.environ["TKE_ROLE_ARN"],
    "actor-release-hook-{}".format(int(time.time())),
    3600,
    endpoint=sys.argv[1],
)
secret_id, secret_key, token = credential.get_credential_info()
print(json.dumps({"secretId": secret_id, "secretKey": secret_key, "token": token}))
PY
	) || return
	TENCENTCLOUD_SECRET_ID=$(printf '%s' "$credential_json" | jq -er '.secretId') || return
	TENCENTCLOUD_SECRET_KEY=$(printf '%s' "$credential_json" | jq -er '.secretKey') || return
	TENCENTCLOUD_TOKEN=$(printf '%s' "$credential_json" | jq -er '.token') || return
	export TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TENCENTCLOUD_TOKEN
	# TCCLI prefers its TKE OIDC provider over temporary environment
	# credentials. Remove the consumed inputs so it cannot perform a second,
	# default-endpoint exchange when the actual product command starts.
	unset TKE_REGION TKE_PROVIDER_ID TKE_ROLE_ARN TKE_WEB_IDENTITY_TOKEN_FILE
	credential_json=
}

tat_initialize() {
	tat_require_command tccli || return
	tat_require_command jq || return
	tat_require_command base64 || return
	tat_require_environment TAT_INSTANCE_ID || return
	tat_require_authentication || return
	if [[ -n ${TENCENT_API_ROOT_DOMAIN:-} ]]; then
		[[ $TENCENT_API_ROOT_DOMAIN == internal.tencentcloudapi.com ]] || {
			tat_die "unsupported Tencent API root domain"
			return 1
		}
		# set-root-domain covers product APIs, but the Python SDK's default TKE
		# OIDC provider has its own public STS endpoint. Exchange the projected
		# token explicitly before tccli resolves its default credential chain.
		if [[ -n ${TKE_WEB_IDENTITY_TOKEN_FILE:-} && -z ${TENCENT_PROFILE:-} ]]; then
			tat_exchange_tke_oidc "sts.$TENCENT_API_ROOT_DOMAIN" || return
		fi
		tccli configure set-root-domain "$TENCENT_API_ROOT_DOMAIN" >/dev/null || return
	fi
	TENCENT_REGION=${TENCENT_REGION:-ap-beijing}
	TAT_API_RETRIES=${TAT_API_RETRIES:-10}
	TAT_API_RETRY_SECONDS=${TAT_API_RETRY_SECONDS:-2}
	TAT_POLL_SECONDS=${TAT_POLL_SECONDS:-5}
	TAT_MAX_CONTENT_BYTES=${TAT_MAX_CONTENT_BYTES:-60000}
}

tat_tccli() {
	local attempt
	for ((attempt = 1; attempt <= TAT_API_RETRIES; attempt++)); do
		if [[ -n ${TENCENT_PROFILE:-} ]]; then
			if tccli "$@" --profile "$TENCENT_PROFILE"; then
				return 0
			fi
		elif tccli "$@"; then
			return 0
		fi
		if ((attempt < TAT_API_RETRIES)); then
			echo "tat: tccli attempt $attempt failed; retrying" >&2
			sleep "$TAT_API_RETRY_SECONDS"
		fi
	done
	return 1
}

tat_start() {
	local command_name=$1
	local timeout_seconds=$2
	local payload=$3
	local content instance_ids response
	content=$(printf '%s' "$payload" | base64 | tr -d '\n')
	if ((${#content} > TAT_MAX_CONTENT_BYTES)); then
		tat_die "encoded command is ${#content} bytes; use tat-upload.sh for large payloads"
		return 1
	fi
	instance_ids=$(jq -cn --arg id "$TAT_INSTANCE_ID" '[$id]')
	response=$(tat_tccli tat RunCommand \
		--region "$TENCENT_REGION" \
		--InstanceIds "$instance_ids" \
		--CommandName "$command_name" \
		--Content "$content" \
		--SaveCommand False \
		--Timeout "$timeout_seconds") || return
	printf '%s' "$response" | jq -er '.InvocationId'
}

tat_start_command() {
	local command_id=$1
	local instance_ids response
	[[ $command_id =~ ^cmd-[a-z0-9]{8}$ ]] || {
		tat_die "invalid TAT command identity"
		return 1
	}
	instance_ids=$(jq -cn --arg id "$TAT_INSTANCE_ID" '[$id]')
	response=$(tat_tccli tat InvokeCommand \
		--region "$TENCENT_REGION" \
		--CommandId "$command_id" \
		--InstanceIds "$instance_ids") || return
	printf '%s' "$response" | jq -er '.InvocationId'
}

tat_wait() {
	local invocation_id=$1
	local filters response task_status output exit_code
	filters=$(jq -cn --arg id "$invocation_id" '[{Name:"invocation-id",Values:[$id]}]')
	while true; do
		response=$(tat_tccli tat DescribeInvocationTasks \
			--region "$TENCENT_REGION" \
			--Filters "$filters" \
			--HideOutput False) || return
		task_status=$(printf '%s' "$response" | jq -r '.InvocationTaskSet[0].TaskStatus // empty')
		case "$task_status" in
		# Delivery and cancellation are intermediate states, not evidence that
		# the remote command has stopped. Keep observing this invocation.
		PENDING | DELIVERING | DELIVER_DELAYED | RUNNING | CANCELLING | "")
			sleep "$TAT_POLL_SECONDS"
			continue
			;;
		esac

		output=$(printf '%s' "$response" | jq -r '.InvocationTaskSet[0].TaskResult.Output // empty')
		if [[ -n $output ]]; then
			printf '%s' "$output" | base64 --decode
		fi
		exit_code=$(printf '%s' "$response" | jq -r '.InvocationTaskSet[0].TaskResult.ExitCode // 1')
		echo "tat: invocation=$invocation_id status=$task_status exit=$exit_code" >&2
		if [[ $task_status == SUCCESS && $exit_code == 0 ]]; then
			return 0
		fi
		return 1
	done
}

tat_run_and_wait() {
	local command_name=$1
	local timeout_seconds=$2
	local payload=$3
	local invocation_id
	invocation_id=$(tat_start "$command_name" "$timeout_seconds" "$payload") || return
	echo "tat: invocation=$invocation_id" >&2
	tat_wait "$invocation_id"
}
