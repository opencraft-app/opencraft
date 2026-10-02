#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/q01-release-command-test.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
install -d "$temporary/bin" "$temporary/state" "$temporary/out"
printf '0' >"$temporary/state/sequence"
cat >"$temporary/bin/tccli" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
state=${MOCK_COMMAND_STATE:?}
service=$1
action=$2
shift 2
case "$service:$action" in
tat:CreateCommand)
	content=
	command_name=
	tags=
	while (($#)); do
		case "$1" in
		--Content) content=$2; shift 2 ;;
		--CommandName) command_name=$2; shift 2 ;;
		--Tags) tags=$2; shift 2 ;;
		--EnableParameter) [[ $2 == False ]]; shift 2 ;;
		*) shift ;;
		esac
	done
	sequence=$(($(<"$state/sequence") + 1))
	printf '%s' "$sequence" >"$state/sequence"
	command_id=$(printf 'cmd-%08d' "$sequence")
	printf '%s' "$content" >"$state/$command_id.content"
	printf '%s' "$command_name" >"$state/$command_id.name"
	if [[ ${MOCK_DROP_CREATE_TAGS_AT:-} == "$sequence" ]]; then tags='[]'; fi
	printf '%s' "$tags" >"$state/$command_id.tags"
	printf '%s' "${MOCK_DESCRIBE_LAG:-0}" >"$state/$command_id.lag"
	jq -cn --arg id "$command_id" '{CommandId:$id}'
	;;
tat:DescribeCommands)
	ids=
	filters=
	while (($#)); do
		case "$1" in
		--CommandIds) ids=$2; shift 2 ;;
		--Filters) filters=$2; shift 2 ;;
		*) shift ;;
		esac
	done
	if [[ -n $ids ]]; then
		command_id=$(printf '%s' "$ids" | jq -er '.[0]')
		lag=$(<"$state/$command_id.lag")
		if ((lag > 0)); then
			printf '%s' "$((lag - 1))" >"$state/$command_id.lag"
			jq -cn '{TotalCount:0,CommandSet:[]}'
			exit 0
		fi
	else
		command_name=$(printf '%s' "$filters" | jq -er '.[0].Values[0]')
		command_id=
		for name_file in "$state"/cmd-*.name; do
			[[ -e $name_file && $(<"$name_file") == "$command_name" ]] || continue
			command_id=$(basename "$name_file" .name)
		done
		if [[ -z $command_id ]]; then
			jq -cn '{TotalCount:0,CommandSet:[]}'
			exit 0
		fi
	fi
	content=$(<"$state/$command_id.content")
	command_name=$(<"$state/$command_id.name")
	tags=$(<"$state/$command_id.tags")
	jq -cn --arg id "$command_id" --arg name "$command_name" --arg content "$content" --argjson tags "$tags" \
		'{TotalCount:1,CommandSet:[{CommandId:$id,CommandName:$name,Content:$content,EnableParameter:false,Tags:$tags}]}'
	;;
tag:TagResources)
	resources=
	tags=
	while (($#)); do
		case "$1" in
		--ResourceList) resources=$2; shift 2 ;;
		--Tags) tags=$2; shift 2 ;;
		*) shift ;;
		esac
	done
	resource=$(printf '%s' "$resources" | jq -er '.[0]')
	command_id=${resource##*/}
	[[ -f $state/$command_id.content ]]
	printf '%s' "$tags" | jq -c '[.[] | {Key:.TagKey,Value:.TagValue}]' >"$state/$command_id.tags"
	printf '1' >>"$state/tag-repairs"
	jq -cn '{FailedResources:[],RequestId:"00000000-0000-0000-0000-000000000000"}'
	;;
*) exit 2 ;;
esac
MOCK
chmod 0755 "$temporary/bin/tccli"

