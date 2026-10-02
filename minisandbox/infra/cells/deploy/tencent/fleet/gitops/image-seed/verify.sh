#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash -n "$script_dir/seed-tcr.sh" "$script_dir/bind-inventory.sh" \
	"$script_dir/build-foundations.sh" "$script_dir/assemble-generation.sh" \
	"$script_dir/copy-inventory.sh" "$script_dir/export-inventory-oci.sh"
grep -F 'destination_digest == "$digest"' "$script_dir/copy-inventory.sh" >/dev/null
grep -F 'coldPullVerified:true' "$script_dir/copy-inventory.sh" >/dev/null
grep -F 'Directory Transport Version: 1.1' "$script_dir/copy-inventory.sh" >/dev/null
grep -F 'copy --preserve-digests' "$script_dir/export-inventory-oci.sh" >/dev/null
grep -Fx 'location = "mirror.ccs.tencentyun.com"' \
	"$script_dir/tencent-dockerhub-mirror.registries.conf" >/dev/null
python3 "$script_dir/test_image_contract.py"
python3 "$script_dir/test_product_lock.py"
python3 "$script_dir/test_record_product_image.py"
python3 "$script_dir/test_revalidate_regional_seed.py"
python3 "$script_dir/test_foundation_plan.py"
python3 "$script_dir/test_foundation_module_labels.py"
python3 "$script_dir/test_assemble_generation.py"
python3 "$script_dir/foundation-plan.py" --lock "$script_dir/foundation-images.lock.json" >/dev/null
python3 "$script_dir/image-lock.py" validate-upstream \
	--lock "$script_dir/upstream-images.lock.json" >/dev/null
echo "image_seed_static=passed"
