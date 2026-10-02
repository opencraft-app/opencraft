#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: publish-release-commands.sh CONTROL_REVISION CONTROL_MANIFEST_SHA256 RUN_ID \
  CANDIDATE_IMAGE CANDIDATE_REVISION CANDIDATE_MANIFEST_SHA256 CANDIDATE_REPORTER_IMAGE \
  CANDIDATE_REPORTER_REVISION CANDIDATE_REPORTER_MANIFEST_SHA256 \
  PREVIOUS_IMAGE PREVIOUS_REVISION PREVIOUS_MANIFEST_SHA256 PREVIOUS_REPORTER_IMAGE \
  PREVIOUS_REPORTER_REVISION PREVIOUS_REPORTER_MANIFEST_SHA256 OUTPUT_JSON
EOF
}
[[ $# -eq 16 ]] || { usage; exit 2; }
control_revision=$1
control_manifest=$2
run_id=$3
candidate_image=$4
candidate_revision=$5
candidate_manifest=$6
reporter_image=$7
reporter_revision=$8
reporter_manifest=$9
previous_image=${10}
previous_revision=${11}
previous_manifest=${12}
previous_reporter=${13}
previous_reporter_revision=${14}
previous_reporter_manifest=${15}
output=${16}
qualification_candidate_receipt=${QUALIFICATION_CANDIDATE_RECEIPT:-}
create_visibility_attempts=${TAT_CREATE_VISIBILITY_ATTEMPTS:-8}
create_visibility_delay=${TAT_CREATE_VISIBILITY_DELAY_SECONDS:-1}
account_uin=${TENCENT_ACCOUNT_UIN:-100045199955}
image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the staged builder image inventory}
cold_bucket=${RIVET_COLD_BUCKET:?RIVET_COLD_BUCKET must name the exact q01 cold bucket}
[[ $image_inventory == /* && -f $image_inventory && ! -L $image_inventory ]] || {
	echo "ACTOR_IMAGE_INVENTORY must be an absolute, non-symlink staged inventory" >&2
	exit 2
}
[[ $cold_bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || {
	echo "RIVET_COLD_BUCKET is invalid" >&2
	exit 2
}

tccli=${TCCLI:-tccli}
region=${TENCENT_REGION:-ap-beijing}
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected artifact-publisher environment" >&2; exit 2; }
done
for revision in "$control_revision" "$candidate_revision" "$reporter_revision" "$previous_revision" "$previous_reporter_revision"; do
	[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo "invalid source revision" >&2; exit 2; }
done
for manifest in "$control_manifest" "$candidate_manifest" "$reporter_manifest" "$previous_manifest" "$previous_reporter_manifest"; do
	[[ $manifest =~ ^[0-9a-f]{64}$ ]] || { echo "invalid source manifest" >&2; exit 2; }
done
[[ $candidate_image =~ ^([A-Za-z0-9][A-Za-z0-9._:-]*(/[A-Za-z0-9._-]+)+)/rivet-runtime@sha256:[0-9a-f]{64}$ ]] || {
    echo "invalid candidate runtime image" >&2
    exit 2
}
registry=${BASH_REMATCH[1]}
for image in "$candidate_image" "$previous_image"; do
    digest=${image#"$registry/rivet-runtime@sha256:"}
    [[ $image == "$registry/rivet-runtime@sha256:$digest" && $digest =~ ^[0-9a-f]{64}$ ]] || {
        echo "invalid runtime image" >&2
        exit 2
    }
done
for image in "$reporter_image" "$previous_reporter"; do
    digest=${image#"$registry/actor-fleet-controller@sha256:"}
    [[ $image == "$registry/actor-fleet-controller@sha256:$digest" && $digest =~ ^[0-9a-f]{64}$ ]] || {
        echo "invalid reporter image" >&2
        exit 2
    }
done
[[ $run_id =~ ^[0-9a-f]{32}$ ]] || { echo "invalid deterministic release run ID" >&2; exit 2; }
if [[ -n $qualification_candidate_receipt ]]; then
	qualification_path_ok=false
	[[ $qualification_candidate_receipt == /data/actor-qualification/receipts/actor-bj-q01-semantic-failure-candidate-*.json ]] && qualification_path_ok=true
	if [[ ${ACTOR_RELEASE_TEST_MODE:-0} == 1 && $qualification_candidate_receipt == /data/tmp/q01-release-command-test.*/actor-bj-q01-semantic-failure-candidate-*.json ]]; then
		qualification_path_ok=true
	fi
	[[ $qualification_path_ok == true ]] || {
		echo "QUALIFICATION_CANDIDATE_RECEIPT is invalid" >&2
		exit 2
	}
	[[ -f $qualification_candidate_receipt && ! -L $qualification_candidate_receipt ]] || {
		echo "QUALIFICATION_CANDIDATE_RECEIPT must be an exact regular file" >&2
		exit 2
	}
fi
[[ $output =~ ^/data/[A-Za-z0-9._/-]+\.json$ && $output != *'/../'* && $output != */.. && ! -e $output && -d $(dirname -- "$output") ]] || {
	echo "OUTPUT_JSON must be a new absolute JSON path below /data" >&2
	exit 2
}
command -v "$tccli" >/dev/null
command -v jq >/dev/null
[[ $create_visibility_attempts =~ ^[1-9][0-9]*$ ]]
[[ $create_visibility_delay =~ ^[0-9]+([.][0-9]+)?$ ]]
[[ $account_uin =~ ^[1-9][0-9]*$ ]] || { echo "TENCENT_ACCOUNT_UIN must be numeric" >&2; exit 2; }

control_source=/var/lib/actor-build/deploy/q01-src-${control_revision}-${control_manifest}
builder_entry=$control_source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/run-user-transparent-upgrade-on-builder.sh
failed_receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.json
printf -v q_control '%q' "$control_source"
printf -v q_entry '%q' "$builder_entry"
printf -v q_candidate_image '%q' "$candidate_image"
printf -v q_candidate_revision '%q' "$candidate_revision"
printf -v q_candidate_manifest '%q' "$candidate_manifest"
printf -v q_reporter '%q' "$reporter_image"
printf -v q_reporter_revision '%q' "$reporter_revision"
printf -v q_reporter_manifest '%q' "$reporter_manifest"
printf -v q_previous_image '%q' "$previous_image"
printf -v q_previous_revision '%q' "$previous_revision"
printf -v q_previous_manifest '%q' "$previous_manifest"
printf -v q_previous_reporter '%q' "$previous_reporter"
printf -v q_previous_reporter_revision '%q' "$previous_reporter_revision"
printf -v q_previous_reporter_manifest '%q' "$previous_reporter_manifest"
printf -v q_run_id '%q' "$run_id"
printf -v q_failed_receipt '%q' "$failed_receipt"
printf -v q_image_inventory '%q' "$image_inventory"
printf -v q_cold_bucket '%q' "$cold_bucket"
qualification_export=()
if [[ -n $qualification_candidate_receipt ]]; then
	printf -v q_qualification_candidate_receipt '%q' "$qualification_candidate_receipt"
	qualification_export=("export ACTOR_QUALIFICATION_CANDIDATE_RECEIPT=$q_qualification_candidate_receipt")
fi

upgrade_content=$(printf '%s\n' \
	'#!/usr/bin/env bash' \
	'set -euo pipefail' \
	"export ACTOR_CONTROL_SOURCE=$q_control" \
	"export ACTOR_IMAGE_INVENTORY=$q_image_inventory" \
	"export RIVET_COLD_BUCKET=$q_cold_bucket" \
	"${qualification_export[@]}" \
	"test -x $q_entry" \
	"exec $q_entry $q_candidate_image $q_candidate_revision $q_candidate_manifest $q_reporter $q_reporter_revision $q_reporter_manifest $q_run_id")
rollback_content=$(printf '%s\n' \
	'#!/usr/bin/env bash' \
	'set -euo pipefail' \
	"export ACTOR_CONTROL_SOURCE=$q_control" \
	"export ACTOR_IMAGE_INVENTORY=$q_image_inventory" \
	"export RIVET_COLD_BUCKET=$q_cold_bucket" \
	"test -x $q_entry" \
	"exec $q_entry $q_previous_image $q_previous_revision $q_previous_manifest $q_previous_reporter $q_previous_reporter_revision $q_previous_reporter_manifest $q_run_id $q_failed_receipt")

tags=$(jq -cn --arg run "$run_id" '[
  {Key:"actor-release-approved",Value:"true"},
  {Key:"actor-release-run",Value:$run},
  {Key:"actor-release-cell",Value:"actor-bj-q01"}
]')
verify_command_response() {
	local response=$1 expected_name=$2 expected_content=$3 actual_content
	[[ $(printf '%s' "$response" | jq -er '.TotalCount') == 1 ]]
	[[ $(printf '%s' "$response" | jq -er '.CommandSet[0].CommandName') == "$expected_name" ]]
	[[ $(printf '%s' "$response" | jq -er '.CommandSet[0].EnableParameter') == false ]]
	actual_content=$(printf '%s' "$response" | jq -er '.CommandSet[0].Content' | base64 --decode)
	[[ $actual_content == "$expected_content" ]]
	printf '%s' "$response" | jq -e --arg run "$run_id" '
      .CommandSet[0].Tags as $tags |
      any($tags[]; .Key == "actor-release-approved" and .Value == "true") and
      any($tags[]; .Key == "actor-release-run" and .Value == $run) and
      any($tags[]; .Key == "actor-release-cell" and .Value == "actor-bj-q01")
    ' >/dev/null
}

verify_command_shape_response() {
	local response=$1 expected_name=$2 expected_content=$3 actual_content
	[[ $(printf '%s' "$response" | jq -er '.TotalCount') == 1 ]]
	[[ $(printf '%s' "$response" | jq -er '.CommandSet[0].CommandName') == "$expected_name" ]]
	[[ $(printf '%s' "$response" | jq -er '.CommandSet[0].EnableParameter') == false ]]
	actual_content=$(printf '%s' "$response" | jq -er '.CommandSet[0].Content' | base64 --decode)
	[[ $actual_content == "$expected_content" ]]
}

repair_created_command_tags() {
	local command_id=$1 resource response resource_list resource_tags
	resource="qcs::tat:${region}:uin/${account_uin}:command/${command_id}"
	resource_list=$(jq -cn --arg resource "$resource" '[$resource]')
	resource_tags=$(printf '%s' "$tags" | jq -c '[.[] | {TagKey:.Key,TagValue:.Value}]')
	response=$("$tccli" tag TagResources --region "$region" \
		--ResourceList "$resource_list" --Tags "$resource_tags")
	[[ $(printf '%s' "$response" | jq -er '.FailedResources | length') == 0 ]]
}

verify_command() {
	local command_id=$1 expected_name=$2 expected_content=$3 ids response
	ids=$(jq -cn --arg id "$command_id" '[$id]')
	response=$("$tccli" tat DescribeCommands --region "$region" --CommandIds "$ids")
	verify_command_response "$response" "$expected_name" "$expected_content"
}

verify_created_command() {
	local command_id=$1 expected_name=$2 expected_content=$3 attempt ids response repaired=0 total
	ids=$(jq -cn --arg id "$command_id" '[$id]')
	for attempt in $(seq 1 "$create_visibility_attempts"); do
		response=$("$tccli" tat DescribeCommands --region "$region" --CommandIds "$ids")
		total=$(printf '%s' "$response" | jq -er '.TotalCount')
		if [[ $total == 1 ]]; then
			verify_command_shape_response "$response" "$expected_name" "$expected_content" || {
				echo "created TAT command shape does not match its request: $command_id" >&2
				return 1
			}
			if verify_command_response "$response" "$expected_name" "$expected_content"; then
				return 0
			fi
			if ((repaired == 0)); then
				repair_created_command_tags "$command_id"
				repaired=1
			fi
		elif [[ $total != 0 ]]; then
			echo "created TAT command lookup is not unique: $command_id" >&2
			return 1
		fi
		if ((attempt < create_visibility_attempts)); then
			sleep "$create_visibility_delay"
		fi
	done
	if verify_command "$command_id" "$expected_name" "$expected_content" >/dev/null 2>&1; then
			return 0
	fi
	echo "created TAT command did not become exactly readable after ${create_visibility_attempts} attempts: $command_id" >&2
	return 1
}

find_existing_command() {
	local name=$1 expected_content=$2 filters response total
	filters=$(jq -cn --arg name "$name" '[{Name:"command-name",Values:[$name]}]')
	response=$("$tccli" tat DescribeCommands --region "$region" --Filters "$filters")
	total=$(printf '%s' "$response" | jq -er '.TotalCount')
	[[ $total == 0 ]] && return 1
	[[ $total == 1 ]] || { echo "approved command name is not unique: $name" >&2; return 2; }
	verify_command_response "$response" "$name" "$expected_content" || {
		echo "existing approved command content or tags do not match: $name" >&2
		return 2
	}
	printf '%s' "$response" | jq -er '.CommandSet[0].CommandId | select(test("^cmd-[a-z0-9]{8}$"))'
}

create_command() {
	local phase=$1 content=$2 name encoded response command_id lookup_status
	name="actor-q01-${phase}-${run_id:0:12}"
	set +e
	command_id=$(find_existing_command "$name" "$content")
	lookup_status=$?
	set -e
	if ((lookup_status == 0)); then
		printf '%s' "$command_id"
		return 0
	fi
	((lookup_status == 1)) || return "$lookup_status"
	encoded=$(printf '%s' "$content" | base64 | tr -d '\n')
	response=$("$tccli" tat CreateCommand --region "$region" \
		--CommandName "$name" \
		--Description "Immutable approved q01 ${phase} transaction ${run_id}" \
		--CommandType SHELL --Username root --WorkingDirectory /data \
		--Timeout 7200 --EnableParameter False --Content "$encoded" --Tags "$tags")
	command_id=$(printf '%s' "$response" | jq -er '.CommandId | select(test("^cmd-[a-z0-9]{8}$"))')
	# Tencent TAT can briefly return an empty DescribeCommands result immediately
	# after CreateCommand. Retry only this read-after-create observation; an
	# observed mismatch still fails closed on every attempt and no second command
	# is ever created.
	verify_created_command "$command_id" "$name" "$content"
	printf '%s' "$command_id"
}

upgrade_id=$(create_command upgrade "$upgrade_content")
rollback_id=$(create_command rollback "$rollback_content")

verify_command "$upgrade_id" "actor-q01-upgrade-${run_id:0:12}" "$upgrade_content"
verify_command "$rollback_id" "actor-q01-rollback-${run_id:0:12}" "$rollback_content"

upgrade_sha=$(printf '%s' "$upgrade_content" | sha256sum | cut -d' ' -f1)
rollback_sha=$(printf '%s' "$rollback_content" | sha256sum | cut -d' ' -f1)
image_inventory_sha=$(sha256sum "$image_inventory" | cut -d' ' -f1)
qualification_candidate_sha=
if [[ -n $qualification_candidate_receipt ]]; then
	qualification_candidate_sha=$(sha256sum "$qualification_candidate_receipt" | cut -d' ' -f1)
fi
temporary=$(mktemp "$(dirname -- "$output")/.approved-release-commands.XXXXXX")
chmod 0600 "$temporary"
jq -n \
	--arg run "$run_id" --arg controlRevision "$control_revision" \
	--arg controlManifestSHA256 "$control_manifest" \
	--arg upgradeID "$upgrade_id" --arg upgradeSHA256 "$upgrade_sha" \
	--arg rollbackID "$rollback_id" --arg rollbackSHA256 "$rollback_sha" \
	--arg candidateImage "$candidate_image" --arg previousImage "$previous_image" \
	--arg candidateReporterImage "$reporter_image" \
	--arg candidateReporterRevision "$reporter_revision" \
	--arg candidateReporterManifestSHA256 "$reporter_manifest" \
	--arg candidateRuntimeRevision "$candidate_revision" \
	--arg candidateRuntimeManifestSHA256 "$candidate_manifest" \
	--arg previousReporterImage "$previous_reporter" \
	--arg previousReporterRevision "$previous_reporter_revision" \
	--arg previousReporterManifestSHA256 "$previous_reporter_manifest" \
	--arg previousRuntimeRevision "$previous_revision" \
	--arg previousRuntimeManifestSHA256 "$previous_manifest" \
	--arg imageInventorySHA256 "$image_inventory_sha" \
	--arg coldBucket "$cold_bucket" \
	--arg qualificationCandidatePath "$qualification_candidate_receipt" \
	--arg qualificationCandidateSHA256 "$qualification_candidate_sha" \
	'{schema:"actor-approved-release-commands/v2",cell:"actor-bj-q01",runID:$run,
      control:{sourceRevision:$controlRevision,sourceManifestSHA256:$controlManifestSHA256},
      upgrade:{commandID:$upgradeID,contentSHA256:$upgradeSHA256},
      rollback:{commandID:$rollbackID,contentSHA256:$rollbackSHA256},
      candidate:{
        runtime:{image:$candidateImage,sourceRevision:$candidateRuntimeRevision,sourceManifestSHA256:$candidateRuntimeManifestSHA256},
        reporter:{image:$candidateReporterImage,sourceRevision:$candidateReporterRevision,sourceManifestSHA256:$candidateReporterManifestSHA256}
      },
      previous:{
        runtime:{image:$previousImage,sourceRevision:$previousRuntimeRevision,sourceManifestSHA256:$previousRuntimeManifestSHA256},
        reporter:{image:$previousReporterImage,sourceRevision:$previousReporterRevision,sourceManifestSHA256:$previousReporterManifestSHA256}
      },
      imageInventorySHA256:$imageInventorySHA256,coldBucket:$coldBucket,
      qualificationCandidate:(if $qualificationCandidatePath == "" then null else
        {path:$qualificationCandidatePath,sha256:$qualificationCandidateSHA256} end),
      approvalTag:"actor-release-approved=true",parameterized:false,verdict:"passed"}' \
	>"$temporary"
mv "$temporary" "$output"
printf 'approved_release_commands=%s run_id=%s upgrade_command=%s rollback_command=%s\n' \
	"$output" "$run_id" "$upgrade_id" "$rollback_id"