export MOCK_COMMAND_STATE="$temporary/state"
export TCCLI="$temporary/bin/tccli"
export TENCENTCLOUD_SECRET_ID=mock-id
export TENCENTCLOUD_SECRET_KEY=mock-key
export MOCK_DESCRIBE_LAG=2
export TAT_CREATE_VISIBILITY_DELAY_SECONDS=0
export ACTOR_IMAGE_INVENTORY=$temporary/inventory.lock.json
export RIVET_COLD_BUCKET=actor-depot-cold-prod-bj-q01-nv1-1234567890
export ACTOR_RELEASE_TEST_MODE=1
printf '{}\n' >"$ACTOR_IMAGE_INVENTORY"
runtime=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:$(printf '1%.0s' {1..64})
previous=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:$(printf '2%.0s' {1..64})
reporter=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:$(printf '3%.0s' {1..64})
previous_reporter=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:$(printf '4%.0s' {1..64})
output="$temporary/out/commands.json"
export QUALIFICATION_CANDIDATE_RECEIPT=$temporary/actor-bj-q01-semantic-failure-candidate-test.json
printf '{"verdict":"passed"}\n' >"$QUALIFICATION_CANDIDATE_RECEIPT"
"$script_dir/publish-release-commands.sh" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" "$(printf 'c%.0s' {1..32})" \
	"$runtime" "$(printf 'd%.0s' {1..40})" "$(printf 'e%.0s' {1..64})" "$reporter" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" \
	"$previous" "$(printf 'f%.0s' {1..40})" "$(printf '0%.0s' {1..64})" "$previous_reporter" \
	"$(printf 'c%.0s' {1..40})" "$(printf 'd%.0s' {1..64})" "$output" >/dev/null
jq -e '.schema == "actor-approved-release-commands/v2" and .verdict == "passed" and .parameterized == false and .upgrade.commandID == "cmd-00000001" and .rollback.commandID == "cmd-00000002" and .candidate.runtime.sourceRevision == ("d" * 40) and .previous.runtime.sourceRevision == ("f" * 40) and (.imageInventorySHA256 | test("^[0-9a-f]{64}$")) and .qualificationCandidate.path == $path and (.qualificationCandidate.sha256 | test("^[0-9a-f]{64}$"))' --arg path "$QUALIFICATION_CANDIDATE_RECEIPT" "$output" >/dev/null
base64 --decode <"$temporary/state/cmd-00000001.content" | grep -Fq 'run-user-transparent-upgrade-on-builder.sh'
base64 --decode <"$temporary/state/cmd-00000001.content" | grep -Fq \
	"export ACTOR_QUALIFICATION_CANDIDATE_RECEIPT=$QUALIFICATION_CANDIDATE_RECEIPT"
base64 --decode <"$temporary/state/cmd-00000001.content" | grep -Fq \
	"export ACTOR_IMAGE_INVENTORY=$ACTOR_IMAGE_INVENTORY"
base64 --decode <"$temporary/state/cmd-00000001.content" | grep -Fq \
	"export RIVET_COLD_BUCKET=$RIVET_COLD_BUCKET"
base64 --decode <"$temporary/state/cmd-00000002.content" | grep -Fq "$(printf 'c%.0s' {1..40})"
if base64 --decode <"$temporary/state/cmd-00000001.content" | grep -Fq '{{'; then
	echo "approved command unexpectedly contains TAT text parameters" >&2
	exit 1
fi
second_output="$temporary/out/commands-retry.json"
"$script_dir/publish-release-commands.sh" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" "$(printf 'c%.0s' {1..32})" \
	"$runtime" "$(printf 'd%.0s' {1..40})" "$(printf 'e%.0s' {1..64})" "$reporter" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" \
	"$previous" "$(printf 'f%.0s' {1..40})" "$(printf '0%.0s' {1..64})" "$previous_reporter" \
	"$(printf 'c%.0s' {1..40})" "$(printf 'd%.0s' {1..64})" "$second_output" >/dev/null
