#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

read_file_value() {
  local path="$1"
  if [ -f "$path" ]; then
    tr -d '\r' <"$path"
  fi
}

tccli_json() {
  if [ -n "${GATEWAY_TCCLI_PROFILE:-}" ]; then
    tccli --profile "$GATEWAY_TCCLI_PROFILE" "$@" --output json
  else
    tccli "$@" --output json
  fi
}

require_cmd jq
require_cmd tccli

# The project .env may contain runtime Tencent credentials that are intentionally
# narrower than deployment permissions. Prefer the tccli profile for deployment
# unless explicitly told to use env credentials.
if [ "${GATEWAY_USE_ENV_TENCENT_CREDENTIALS:-0}" != "1" ]; then
  unset TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TENCENTCLOUD_TOKEN TENCENTCLOUD_REGION
fi

REGION="${GATEWAY_EKS_REGION:-ap-beijing}"
EKS_CI_NAME="${GATEWAY_EKS_CI_NAME:-cloudagent-gateway}"
EKS_CI_ID="${GATEWAY_EKS_CI_ID:-}"
IMAGE="${GATEWAY_IMAGE:-$(read_file_value "${GATEWAY_IMAGE_FILE:-/tmp/cloudagent-gateway-image}")}"
CBS_DISK_ID="${GATEWAY_CBS_DISK_ID:-$(read_file_value "${GATEWAY_CBS_DISK_ID_FILE:-/tmp/cloudagent-gateway-data-disk}")}"
DATA_VOLUME_NAME="${GATEWAY_DATA_VOLUME_NAME:-gateway-data}"
DATA_MOUNT_PATH="${GATEWAY_DATA_MOUNT_PATH:-/data}"
DATA_DIR_DEFAULT="/tmp/gateway-data"
if [ -n "$CBS_DISK_ID" ]; then
  DATA_DIR_DEFAULT="${DATA_MOUNT_PATH%/}/gateway"
fi
DATA_DIR="${GATEWAY_DATA_DIR:-$DATA_DIR_DEFAULT}"
SIDECAR_URL="${GATEWAY_AGENT_SIDECAR_URL:-$(read_file_value "${GATEWAY_AGENT_SIDECAR_URL_FILE:-/tmp/agent-sidecar-url.clean}")}"
SANDBOX_HOST_URL="${GATEWAY_SANDBOX_HOST_URL:-${HERMES_SANDBOX_HOST_URL:-$(read_file_value "${SANDBOX_HOST_URL_FILE:-/tmp/sandbox-host-url.clean}")}}"
TALOS_API_KEY="${GATEWAY_TALOS_API_KEY:-${TALOS_API_KEY:-}}"
TALOS_API_URL="${GATEWAY_TALOS_API_URL:-https://api.talos.ren}"
TALOS_DOMAIN="${GATEWAY_TALOS_DOMAIN:-api.talos.ren}"
TALOS_TEMPLATE="${GATEWAY_TALOS_TEMPLATE:-498c6c11-74d7-426e-bdb1-13d8aa73997e}"
TCR_TOKEN_FILE="${GATEWAY_TCR_PULL_TOKEN_FILE:-/tmp/cloudagent-tcr-pull-token.json}"

require_env IMAGE
require_env SIDECAR_URL
require_env SANDBOX_HOST_URL
require_env E2B_API_KEY
require_env TOKENHUB_API_KEY
require_env GATEWAY_AGS_TEMPLATE
require_env INNER_SANDBOX_TEMPLATE

if [ ! -f "$TCR_TOKEN_FILE" ]; then
  printf 'missing TCR pull token file: %s\n' "$TCR_TOKEN_FILE" >&2
  exit 2
fi

