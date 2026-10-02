#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [[ -n ${TERRAFORM:-} ]]; then
	command -v "$TERRAFORM" >/dev/null 2>&1 || {
		echo "TERRAFORM is unavailable: $TERRAFORM" >&2
		exit 1
	}
	command -v "$TERRAFORM"
	exit 0
fi
if command -v terraform >/dev/null 2>&1; then
	command -v terraform
	exit 0
fi
exec "$script_dir/install-terraform.sh"
