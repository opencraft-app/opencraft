#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$RUNTIME_DIR/../.." && pwd)"
GITOPS_REF="${GITOPS_REF:-origin/gitops}"
GITOPS_WORKTREE="${GITOPS_WORKTREE:-}"

contains_write_arg=false
for arg in "$@"; do
  if [[ "$arg" == "--write" ]]; then
    contains_write_arg=true
    break
  fi
done

if [[ -n "$GITOPS_WORKTREE" ]]; then
  if [[ ! -d "$GITOPS_WORKTREE/.git" && ! -f "$GITOPS_WORKTREE/.git" ]]; then
    echo "ERROR: GITOPS_WORKTREE is not a git checkout: $GITOPS_WORKTREE" >&2
    exit 1
  fi
  exec python3 "$RUNTIME_DIR/commands/create_playground_environment.py" --repo-root "$GITOPS_WORKTREE" "$@"
fi

if [[ "$contains_write_arg" == "true" ]]; then
  cat >&2 <<'EOF'
ERROR: --write 需要一个持久 GitOps checkout，不能写到临时 worktree 后自动删除。

请先准备 GitOps worktree，再执行：
  git fetch origin gitops
  git worktree add -b codex/create-<sandbox-bj-N> /tmp/mono2-gitops-create origin/gitops
  GITOPS_WORKTREE=/tmp/mono2-gitops-create .ci/runtime/create_playground_from_gitops.sh --to-env <sandbox-bj-N> --write
EOF
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/mono2-gitops-playground.XXXXXX")"
cleanup() {
  git -C "$REPO_ROOT" worktree remove "$tmp_dir/gitops" --force >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "============================================================"
echo "Playground GitOps wrapper"
echo "说明：不能在 master 源码 checkout 里直接跑默认命令，因为 playground GitOps 模板只在 origin/gitops，不在 master。"
echo "动作：fetch origin gitops，并创建临时 GitOps worktree 作为 --repo-root。"
echo "GITOPS_REF=$GITOPS_REF"
echo "============================================================"

git -C "$REPO_ROOT" fetch origin gitops
git -C "$REPO_ROOT" worktree add --detach "$tmp_dir/gitops" "$GITOPS_REF" >/dev/null

python3 "$RUNTIME_DIR/commands/create_playground_environment.py" --repo-root "$tmp_dir/gitops" "$@"
