#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT

install -d "$temporary/bin" "$temporary/state" "$temporary/remote" "$temporary/local"
cat >"$temporary/bin/tccli" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

state=${MOCK_TAT_STATE:?}
service=${1:-}
action=${2:-}
shift 2
case "$service/$action" in
configure/set-root-domain)
	[[ ${1:-} == internal.tencentcloudapi.com ]]
	;;
tat/RunCommand)
	content=
	while (($#)); do
		case "$1" in
		--Content)
			content=$2
			shift 2
			;;
		*) shift ;;
		esac
	done
	[[ -n $content ]]
	sequence=$(($(<"$state/sequence") + 1))
	printf '%s' "$sequence" >"$state/sequence"
	invocation="inv-mock-$sequence"
	set +e
	output=$(printf '%s' "$content" | base64 --decode | bash 2>&1)
	exit_code=$?
	set -e
	printf '%s' "$output" | base64 | tr -d '\n' >"$state/$invocation.output"
	printf '%s' "$exit_code" >"$state/$invocation.exit"
	printf '0' >"$state/$invocation.polls"
	printf '%s' "$invocation" >"$state/latest"
	jq -cn --arg id "$invocation" '{InvocationId:$id}'
	;;
tat/InvokeCommand)
	command_id=
	while (($#)); do
		case "$1" in
		--CommandId)
			command_id=$2
			shift 2
			;;
		*) shift ;;
		esac
	done
	[[ $command_id == cmd-appr0ved ]]
	sequence=$(($(<"$state/sequence") + 1))
	printf '%s' "$sequence" >"$state/sequence"
	invocation="inv-mock-$sequence"
	printf '%s' "$(printf approved-command-ok | base64 | tr -d '\n')" >"$state/$invocation.output"
	printf '0' >"$state/$invocation.exit"
	printf '0' >"$state/$invocation.polls"
	printf '%s' "$invocation" >"$state/latest"
	jq -cn --arg id "$invocation" '{InvocationId:$id}'
	;;
