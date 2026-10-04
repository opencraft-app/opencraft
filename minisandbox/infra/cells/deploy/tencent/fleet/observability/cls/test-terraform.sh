#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
terraform=${ACTOR_TERRAFORM_BIN:?absolute verified Terraform binary required}
plugin_dir=${ACTOR_TERRAFORM_PLUGIN_DIR:?absolute provider mirror required}
lock=$fleet_dir/terraform/create-first/tools/terraform.lock.json
[[ $terraform == /* && -x $terraform && $plugin_dir == /* && -d $plugin_dir ]]
sha=$(jq -er '.binary.sha256' "$lock")
printf '%s  %s\n' "$sha" "$terraform" | sha256sum -c - >/dev/null

task_dir=$(mktemp -d /data/tmp/cls-terraform-test.XXXXXX)
cp -- "$script_dir/terraform-tests/main.tf" "$task_dir/main.tf"
cp -- "$script_dir/terraform-tests/cls.tftest.hcl" "$task_dir/cls.tftest.hcl"
cp -- "$fleet_dir/terraform/create-first/management/cls.tf" "$task_dir/cls.tf"
export TF_DATA_DIR="$task_dir/provider-data" TMPDIR=/data/tmp TF_IN_AUTOMATION=1

# There is no backend or credentials in this fixture. The native mock provider
# is declared in the test file; no apply command is permitted by this entry.
"$terraform" -chdir="$task_dir" init -backend=false -input=false -plugin-dir="$plugin_dir" >/dev/null
"$terraform" -chdir="$task_dir" test -no-color
printf 'retained_test_root=%s\n' "$task_dir"
