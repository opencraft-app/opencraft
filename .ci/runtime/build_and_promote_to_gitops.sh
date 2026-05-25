#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${REPO_ROOT}/.ci/init.sh"
DEPLOYED_AT="${DEPLOYED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
PIN_SCRIPT="${PIN_SCRIPT_OVERRIDE:-$REPO_ROOT/.ci/runtime/pin_image_to_gitops.sh}"
BUILD_ONLY="${BUILD_ONLY:-false}"
AUTO_PIN_ONLY="${AUTO_PIN_ONLY:-false}"

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <bundle-service> <pin-targets-csv> <build-envs-csv> <auto-pin-envs-csv-or-none>" >&2
  exit 1
fi

BUNDLE_SERVICE="$1"
PIN_TARGETS="$2"
BUILD_ENVS="$3"
AUTO_PIN_ENVS="$4"

ci_require_commands git python3

SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD)"
SOURCE_REF="$(git -C "$REPO_ROOT" rev-parse HEAD)"
TAG="${BUILD_TAG_OVERRIDE:-${BUNDLE_SERVICE}-${SHORT_SHA}}"
CI_RUNTIME_REF="${CI_RUNTIME_REF:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || printf '%s' "$SOURCE_REF")}"
CI_RUNTIME_COMMIT="${CI_RUNTIME_COMMIT:-$SOURCE_REF}"
export CI_RUNTIME_REF CI_RUNTIME_COMMIT

IFS=',' read -r -a ENVS <<<"$BUILD_ENVS"

if [[ "$BUILD_ONLY" == "true" && "$AUTO_PIN_ONLY" == "true" ]]; then
  echo "BUILD_ONLY and AUTO_PIN_ONLY cannot both be true" >&2
  exit 1
fi