tat/DescribeInvocationTasks)
	invocation=$(<"$state/latest")
	polls=$(($(<"$state/$invocation.polls") + 1))
	printf '%s' "$polls" >"$state/$invocation.polls"
	read -r -a intermediate_states <<<"${MOCK_TAT_INTERMEDIATE_STATES:-PENDING DELIVERING DELIVER_DELAYED RUNNING}"
	if ((polls <= ${#intermediate_states[@]})); then
		jq -cn --arg status "${intermediate_states[polls-1]}" \
			'{InvocationTaskSet:[{TaskStatus:$status,TaskResult:{Output:"",ExitCode:0}}]}'
	else
		output=$(<"$state/$invocation.output")
		exit_code=$(<"$state/$invocation.exit")
		jq -cn --arg output "$output" --argjson exit "$exit_code" \
			--arg terminal "${MOCK_TAT_TERMINAL_STATUS:-}" \
			'{InvocationTaskSet:[{TaskStatus:(if $terminal != "" then $terminal elif $exit == 0 then "SUCCESS" else "FAILED" end),TaskResult:{Output:$output,ExitCode:$exit}}]}'
	fi
	;;
*)
	echo "unexpected mock tccli call: $service $action" >&2
	exit 2
	;;
esac
MOCK
chmod 0755 "$temporary/bin/tccli"
printf '0' >"$temporary/state/sequence"

export MOCK_TAT_STATE="$temporary/state"
export PATH="$temporary/bin:$PATH"
export TAT_INSTANCE_ID=ins-mock
export TENCENT_PROFILE=mock
export TAT_POLL_SECONDS=0
export TAT_UPLOAD_CHUNK_CHARS=20
export TAT_DOWNLOAD_CHUNK_CHARS=20

env -u TENCENT_PROFILE -u TENCENTCLOUD_SECRET_ID -u TENCENTCLOUD_SECRET_KEY \
	-u TKE_REGION -u TKE_PROVIDER_ID -u TKE_ROLE_ARN -u TKE_WEB_IDENTITY_TOKEN_FILE \
	bash -c 'source "$1"; ! tat_initialize >/dev/null 2>&1' _ "$script_dir/lib-tat.sh"
env -u TENCENT_PROFILE -u TENCENTCLOUD_SECRET_ID -u TENCENTCLOUD_SECRET_KEY \
	TKE_REGION=ap-beijing \
	bash -c 'source "$1"; ! tat_initialize >/dev/null 2>&1' _ "$script_dir/lib-tat.sh"
token_file="$temporary/state/oidc-token"
printf 'mock-token' >"$token_file"
env -u TENCENT_PROFILE -u TENCENTCLOUD_SECRET_ID -u TENCENTCLOUD_SECRET_KEY \
	TKE_REGION=ap-beijing TKE_PROVIDER_ID=cls-mock \
	TKE_ROLE_ARN=qcs::cam::uin/100000000001:roleName/mock \
	TKE_WEB_IDENTITY_TOKEN_FILE="$token_file" \
	TENCENT_API_ROOT_DOMAIN=internal.tencentcloudapi.com \
	MOCK_OIDC_ENDPOINT_FILE="$temporary/state/oidc-endpoint" \
	bash -c '
		source "$1"
		tat_exchange_tke_oidc() {
			printf "%s" "$1" >"$MOCK_OIDC_ENDPOINT_FILE"
			export TENCENTCLOUD_SECRET_ID=temporary-id
			export TENCENTCLOUD_SECRET_KEY=temporary-key
			export TENCENTCLOUD_TOKEN=temporary-token
			unset TKE_REGION TKE_PROVIDER_ID TKE_ROLE_ARN TKE_WEB_IDENTITY_TOKEN_FILE
		}
		tat_initialize
		test "$TENCENTCLOUD_SECRET_ID" = temporary-id
		test "$TENCENTCLOUD_SECRET_KEY" = temporary-key
		test "$TENCENTCLOUD_TOKEN" = temporary-token
		test -z "${TKE_REGION:-}${TKE_PROVIDER_ID:-}${TKE_ROLE_ARN:-}${TKE_WEB_IDENTITY_TOKEN_FILE:-}"
	' _ "$script_dir/lib-tat.sh"
[[ $(<"$temporary/state/oidc-endpoint") == sts.internal.tencentcloudapi.com ]]
env -u TENCENT_PROFILE -u TKE_REGION -u TKE_PROVIDER_ID -u TKE_ROLE_ARN \
	-u TKE_WEB_IDENTITY_TOKEN_FILE TENCENTCLOUD_SECRET_ID=mock-id \
	TENCENTCLOUD_SECRET_KEY=mock-key \
	bash -c 'source "$1"; tat_initialize' _ "$script_dir/lib-tat.sh"

run_output=$(printf '%s\n' 'printf actor-fleet-ok' | "$script_dir/tat-run.sh" --name test-run --timeout 10)
[[ $run_output == actor-fleet-ok ]]
invocation=$(<"$temporary/state/latest")
[[ $(<"$temporary/state/$invocation.polls") == 5 ]]

# Cancellation is not terminal until the agent confirms termination. A zero
# exit code in either response must not be mistaken for successful completion.
if printf '%s\n' 'printf cancelled-output' | \
	MOCK_TAT_INTERMEDIATE_STATES='RUNNING CANCELLING' MOCK_TAT_TERMINAL_STATUS=TERMINATED \
	"$script_dir/tat-run.sh" --name test-cancellation --timeout 10 >"$temporary/cancelled-output"; then
	echo "cancelled command unexpectedly passed" >&2
	exit 1
fi
invocation=$(<"$temporary/state/latest")
[[ $(<"$temporary/state/$invocation.polls") == 3 ]]
[[ $(<"$temporary/cancelled-output") == cancelled-output ]]

for terminal in DELIVER_FAILED START_FAILED FAILED TIMEOUT TASK_TIMEOUT CANCELLED UNKNOWN; do
	if printf '%s\n' 'printf terminal-output' | MOCK_TAT_TERMINAL_STATUS=$terminal \
		"$script_dir/tat-run.sh" --name test-terminal --timeout 10 >/dev/null 2>&1; then
		echo "non-success status unexpectedly passed: $terminal" >&2
		exit 1
	fi
done

invoke_output=$("$script_dir/tat-invoke.sh" cmd-appr0ved)
[[ $invoke_output == approved-command-ok ]]
if "$script_dir/tat-invoke.sh" 'cmd-invalid;touch-bad' >/dev/null 2>&1; then
	echo "invalid stored command identity was accepted" >&2
	exit 1
fi

detached_invocation=$(printf '%s\n' 'printf detached-ok' |
	"$script_dir/tat-run.sh" --detach --name test-detach --timeout 10)
[[ $detached_invocation =~ ^inv-mock-[0-9]+$ ]]
detached_output=$("$script_dir/tat-wait.sh" "$detached_invocation")
[[ $detached_output == detached-ok ]]

printf '%s\n' 'abcdefghijklmnopqrstuvwxyz' '0123456789' >"$temporary/local/source"
"$script_dir/tat-upload.sh" "$temporary/local/source" "$temporary/remote/uploaded"
cmp "$temporary/local/source" "$temporary/remote/uploaded"
[[ ! -e $temporary/remote/uploaded.tat-part.b64 ]]

"$script_dir/tat-download.sh" "$temporary/remote/uploaded" "$temporary/local/downloaded"
cmp "$temporary/local/source" "$temporary/local/downloaded"

: >"$temporary/local/empty"
"$script_dir/tat-upload.sh" "$temporary/local/empty" "$temporary/remote/empty"
"$script_dir/tat-download.sh" "$temporary/remote/empty" "$temporary/local/empty-copy"
[[ ! -s $temporary/local/empty-copy ]]

printf '%s\n' 'printf resumed-ok' | "$script_dir/tat-run.sh" --name test-resume --timeout 10 >/dev/null
invocation=$(<"$temporary/state/latest")
resume_output=$("$script_dir/tat-wait.sh" "$invocation")
[[ $resume_output == resumed-ok ]]

if "$script_dir/tat-upload.sh" "$temporary/local/source" "$temporary/remote/uploaded" >/dev/null 2>&1; then
	echo "upload unexpectedly overwrote an existing target" >&2
	exit 1
fi
if "$script_dir/tat-download.sh" "$temporary/remote/uploaded" "$temporary/local/downloaded" >/dev/null 2>&1; then
	echo "download unexpectedly overwrote an existing target" >&2
	exit 1
fi

echo "TAT helper tests passed"