export _IMAGE="$IMAGE"
export _EKS_CI_NAME="$EKS_CI_NAME"
export _CBS_DISK_ID="$CBS_DISK_ID"
export _DATA_VOLUME_NAME="$DATA_VOLUME_NAME"
export _DATA_MOUNT_PATH="$DATA_MOUNT_PATH"
export _DATA_DIR="$DATA_DIR"
export _TCR_USER="$(jq -r '.Username' "$TCR_TOKEN_FILE")"
export _TCR_TOKEN="$(jq -r '.Token' "$TCR_TOKEN_FILE")"
export _E2B_API_KEY="$E2B_API_KEY"
export _TOKENHUB_API_KEY="$TOKENHUB_API_KEY"
export _TOKENHUB_MODEL="${TOKENHUB_MODEL:-minimax-m2.7}"
export _E2B_DOMAIN="${E2B_DOMAIN:-ap-beijing.tencentags.com}"
export _OUTER_TEMPLATE="$GATEWAY_AGS_TEMPLATE"
export _INNER_TEMPLATE="$INNER_SANDBOX_TEMPLATE"
export _SIDECAR_URL="$SIDECAR_URL"
export _SANDBOX_HOST_URL="$SANDBOX_HOST_URL"
export _TALOS_API_KEY="$TALOS_API_KEY"
export _TALOS_API_URL="$TALOS_API_URL"
export _TALOS_DOMAIN="$TALOS_DOMAIN"
export _TALOS_TEMPLATE="$TALOS_TEMPLATE"
export _TENANT_ID="${TENANT_ID:-tenant-live}"
export _PROJECT_ID="${PROJECT_ID:-project-live}"

write_update_payload() {
  local eks_ci_id="$1"
  export _EKS_CI_ID="$eks_ci_id"
  jq -n '
  def data_volume_mount:
    if env._CBS_DISK_ID == "" then
      []
    else
      [{Name:env._DATA_VOLUME_NAME, MountPath:env._DATA_MOUNT_PATH, ReadOnly:false}]
    end;
  {
    EksCiId: env._EKS_CI_ID,
    Name: env._EKS_CI_NAME,
    RestartPolicy: "Always",
    ImageRegistryCredentials: [{
      Server: "lightclaw-bj82.tencentcloudcr.com",
      Username: env._TCR_USER,
      Password: env._TCR_TOKEN,
      Name: "tcr-regcred"
    }],
    Containers: [{
      Image: env._IMAGE,
      Name: "gateway",
      Cpu: 1,
      Memory: 2,
      EnvironmentVars: [
        {Name:"GATEWAY_ADDR",Value:":8080"},
        {Name:"GATEWAY_DATA_DIR",Value:env._DATA_DIR},
        {Name:"GATEWAY_WORKER_MODE",Value:"agent_injected"},
        {Name:"GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS",Value:"300"},
        {Name:"GATEWAY_DEFAULT_TENANT_ID",Value:env._TENANT_ID},
        {Name:"GATEWAY_DEFAULT_PROJECT_ID",Value:env._PROJECT_ID},
        {Name:"TOKENHUB_MODEL",Value:env._TOKENHUB_MODEL},
        {Name:"E2B_DOMAIN",Value:env._E2B_DOMAIN},
        {Name:"E2B_API_KEY",Value:env._E2B_API_KEY},
        {Name:"TOKENHUB_API_KEY",Value:env._TOKENHUB_API_KEY},
        {Name:"GATEWAY_AGS_TEMPLATE",Value:env._OUTER_TEMPLATE},
        {Name:"INNER_SANDBOX_TEMPLATE",Value:env._INNER_TEMPLATE},
        {Name:"GATEWAY_AGENT_SIDECAR_URL",Value:env._SIDECAR_URL},
        {Name:"GATEWAY_SANDBOX_HOST_URL",Value:env._SANDBOX_HOST_URL},
        {Name:"GATEWAY_TALOS_API_KEY",Value:env._TALOS_API_KEY},
        {Name:"GATEWAY_TALOS_API_URL",Value:env._TALOS_API_URL},
        {Name:"GATEWAY_TALOS_DOMAIN",Value:env._TALOS_DOMAIN},
        {Name:"GATEWAY_TALOS_TEMPLATE",Value:env._TALOS_TEMPLATE}
      ],
      VolumeMounts: data_volume_mount,
      ReadinessProbe:{Probe:{InitialDelaySeconds:5,PeriodSeconds:10,TimeoutSeconds:3,FailureThreshold:12},TcpSocket:{Port:8080}},
      LivenessProbe:{Probe:{InitialDelaySeconds:30,PeriodSeconds:20,TimeoutSeconds:3,FailureThreshold:3},TcpSocket:{Port:8080}}
    }]
  }
  + (if env._CBS_DISK_ID == "" then
      {}
    else
      {
        EksCiVolume:{CbsVolumes:[{CbsDiskId:env._CBS_DISK_ID, Name:env._DATA_VOLUME_NAME}]},
        InitContainers:[{
          Image:"busybox:1.36",
          Name:"gateway-data-init",
          Commands:["sh","-c"],
          Args:["mkdir -p " + env._DATA_DIR + " && chown -R 10001:10001 " + env._DATA_MOUNT_PATH],
          Cpu:0.1,
          Memory:0.125,
          VolumeMounts:data_volume_mount
        }]
      }
    end)' >"$UPDATE_JSON"
}