csv_contains() {
  local csv="$1"
  local needle="$2"
  local item
  if [[ "$csv" == "none" ]]; then
    return 1
  fi
  IFS=',' read -r -a items <<<"$csv"
  for item in "${items[@]}"; do
    item="$(printf '%s' "$item" | xargs)"
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

is_prod_env() {
  [[ "$1" == "shprod" || "$1" == "sgprod" ]]
}

is_beijing_sandbox_env() {
  [[ "$1" == "beijing-sandbox" || "$1" == beijing-sandbox-* ]]
}

is_playground_env() {
  [[ "$1" == sandbox-bj-* ]]
}

has_prod_promote_env() {
  local env_name
  for env_name in "${ENVS[@]}"; do
    env_name="$(printf '%s' "$env_name" | xargs)"
    if is_prod_env "$env_name" && ! csv_contains "$AUTO_PIN_ENVS" "$env_name"; then
      return 0
    fi
  done
  return 1
}

if [[ -n "${RELEASE_IMAGE_DIR:-}" ]]; then
  BUILT_IMAGE_DIR="$RELEASE_IMAGE_DIR"
  mkdir -p "$BUILT_IMAGE_DIR"
  CLEANUP_BUILT_IMAGE_DIR=false
else
  BUILT_IMAGE_DIR="$(mktemp -d)"
  CLEANUP_BUILT_IMAGE_DIR=true
fi
PIN_RUNTIME_SNAPSHOT=""
cleanup_built_image_dir() {
  if [[ "$CLEANUP_BUILT_IMAGE_DIR" == "true" ]]; then
    rm -rf "$BUILT_IMAGE_DIR"
  fi
}
cleanup_runtime_artifacts() {
  cleanup_built_image_dir
  if [[ -n "$PIN_RUNTIME_SNAPSHOT" ]]; then
    rm -rf "$PIN_RUNTIME_SNAPSHOT"
  fi
}
trap cleanup_runtime_artifacts EXIT

prepare_pin_runtime_snapshot() {
  if [[ -n "${PIN_SCRIPT_OVERRIDE:-}" ]]; then
    return
  fi

  PIN_RUNTIME_SNAPSHOT="$(ci_create_runtime_snapshot "$REPO_ROOT/.ci")"
  PIN_SCRIPT="$PIN_RUNTIME_SNAPSHOT/.ci/runtime/pin_image_to_gitops.sh"
}

if [[ "$AUTO_PIN_ONLY" != "true" ]]; then
  for ENV_NAME in "${ENVS[@]}"; do
    ci_set_registry_credentials "$ENV_NAME"
    image_output_file="$(mktemp)"
    python3 "$REPO_ROOT/.ci/runtime/commands/build_release_image.py" \
      --service "$BUNDLE_SERVICE" \
      --env "$ENV_NAME" \
      --tag "$TAG" \
      --push \
      --image-output-file "$image_output_file"
    IMAGE="$(<"$image_output_file")"
    rm -f "$image_output_file"
    printf '%s\n' "$IMAGE" > "$BUILT_IMAGE_DIR/$ENV_NAME"
    echo "built $BUNDLE_SERVICE for $ENV_NAME => $IMAGE"
  done
fi

print_manual_promote_hints() {
  local has_hint=0
  local color_reset=$'\033[0m'
  local color_title=$'\033[1;32m'
  local color_key=$'\033[1;32m'
  local color_note=$'\033[1;36m'
  local ci_name="${RELEASE_CI_NAME:-构建 ${BUNDLE_SERVICE}}"
  local display_name="${RELEASE_DISPLAY_NAME:-$BUNDLE_SERVICE}"
  local has_prod_hint=false
  if has_prod_promote_env; then
    has_prod_hint=true
  fi

  for ENV_NAME in "${ENVS[@]}"; do
    ENV_NAME="$(printf '%s' "$ENV_NAME" | xargs)"
    if [[ -z "$ENV_NAME" ]]; then
      continue
    fi
    local image_file="$BUILT_IMAGE_DIR/$ENV_NAME"
    if [[ ! -s "$image_file" ]]; then
      continue
    fi
    local image
    image="$(<"$image_file")"
    if [[ "$has_hint" -eq 0 ]]; then
      echo
      echo "${color_title}============================================================${color_reset}"
      echo "${color_title}可发布版本汇总${color_reset}"
      echo "${color_title}============================================================${color_reset}"
      if [[ "$has_prod_hint" == true ]]; then
        echo "${color_note}发布产物已生成：构建 CI 会在人工确认后自动 promote 正式环境；也可复制正式环境参数手动 promote。${color_reset}"
        echo "${color_note}说明：北京沙箱会继续走 auto-pin；正式环境默认等待人工确认后创建 GitOps promote。${color_reset}"
      else
        echo "${color_note}发布产物已生成：当前构建没有待人工确认的正式环境 promote。${color_reset}"
        echo "${color_note}说明：北京沙箱 / playground 按 auto-pin 或对应环境策略推进，不展示生产审批后续。${color_reset}"
      fi
      has_hint=1
    fi
    echo "${color_title}============================================================${color_reset}"
    echo "${color_key}可发布版本：${color_reset}${display_name} -> ${ENV_NAME}"
    echo "${color_key}CI：${color_reset}${ci_name}"
    echo "${color_key}PIPELINE_MODE=promote${color_reset}"
    echo "${color_key}TARGET_ENV=${ENV_NAME}${color_reset}"
    echo "${color_key}SOURCE_SHA=${SOURCE_REF}${color_reset}"
    echo "${color_key}镜像 tag：${color_reset}${TAG}"
    echo "${color_key}镜像：${color_reset}${image}"
    if csv_contains "$AUTO_PIN_ENVS" "$ENV_NAME"; then
      echo "${color_key}发布方式：${color_reset}auto-pin，本次构建会自动创建对应 GitOps promote。"
    else
      echo "${color_note}本地等价命令：REMOTE_URL=\"\$(ci_gitops_remote_url)\" GITOPS_BRANCH=gitops bash .ci/runtime/promote_bundle_image_to_gitops.sh ${BUNDLE_SERVICE} ${PIN_TARGETS} ${ENV_NAME} ${SOURCE_REF}${color_reset}"
      echo "${color_key}手动触发参数:${color_reset} PIPELINE_MODE=promote TARGET_ENV=${ENV_NAME} SOURCE_SHA=${SOURCE_REF}"
    fi
    if is_prod_env "$ENV_NAME"; then
      echo "${color_key}DB 变更先执行 CI：${color_reset}生产 DB migration"
      echo "${color_key}DB 变更参数:${color_reset} SERVICE=${BUNDLE_SERVICE} TARGET_ENV=${ENV_NAME} SOURCE_SHA=${SOURCE_REF} TIMEOUT_SECONDS=1800"
    elif is_beijing_sandbox_env "$ENV_NAME"; then
      echo "${color_key}北京沙箱 DB 变更过程：${color_reset}GitOps release gate 自动执行受控 DB job -> DB readiness 只读校验 -> 自动合并/收敛。"
      echo "${color_key}北京沙箱 DB 参数：${color_reset}无需生产 DB migration；看 promote 分支的 release gate 日志。"
    elif is_playground_env "$ENV_NAME"; then
      echo "${color_key}Playground 发布后续：${color_reset}无需生产人工审批；不展示生产 DB migration 参数。"
      echo "${color_key}Playground DB 提示：${color_reset}按 playground 环境的 GitOps/bootstrap 流程处理，不走生产 DB migration CI。"
    else
      echo "${color_key}DB 变更提示：${color_reset}当前环境没有专用 DB migration 参数提示；以 release gate 日志为准。"
    fi
    echo "${color_title}------------------------------------------------------------${color_reset}"
  done
}

if [[ "$AUTO_PIN_ONLY" != "true" ]]; then
  print_manual_promote_hints
fi

if [[ "$BUILD_ONLY" == "true" ]]; then
  echo "build-only mode: images persisted under $BUILT_IMAGE_DIR; skip GitOps auto-pin"
  exit 0
fi

if [[ "$AUTO_PIN_ENVS" == "none" ]]; then
  exit 0
fi

if [[ "$AUTO_PIN_ONLY" == "true" ]]; then
  echo "============================================================"
  echo "北京测试 DB 变更检查 / GitOps auto-pin 独立步骤"
  echo "bundle=${BUNDLE_SERVICE}"
  echo "pin_targets=${PIN_TARGETS}"
  echo "source_ref=${SOURCE_REF}"
  echo "image_dir=${BUILT_IMAGE_DIR}"
  echo "auto_pin_envs=${AUTO_PIN_ENVS}"
  echo "说明：本步骤按环境执行 release gate；若该环境 DB contract 要求 migration，将在这里执行受控 DB job，再执行 DB readiness。"
  echo "============================================================"
fi

prepare_pin_runtime_snapshot

IFS=',' read -r -a AUTO_ENVS <<<"$AUTO_PIN_ENVS"
for AUTO_PIN_ENV in "${AUTO_ENVS[@]}"; do
  AUTO_PIN_ENV="$(printf '%s' "$AUTO_PIN_ENV" | xargs)"
  if [[ -z "$AUTO_PIN_ENV" ]]; then
    continue
  fi
  AUTO_IMAGE_FILE="$BUILT_IMAGE_DIR/$AUTO_PIN_ENV"
  if [[ ! -s "$AUTO_IMAGE_FILE" ]]; then
    echo "auto pin env $AUTO_PIN_ENV was not built" >&2
    exit 1
  fi
  AUTO_IMAGE="$(<"$AUTO_IMAGE_FILE")"

  if [[ "$AUTO_PIN_ONLY" == "true" ]]; then
    echo "============================================================"
    echo "环境级 DB 变更检查：${AUTO_PIN_ENV}"
    echo "服务：${BUNDLE_SERVICE}"
    echo "镜像：${AUTO_IMAGE}"
    echo "下一步：运行 image gate -> config gate -> DB migration/readiness gate -> GitOps auto-pin"
    echo "============================================================"
  fi

  DEPLOYED_AT="$DEPLOYED_AT" bash "$PIN_SCRIPT" "$BUNDLE_SERVICE" "$PIN_TARGETS" "$AUTO_PIN_ENV" "$AUTO_IMAGE" "$SOURCE_REF"
done
