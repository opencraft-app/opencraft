#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: run.sh STATE_BUCKET IMAGE_INVENTORY OUTPUT_RECEIPT

Required environment:
  COS_SECRET_ID
  COS_SECRET_KEY

The state bucket is the protected rebuild seed and is deliberately excluded
from every infrastructure destroy. The operation is read-only except for
content-addressed recovery/source and recovery/tools objects in that bucket.
EOF
	exit 2
}

[[ $# -eq 3 ]] || usage
state_bucket=$1
image_inventory=$(readlink -e "$2")
output=$3
[[ $state_bucket =~ ^actor-terraform-state-[a-z0-9-]+-[0-9]+$ ]] || {
	echo "invalid create-first state bucket: $state_bucket" >&2
	exit 2
}
[[ $output == /* && $output != / && ! -e $output ]] || {
	echo "output receipt must be a new absolute path" >&2
	exit 2
}
[[ -f $image_inventory && ! -L $image_inventory ]] || {
	echo "image inventory must be a regular non-symlink file" >&2
	exit 2
}
: "${COS_SECRET_ID:?COS_SECRET_ID is required}"
: "${COS_SECRET_KEY:?COS_SECRET_KEY is required}"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
create_first=$(dirname -- "$script_dir")
repo=$(git -C "$script_dir" rev-parse --show-toplevel)
runtime_dir=$repo/infra/cells/deploy/tencent/fleet/runtime
lock=$create_first/tools/terraform.lock.json
endpoint=cos.ap-beijing.myqcloud.com

for command in coscli curl git jq python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "pre-destroy audit requires tool: $command" >&2; exit 2; }
done
mkdir -p "$(dirname -- "$output")"
umask 077
temporary=$(mktemp -d /data/tmp/actor-pre-destroy.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
mkdir -p "$temporary/logs" "$temporary/errors" "$temporary/states" "$temporary/source"

cos() {
	coscli --init-skip -i "$COS_SECRET_ID" -k "$COS_SECRET_KEY" \
		-e "$endpoint" --log-path "$temporary/logs" "$@"
}

versioning=$(cos bucket-versioning --method get "cos://$state_bucket" 2>&1 | sed -r 's/\x1B\[[0-9;]*[mK]//g')
grep -F 'bucket versioning status is Enabled' <<<"$versioning" >/dev/null || {
	echo "state/recovery bucket versioning is not Enabled" >&2
	exit 1
}

declare -A state_keys=(
	[foundation]='actor-fleet/foundation/terraform.tfstate'
	[management]='actor-fleet/management/terraform.tfstate'
	[operations-network]='actor-fleet/operations-network/terraform.tfstate'
	[actor-bj-a01]='actor-fleet/cells/actor-bj-a01/terraform.tfstate'
	[actor-bj-b01]='actor-fleet/cells/actor-bj-b01/terraform.tfstate'
)
state_args=()
for name in foundation management operations-network actor-bj-a01 actor-bj-b01; do
	target=$temporary/states/$name.json
	cos cp "cos://$state_bucket/${state_keys[$name]}" "$target" \
		--fail-output-path "$temporary/errors" >/dev/null
	chmod 0600 "$target"
	state_args+=(--state "$name=$target")
done

# Verify static Terraform/provider contracts with the source-controlled tool
# lock. Disposable caches may accelerate this command but cannot select the
# Terraform version.
ACTOR_TOOL_ROOT=${ACTOR_TOOL_ROOT:-/data/actor-tools} "$create_first/verify.sh" >/dev/null

revision=$(git -C "$repo" rev-parse HEAD)
bundle=$temporary/source/source-$revision.tar.gz
source_receipt=$temporary/source/source-$revision.receipt.json
RIVET_SOURCE_DIR=$repo \
	RIVET_SOURCE_REVISION=$revision \
	RIVET_SOURCE_BUNDLE=$bundle \
	RIVET_SOURCE_RECEIPT=$source_receipt \
	"$runtime_dir/bundle-full-reviewed-source.sh" >/dev/null
"$runtime_dir/verify-full-source-bundle.py" \
	--bundle "$bundle" --receipt "$source_receipt" --revision "$revision" >/dev/null
bundle_sha=$(sha256sum "$bundle" | cut -d' ' -f1)
source_prefix=recovery/v1/source/$revision/$bundle_sha

publish_exact() {
	local source=$1 remote=$2 label=$3
	local recovered=$temporary/recovered-$(basename -- "$source")
	if cos cp "$remote" "$recovered" --fail-output-path "$temporary/errors" >/dev/null 2>&1; then
		cmp -s "$source" "$recovered" || {
			echo "$label recovery key already exists with different bytes: $remote" >&2
			exit 1
		}
		return
	fi
	cos cp "$source" "$remote" --fail-output-path "$temporary/errors" >/dev/null
	cos cp "$remote" "$recovered" --fail-output-path "$temporary/errors" >/dev/null
	cmp -s "$source" "$recovered" || {
		echo "$label COS readback differs after upload" >&2
		exit 1
	}
}

source_uri=cos://$state_bucket/$source_prefix/$(basename -- "$bundle")
source_receipt_uri=cos://$state_bucket/$source_prefix/$(basename -- "$source_receipt")
publish_exact "$bundle" "$source_uri" 'source bundle'
publish_exact "$source_receipt" "$source_receipt_uri" 'source receipt'

image_validation=$(python3 "$repo/infra/cells/deploy/tencent/fleet/gitops/image-seed/image-lock.py" \
	validate-inventory --lock "$image_inventory")
image_digest=$(jq -er '.inventoryDigest' <<<"$image_validation")
image_sha=$(sha256sum "$image_inventory" | cut -d' ' -f1)
image_uri=cos://$state_bucket/recovery/v1/images/$image_digest/$image_sha/$(basename -- "$image_inventory")
publish_exact "$image_inventory" "$image_uri" 'image inventory'

terraform_version=$(jq -er '.version' "$lock")
terraform_platform=$(jq -er '.platform' "$lock")
terraform_url=$(jq -er '.archive.url' "$lock")
terraform_archive_sha=$(jq -er '.archive.sha256' "$lock")
terraform_archive=$temporary/terraform-$terraform_version-$terraform_platform.zip
curl --fail --location --proto '=https' --tlsv1.2 --output "$terraform_archive" "$terraform_url" >/dev/null
printf '%s  %s\n' "$terraform_archive_sha" "$terraform_archive" | sha256sum -c - >/dev/null
terraform_uri=cos://$state_bucket/recovery/v1/tools/terraform/$terraform_version/$terraform_platform/$terraform_archive_sha.zip
publish_exact "$terraform_archive" "$terraform_uri" 'Terraform archive'

set +e
python3 "$script_dir/audit.py" \
	--repo "$repo" \
	--source-bundle "$bundle" \
	--source-receipt "$source_receipt" \
	--source-remote-uri "$source_uri" \
	--terraform-lock "$lock" \
	--terraform-archive "$terraform_archive" \
	--terraform-remote-uri "$terraform_uri" \
	--image-inventory "$image_inventory" \
	--image-remote-uri "$image_uri" \
	--state-bucket "$state_bucket" \
	--bucket-versioning Enabled \
	"${state_args[@]}" \
	--output "$temporary/audit.json"
audit_status=$?
set -e

install -m 0600 "$temporary/audit.json" "$output"
if (( audit_status != 0 )); then
	echo "pre_destroy=blocked receipt=$output" >&2
	exit "$audit_status"
fi

audit_sha=$(sha256sum "$output" | cut -d' ' -f1)
audit_uri=cos://$state_bucket/recovery/v1/audits/$audit_sha.json
publish_exact "$output" "$audit_uri" 'pre-destroy audit'
printf 'pre_destroy=passed receipt=%s sha256=%s remote=%s source=%s\n' \
	"$output" "$audit_sha" "$audit_uri" "$source_uri"
