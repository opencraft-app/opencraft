#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

profile_file=${RIVET_TENCENT_COS_BACKUP_RESTORE_STORAGE_PROFILE:-}
[[ -n ${profile_file} && -f ${profile_file} ]] || \
	die "RIVET_TENCENT_COS_BACKUP_RESTORE_STORAGE_PROFILE must name the dedicated Beijing qualification StorageProfile"
credential_file=${RIVET_TENCENT_COS_CREDENTIAL_FILE:-${MESH_STATE_DIR}/tencent-cos-root.env}

exec env \
	RIVET_BACKUP_RESTORE_STORAGE_PROFILE="${profile_file}" \
	RIVET_TENCENT_COS_CREDENTIAL_FILE="${credential_file}" \
	"${MESH_DIR}/backup-restore-physical-e2e/run.sh"
