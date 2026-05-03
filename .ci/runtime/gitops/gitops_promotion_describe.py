"""Read-only diagnostic view for a GitOps promotion."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import urllib.error
from pathlib import Path
from typing import Any

from gitops.argocd import login as login_argocd
from gitops.argocd import resolve_settings as resolve_argocd_settings
from gitops.gitops_release_verifier import (
    argocd_get_application,
    changed_files_from_merge_commit,
    expected_images_for_target,
    infer_release_targets,
)
from gitops.gongfeng import (
    api_json_request,
    env_int,
    merge_requests_url,
    require_settings_from_args,
    resolve_private_token_from_args,
)
from gitops.release_facts import trailers_from_git
from gitops.release_view import render_release_view


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Describe a GitOps promotion without mutating state.")
    parser.add_argument("--api-base", default=os.environ.get("GIT_WOA_API_BASE"))
    parser.add_argument("--project-id", type=int, default=env_int("GITOPS_PROJECT_ID"))
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--argocd-base-url")
    parser.add_argument("--argocd-username")
    parser.add_argument("--argocd-password")
    parser.add_argument("--argocd-insecure-skip-verify", action="store_true")
    parser.add_argument("--skip-argocd", action="store_true")
    return parser.parse_args()


def git_output(repo_root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo_root), *args], text=True).strip()


def resolve_source_ref(repo_root: Path, source_branch: str) -> str:
    candidates = [source_branch, f"origin/{source_branch}"]
    for candidate in candidates:
        try:
            return git_output(repo_root, "rev-parse", candidate)
        except subprocess.CalledProcessError:
            continue
    subprocess.run(["git", "-C", str(repo_root), "fetch", "origin", source_branch], check=False)
    return git_output(repo_root, "rev-parse", f"FETCH_HEAD")


def list_merge_requests(args: argparse.Namespace, private_token: str, state: str) -> list[dict[str, Any]]:
    url = merge_requests_url(
        args.api_base,
        args.project_id,
        state=state,
        source_branch=args.source_branch,
        target_branch=args.target_branch,
    )
    return api_json_request("GET", url, private_token)


def resolve_mr(args: argparse.Namespace, private_token: str) -> dict[str, Any] | None:
    for state in ("opened", "merged"):
        merge_requests = list_merge_requests(args, private_token, state)
        if merge_requests:
            return merge_requests[0]
    return None


def argo_snapshots(args: argparse.Namespace, targets: list[Any], expected_by_app: dict[str, list[str]]) -> list[dict[str, Any]]:
    if args.skip_argocd or not targets:
        return []
    base_url, username, password, ssl_context = resolve_argocd_settings(args)
    token = login_argocd(base_url, username, password, ssl_context)
    snapshots = []
    for target in targets:
        app = argocd_get_application(base_url, ssl_context, token, target.app_name)
        status = app.get("status", {})
        sync = status.get("sync", {})
        health = status.get("health", {})
        summary = status.get("summary", {})
        snapshots.append(
            {
                "app_name": target.app_name,
                "revision": sync.get("revision", ""),
                "sync_status": sync.get("status", ""),
                "health_status": health.get("status", ""),
                "images": sorted(summary.get("images") or []),
                "expected_images": expected_by_app.get(target.app_name, []),
            }
        )
    return snapshots


def main() -> int:
    args = parse_args()
    require_settings_from_args(args)
    repo_root = Path(args.repo_root).resolve()
    private_token = resolve_private_token_from_args(args)
    source_ref = resolve_source_ref(repo_root, args.source_branch)
    facts = trailers_from_git(repo_root, source_ref)
    mr = resolve_mr(args, private_token)
    targets = []
    expected_by_app: dict[str, list[str]] = {}
    snapshots: list[dict[str, Any]] = []

    if mr and mr.get("merge_commit_sha"):
        changed_files = changed_files_from_merge_commit(repo_root, mr["merge_commit_sha"], args.target_branch)
        targets = infer_release_targets(changed_files)
        for target in targets:
            try:
                expected_by_app[target.app_name] = expected_images_for_target(repo_root, target)
            except RuntimeError as exc:
                expected_by_app[target.app_name] = [f"expected image unavailable: {exc}"]
        try:
            snapshots = argo_snapshots(args, targets, expected_by_app)
        except (RuntimeError, urllib.error.URLError) as exc:
            print(f"skip Argo snapshot in describe mode: {exc}", file=sys.stderr)

    print(
        render_release_view(
            headline="GitOps 发布诊断：当前 release view",
            facts=facts,
            mr=mr,
            source_branch=args.source_branch,
            target_branch=args.target_branch,
            targets=targets,
            argo_results=snapshots,
            next_action="根据 MR、门禁和 Argo 状态定位当前卡点；本命令不执行合并、清理或 sync。",
        )
    )
    return 0
