#!/bin/sh
set -eu

source_root=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"}

if [ -n "${CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK:-}" ]; then
  go run "$source_root/cmd/migration-release" --verify \
    --root "$source_root" \
    --trusted-base "$CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK"
else
  go run "$source_root/cmd/migration-release" --verify --root "$source_root"
fi