[[ $(<"$temporary/state/sequence") == 2 ]]
jq -e '.upgrade.commandID == "cmd-00000001" and .rollback.commandID == "cmd-00000002"' "$second_output" >/dev/null

# Tencent can expose an exactly created command before its CreateCommand tags
# are visible. Only that returned command ID may be repaired, and only after
# its complete non-parameterized content has been matched.
install -d "$temporary/tag-repair-state"
printf '0' >"$temporary/tag-repair-state/sequence"
export MOCK_COMMAND_STATE="$temporary/tag-repair-state"
export MOCK_DESCRIBE_LAG=0
export MOCK_DROP_CREATE_TAGS_AT=2
unset TAT_CREATE_VISIBILITY_ATTEMPTS
tag_repair_output="$temporary/out/commands-tag-repair.json"
"$script_dir/publish-release-commands.sh" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" "$(printf '8%.0s' {1..32})" \
	"$runtime" "$(printf 'd%.0s' {1..40})" "$(printf 'e%.0s' {1..64})" "$reporter" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" \
	"$previous" "$(printf 'f%.0s' {1..40})" "$(printf '0%.0s' {1..64})" "$previous_reporter" \
	"$(printf 'c%.0s' {1..40})" "$(printf 'd%.0s' {1..64})" "$tag_repair_output" >/dev/null
[[ $(<"$temporary/tag-repair-state/tag-repairs") == 1 ]]
jq -e '.verdict == "passed" and .rollback.commandID == "cmd-00000002"' "$tag_repair_output" >/dev/null

# A later name lookup with missing tags is not eligible for repair. Only the
# exact ID returned by the current CreateCommand call receives that authority.
printf '[]' >"$temporary/tag-repair-state/cmd-00000001.tags"
tag_repair_retry_output="$temporary/out/commands-tag-repair-retry.json"
set +e
"$script_dir/publish-release-commands.sh" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" "$(printf '8%.0s' {1..32})" \
	"$runtime" "$(printf 'd%.0s' {1..40})" "$(printf 'e%.0s' {1..64})" "$reporter" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" \
	"$previous" "$(printf 'f%.0s' {1..40})" "$(printf '0%.0s' {1..64})" "$previous_reporter" \
	"$(printf 'c%.0s' {1..40})" "$(printf 'd%.0s' {1..64})" "$tag_repair_retry_output" >/dev/null 2>&1
tag_repair_retry_status=$?
set -e
((tag_repair_retry_status != 0))
[[ $(<"$temporary/tag-repair-state/tag-repairs") == 1 ]]
[[ ! -e $tag_repair_retry_output ]]
unset MOCK_DROP_CREATE_TAGS_AT

# Exhausting the visibility window fails closed without creating a duplicate.
install -d "$temporary/failure-state"
printf '0' >"$temporary/failure-state/sequence"
export MOCK_COMMAND_STATE="$temporary/failure-state"
export MOCK_DESCRIBE_LAG=3
export TAT_CREATE_VISIBILITY_ATTEMPTS=2
failure_output="$temporary/out/commands-invisible.json"
set +e
"$script_dir/publish-release-commands.sh" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" "$(printf '9%.0s' {1..32})" \
	"$runtime" "$(printf 'd%.0s' {1..40})" "$(printf 'e%.0s' {1..64})" "$reporter" \
	"$(printf 'a%.0s' {1..40})" "$(printf 'b%.0s' {1..64})" \
	"$previous" "$(printf 'f%.0s' {1..40})" "$(printf '0%.0s' {1..64})" "$previous_reporter" \
	"$(printf 'c%.0s' {1..40})" "$(printf 'd%.0s' {1..64})" "$failure_output" >/dev/null 2>&1
failure_status=$?
set -e
((failure_status != 0))
[[ $(<"$temporary/failure-state/sequence") == 1 ]]
[[ ! -e $failure_output ]]
echo "approved release command publisher tests passed"
