#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
entrypoint=$script_dir/run-bottomless-production.sh

bash -n "$entrypoint"
grep -Fq 'QUALIFICATION_PROFILE=production-cell' "$entrypoint"
grep -Fq 'RIVET_CELL_NAME=$cell' "$entrypoint"
grep -Fq 'RIVET_CELL_NAMESPACE=$namespace' "$entrypoint"
grep -Fq 'cache-qualification-receipt.sh' "$entrypoint"
grep -Fq 'verify_bottomless_receipt.py' "$entrypoint"
grep -Fq 'persist-receipt-from-builder.sh' "$entrypoint"
grep -Fq 'cache-qualification-receipt.sh' "$script_dir/run-engine-ha.sh"
grep -Fq 'cache-qualification-receipt.sh' "$script_dir/physical-restore/run.sh"
if grep -Eq 'QUALIFICATION_PROFILE=production([^_-]|$)' "$entrypoint"; then
	echo "q01 entrypoint must use the autoscaling-cell production profile" >&2
	exit 1
fi
echo "q01 Bottomless production entrypoint contract passed"
