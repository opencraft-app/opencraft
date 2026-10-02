#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
run_id=${ACTOR_PRODUCT_BUILD_RUN_ID:?ACTOR_PRODUCT_BUILD_RUN_ID is required}
receipt_dir=${ACTOR_PRODUCT_RECEIPT_DIR:?ACTOR_PRODUCT_RECEIPT_DIR is required}
seed_receipt=${ACTOR_IMAGE_SEED_RECEIPT:?ACTOR_IMAGE_SEED_RECEIPT is required}
product_lock=${ACTOR_PRODUCT_IMAGE_LOCK:?ACTOR_PRODUCT_IMAGE_LOCK is required}
inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}
upstream_lock=${ACTOR_UPSTREAM_IMAGE_LOCK:-$script_dir/upstream-images.lock.json}
export TMPDIR=${ACTOR_BUILD_TMPDIR:-/data/tmp}

[[ $run_id =~ ^[0-9a-f]{32}$ ]] || { echo "product build run ID must be 32 lowercase hex characters" >&2; exit 2; }
for input in "$receipt_dir" "$seed_receipt" "$upstream_lock"; do
	[[ $input == /* && -e $input ]] || { echo "generation input must be an existing absolute path: $input" >&2; exit 2; }
done
for output in "$product_lock" "$inventory"; do
	[[ $output == /* && -d $(dirname -- "$output") ]] || { echo "generation output parent must exist: $output" >&2; exit 2; }
done
[[ $product_lock != "$inventory" ]] || { echo "product lock and inventory paths must differ" >&2; exit 2; }
[[ -d $TMPDIR ]] || install -d -m 1777 "$TMPDIR"

mapfile -t repositories < <(python3 "$script_dir/product-lock.py" required-repositories)
(( ${#repositories[@]} == 11 )) || { echo "product repository contract is incomplete" >&2; exit 1; }
receipt_args=()
for repository in "${repositories[@]}"; do
	receipt="$receipt_dir/product-${repository}-${run_id}.json"
	[[ -f $receipt ]] || { echo "product generation receipt is missing: $receipt" >&2; exit 1; }
	receipt_args+=(--receipt "$receipt")
done

product_stage=$(mktemp -d "$(dirname -- "$product_lock")/.actor-product-generation.XXXXXX")
inventory_stage=$(mktemp -d "$(dirname -- "$inventory")/.actor-image-generation.XXXXXX")
cleanup() { rm -rf -- "$product_stage" "$inventory_stage"; }
trap cleanup EXIT INT TERM
python3 "$script_dir/product-lock.py" assemble "${receipt_args[@]}" --output "$product_stage/product.json" >/dev/null
if [[ -e $product_lock ]]; then
	cmp --silent "$product_stage/product.json" "$product_lock" || { echo "existing product lock differs from this generation" >&2; exit 1; }
else
	ln "$product_stage/product.json" "$product_lock"
fi

python3 "$script_dir/image-lock.py" assemble \
	--upstream-lock "$upstream_lock" \
	--seed-receipt "$seed_receipt" \
	--product-lock "$product_lock" \
	--output "$inventory_stage/inventory.json" >/dev/null
if [[ -e $inventory ]]; then
	cmp --silent "$inventory_stage/inventory.json" "$inventory" || { echo "existing image inventory differs from this generation" >&2; exit 1; }
else
	ln "$inventory_stage/inventory.json" "$inventory"
fi
python3 "$script_dir/image-lock.py" validate-inventory --lock "$inventory" >/dev/null
printf 'image_generation=passed run_id=%s repositories=28 inventory_digest=%s\n' \
	"$run_id" "$(jq -r .inventoryDigest "$inventory")"
