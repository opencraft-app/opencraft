#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
aws=${AWS_CLI:-aws}
region=ap-beijing
endpoint=https://cos.ap-beijing.myqcloud.com
state_dir=${QUALIFICATION_STATE_DIR:-/data/agents/cloud/tencent-beijing-qualification/state}
buckets=(
	actor-depot-cold-prod-bj-q01-nv1-1388575217
	actor-fdb-backup-prod-bj-q01-nv1-1388575217
	actor-worker-code-qual-bj-q01-nv1-1388575217
	actor-build-relay-qual-bj-q01-nv1-1388575217
	actor-qualification-evidence-prod-bj-q01-nv1-1388575217
)

for variable in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
	[[ -n ${!variable:-} ]] || {
		echo "$variable must be supplied through the protected environment" >&2
		exit 2
	}
done
mkdir -p "$state_dir"
chmod 0700 "$state_dir"
export AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE=$script_dir/aws-config

for bucket in "${buckets[@]}"; do
	[[ $bucket =~ ^actor-((depot-cold|fdb-backup|qualification-evidence)-prod|(worker-code|build-relay)-qual)-bj-q01-nv1-[0-9]+$ ]]
	intent=$state_dir/cos-intent-$bucket
	if [[ ! -e $intent ]]; then
		printf 'bucket=%s\nregion=%s\nversioning=NeverEnabled\n' "$bucket" "$region" >"$intent"
		chmod 0600 "$intent"
	fi
	if ! "$aws" --region "$region" --endpoint-url "$endpoint" s3api head-bucket \
		--bucket "$bucket" >/dev/null 2>&1; then
		"$aws" --region "$region" --endpoint-url "$endpoint" s3api create-bucket \
			--bucket "$bucket" --acl private \
			--create-bucket-configuration LocationConstraint="$region" >/dev/null
	fi
	"$aws" --region "$region" --endpoint-url "$endpoint" s3api put-bucket-acl \
		--bucket "$bucket" --acl private
	"$aws" --region "$region" --endpoint-url "$endpoint" s3api put-bucket-encryption \
		--bucket "$bucket" \
		--server-side-encryption-configuration \
		'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
	versioning=$(
		"$aws" --region "$region" --endpoint-url "$endpoint" s3api get-bucket-versioning \
			--bucket "$bucket" --output json
	)
	[[ -z ${versioning//[[:space:]]/} || $(jq -c . <<<"$versioning") == '{}' ]] || {
		echo "bucket is not NeverEnabled: $bucket" >&2
		exit 1
	}
	encryption=$(
		"$aws" --region "$region" --endpoint-url "$endpoint" s3api get-bucket-encryption \
			--bucket "$bucket" --output json
	)
	jq -e '.ServerSideEncryptionConfiguration.Rules
	  | any(.ApplyServerSideEncryptionByDefault.SSEAlgorithm == "AES256")' \
		<<<"$encryption" >/dev/null
	acl=$(
		"$aws" --region "$region" --endpoint-url "$endpoint" s3api get-bucket-acl \
			--bucket "$bucket" --output json
	)
	jq -e '[.Grants[]? | select(.Grantee.Type == "Group")] | length == 0' \
		<<<"$acl" >/dev/null
done

"$aws" --region "$region" --endpoint-url "$endpoint" s3api put-bucket-lifecycle-configuration \
	--bucket "${buckets[3]}" \
	--lifecycle-configuration '{"Rules":[{"ID":"expire-build-relay-after-one-day","Status":"Enabled","Filter":{"Prefix":"relay/"},"Expiration":{"Days":1},"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}'

jq -n --arg region "$region" --arg endpoint "$endpoint" \
	--arg cold "${buckets[0]}" --arg backup "${buckets[1]}" --arg code "${buckets[2]}" --arg relay "${buckets[3]}" --arg evidence "${buckets[4]}" \
	'{verdict:"created-and-verified",region:$region,endpoint:$endpoint,versioning:"NeverEnabled",default_encryption:"AES256",buckets:{cold:$cold,backup:$backup,code:$code,relay:$relay,evidence:$evidence}}' \
	>"$state_dir/cos-buckets.json"
chmod 0600 "$state_dir/cos-buckets.json"
jq '{verdict,region,versioning,default_encryption,buckets}' "$state_dir/cos-buckets.json"
