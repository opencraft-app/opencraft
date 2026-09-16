#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <plan|apply> <source-sha> <image-digest> <timeout-seconds>" >&2
  exit 2
fi

mode="$1"
source_sha="$2"
image="$3"
timeout_seconds="$4"

case "$mode" in
  plan|apply) ;;
  *) echo "mode must be plan or apply" >&2; exit 2 ;;
esac
if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "source SHA must be a full lowercase commit hash" >&2
  exit 2
fi
if [[ ! "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "Collaboration recovery image must be pinned by sha256 digest" >&2
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "timeout seconds must be a positive integer" >&2
  exit 2
fi

source .ci/init.sh
ci_init_repo_root
ci_ensure_db_job_tools
ci_require_commands git python3

deploy_root="$(mktemp -d)"
rmdir "$deploy_root"
cleanup() {
  if [[ -n "$deploy_root" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$deploy_root" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

git fetch origin gitops
git -C "$REPO_ROOT" worktree add --detach "$deploy_root" origin/gitops

run_recovery_job() {
  local operation="$1"
  python3 .ci/runtime/commands/run_gitops_db_job.py \
    --repo-root "$REPO_ROOT" \
    --deploy-root "$deploy_root" \
    --service collaboration \
    --operation "$operation" \
    --env beijing-sandbox \
    --revision "$source_sha" \
    --image-override "$image" \
    --apply --wait \
    --timeout-seconds "$timeout_seconds"
}

if [[ "$mode" == "plan" ]]; then
  run_recovery_job recovery-plan
  exit 0
fi

run_recovery_job recovery-apply
run_recovery_job recovery-plan
