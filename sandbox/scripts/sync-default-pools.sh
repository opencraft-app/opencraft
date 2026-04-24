#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MONO_DIR="$(cd "${SANDBOX_DIR}/.." && pwd)"
source "${MONO_DIR}/scripts/lib/load-deploy-env.sh"
source "${MONO_DIR}/scripts/lib/kustomize-deploy-common.sh"

DEFAULT_POOLS_CONFIG="${DEFAULT_POOLS_CONFIG:-${SANDBOX_DIR}/config/default-pools.tsv}"
MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.0}"
NAMESPACE="${SANDBOX_NAMESPACE:-sandbox}"

usage() {
  cat <<'EOF'
Usage:
  ENV=<env> bash sandbox/scripts/sync-default-pools.sh --base-image <img-id> [--desired-capacity <n>]

Description:
  Upsert the checked-in default sandbox pools into MySQL using explicit per-pool
  network + security group configuration. This is the only supported way to
  seed/update default pools; K8s deploy no longer auto-seeds them.
EOF
}

BASE_IMAGE=""
DESIRED_CAPACITY="${SANDBOX_POOL_DESIRED_CAPACITY:-24}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-image)
      BASE_IMAGE="${2:-}"
      shift 2
      ;;
    --desired-capacity)
      DESIRED_CAPACITY="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

ENV_NAME=""
if [[ -n "${ENV:-}" ]]; then
  ENV_NAME="$(require_deploy_env_name "${ENV}")"
  load_deploy_env "${MONO_DIR}" "${ENV_NAME}"
  TEST_SECRET_ENV="${TEST_SECRET_ENV:-$(resolve_deploy_env_path "${MONO_DIR}" "${DEPLOY_SANDBOX_TEST_SECRET_ENV:-.secret/sandbox/test.env}")}"
  if [[ -f "${TEST_SECRET_ENV}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${TEST_SECRET_ENV}"
    set +a
  fi
fi

kd_require_commands kubectl python3 || exit 1
kd_require_file "${DEFAULT_POOLS_CONFIG}" "expected checked-in default pool config" || exit 1
kd_require_value "--base-image" "${BASE_IMAGE}" || exit 1

MYSQL_HOST_VALUE="${SANDBOX_MYSQL_HOST:-${MYSQL_HOST:-}}"
MYSQL_PORT_VALUE="${SANDBOX_MYSQL_PORT:-${MYSQL_PORT:-3306}}"
MYSQL_DB_VALUE="${MYSQL_DB:-cvm}"
MYSQL_USER_VALUE="${MYSQL_USER:-root}"
MYSQL_PASSWORD_VALUE="${SANDBOX_MYSQL_PASSWORD:-${MYSQL_PASSWORD:-}}"
VPC_ID_VALUE="${SANDBOX_VPC_ID:-}"

kd_require_value "SANDBOX_MYSQL_HOST/MYSQL_HOST" "${MYSQL_HOST_VALUE}" || exit 1
kd_require_value "MYSQL_USER" "${MYSQL_USER_VALUE}" || exit 1
kd_require_value "SANDBOX_MYSQL_PASSWORD/MYSQL_PASSWORD" "${MYSQL_PASSWORD_VALUE}" || exit 1
kd_require_value "SANDBOX_VPC_ID" "${VPC_ID_VALUE}" || exit 1

export DEFAULT_POOLS_CONFIG BASE_IMAGE DESIRED_CAPACITY MYSQL_HOST_VALUE MYSQL_PORT_VALUE MYSQL_DB_VALUE MYSQL_USER_VALUE MYSQL_PASSWORD_VALUE VPC_ID_VALUE

SQL_PAYLOAD="$(python3 - <<'PY'
import os
import sys

config_path = os.environ["DEFAULT_POOLS_CONFIG"]
base_image = os.environ["BASE_IMAGE"].strip()
desired_capacity = os.environ["DESIRED_CAPACITY"].strip()
vpc_id = os.environ["VPC_ID_VALUE"].strip()
instance_type = os.environ.get("SANDBOX_POOL_INSTANCE_TYPE", "SA5.LARGE8").strip() or "SA5.LARGE8"

def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

lines = []
with open(config_path, "r", encoding="utf-8") as handle:
    for raw in handle:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        pool_id, subnet_env, zone_env, security_groups_env = line.split()
        subnet_id = os.environ.get(subnet_env, "").strip()
        zone = os.environ.get(zone_env, "").strip()
        raw_security_groups = os.environ.get(security_groups_env, "").strip()
        security_groups = ",".join(part.strip() for part in raw_security_groups.split(",") if part.strip())
        if not subnet_id:
            raise SystemExit(f"missing {subnet_env} for {pool_id}")
        if not zone:
            raise SystemExit(f"missing {zone_env} for {pool_id}")
        if not security_groups:
            raise SystemExit(f"missing {security_groups_env} for {pool_id}")
        lines.append(
            "INSERT INTO pools ("
            "id, name, description, base_image, desired_capacity, instance_type, status, "
            "pause_reason, consecutive_refill_failures, last_refill_error_code, last_refill_error, "
            "vpc_id, subnet_id, zone, security_groups, created_at"
            ") VALUES ("
            f"{sql_quote(pool_id)}, {sql_quote(pool_id)}, '', {sql_quote(base_image)}, {desired_capacity}, "
            f"{sql_quote(instance_type)}, 'active', '', 0, '', '', {sql_quote(vpc_id)}, "
            f"{sql_quote(subnet_id)}, {sql_quote(zone)}, {sql_quote(security_groups)}, UTC_TIMESTAMP()"
            ") ON DUPLICATE KEY UPDATE "
            "name = VALUES(name), "
            "description = VALUES(description), "
            "base_image = VALUES(base_image), "
            "desired_capacity = VALUES(desired_capacity), "
            "instance_type = VALUES(instance_type), "
            "vpc_id = VALUES(vpc_id), "
            "subnet_id = VALUES(subnet_id), "
            "zone = VALUES(zone), "
            "security_groups = VALUES(security_groups);"
        )

print("START TRANSACTION;")
for statement in lines:
    print(statement)
print("COMMIT;")
PY
)"

SYNC_POD_NAME="mysql-default-pools-sync-$(date +%s)"

kubectl -n "${NAMESPACE}" run "${SYNC_POD_NAME}" --image="${MYSQL_IMAGE}" --rm -i --restart=Never -- \
  mysql \
    --host="${MYSQL_HOST_VALUE}" \
    --port="${MYSQL_PORT_VALUE}" \
    --user="${MYSQL_USER_VALUE}" \
    --password="${MYSQL_PASSWORD_VALUE}" \
    "${MYSQL_DB_VALUE}" \
    -e "${SQL_PAYLOAD}"