find_existing_instance() {
  local describe_json="$1"
  tccli_json tke DescribeEKSContainerInstances \
    --region "$REGION" \
    --Filters "[{\"Name\":\"eks-ci-name\",\"Values\":[\"${EKS_CI_NAME}\"]}]" >"$describe_json"
  jq -r '
    (.EksCis // [])
    | map(select(.Status != "Succeeded"))
    | sort_by(.CreationTime)
    | last?
    | .EksCiId // empty
  ' "$describe_json"
}

poll_instance() {
  local eks_ci_id="$1"
  local describe_json="$2"
  local status state eip reason
  for i in $(seq 1 40); do
    tccli_json tke DescribeEKSContainerInstances \
      --region "$REGION" \
      --EksCiIds "[\"${eks_ci_id}\"]" >"$describe_json"
    status="$(jq -r '.EksCis[0].Status // ""' "$describe_json")"
    state="$(jq -r '.EksCis[0].Containers[0].CurrentState.State // ""' "$describe_json")"
    eip="$(jq -r '.EksCis[0].EipAddress // ""' "$describe_json")"
    reason="$(jq -r '.EksCis[0].Containers[0].CurrentState.Reason // ""' "$describe_json")"
    printf '[deploy] attempt=%s eksci=%s status=%s state=%s eip=%s reason=%s\n' "$i" "$eks_ci_id" "$status" "$state" "$eip" "$reason" >&2
    if [ "$status" = "Running" ] && [ "$state" = "running" ] && [ -n "$eip" ] && [ "$eip" != "null" ]; then
      printf '%s\n' "$eip"
      return 0
    fi
    sleep 10
  done
  return 1
}

DESCRIBE_JSON="$(mktemp -t gateway-eksci-describe.XXXXXX.json)"
UPDATE_JSON="$(mktemp -t gateway-eksci-update.XXXXXX.json)"
trap 'rm -f "$DESCRIBE_JSON" "$UPDATE_JSON"' EXIT

if [ -z "$EKS_CI_ID" ]; then
  EKS_CI_ID="$(find_existing_instance "$DESCRIBE_JSON")"
fi

if [ -z "$EKS_CI_ID" ]; then
  printf 'no existing EKS CI named %s found; create once, then use this in-place deploy path\n' "$EKS_CI_NAME" >&2
  exit 2
fi

previous_eip="$(tccli_json tke DescribeEKSContainerInstances --region "$REGION" --EksCiIds "[\"${EKS_CI_ID}\"]" | jq -r '.EksCis[0].EipAddress // ""')"
printf '[deploy] update eksci=%s name=%s previous_eip=%s image=%s data_dir=%s cbs_disk_id=%s\n' "$EKS_CI_ID" "$EKS_CI_NAME" "$previous_eip" "$IMAGE" "$DATA_DIR" "${CBS_DISK_ID:-none}" >&2

write_update_payload "$EKS_CI_ID"
tccli_json tke UpdateEKSContainerInstance --region "$REGION" --cli-input-json "file://${UPDATE_JSON}" >/tmp/gateway-eksci-update.out

current_eip="$(poll_instance "$EKS_CI_ID" "$DESCRIBE_JSON")"
if [ -n "$previous_eip" ] && [ "$previous_eip" != "null" ] && [ "$current_eip" != "$previous_eip" ]; then
  printf 'EIP changed unexpectedly: previous=%s current=%s\n' "$previous_eip" "$current_eip" >&2
  exit 1
fi

printf '[deploy] ready eksci=%s eip=%s\n' "$EKS_CI_ID" "$current_eip" >&2
printf '%s\n' "$current_eip"
