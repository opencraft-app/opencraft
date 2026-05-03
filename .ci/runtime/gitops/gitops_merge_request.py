"""
Create or reuse a GitOps merge request, with optional auto-merge polling.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from gitops.gongfeng import (
    api_json_request,
    create_merge_request_url,
    env_int,
    merge_request_merge_url,
    merge_request_note_url,
    merge_requests_url,
    require_settings_from_args,
    resolve_private_token_from_args,
)
from gitops.release_facts import release_facts_from_mapping, trailers_from_git
from gitops.release_view import render_merge_waiting_note, render_merged_note


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create or reuse a GitOps MR and optionally auto-merge it.")
    parser.add_argument("--api-base", default=os.environ.get("GIT_WOA_API_BASE"))
    parser.add_argument("--project-id", type=int, default=env_int("GITOPS_PROJECT_ID"))
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--repo-path", default=os.environ.get("GITOPS_REPO_PATH"))
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    parser.add_argument("--title", required=True)
    parser.add_argument("--description", required=True)
    parser.add_argument("--auto-merge", action="store_true")
    parser.add_argument("--auto-merge-timeout-seconds", type=int, default=300)
    parser.add_argument("--auto-merge-poll-seconds", type=int, default=5)
    parser.add_argument("--remove-source-branch", action="store_true")
    parser.add_argument("--format", choices=("json", "dotenv"), default="dotenv")
    return parser.parse_args()


def require_gongfeng_settings(args: argparse.Namespace) -> None:
    require_settings_from_args(args, require_repo_path=True)


def resolve_private_token(args: argparse.Namespace) -> str:
    return resolve_private_token_from_args(args)


def list_merge_requests(args: argparse.Namespace, state: str) -> List[Dict[str, Any]]:
    url = merge_requests_url(
        args.api_base,
        args.project_id,
        state=state,
        source_branch=args.source_branch,
        target_branch=args.target_branch,
    )
    return api_json_request("GET", url, args.private_token)


def create_merge_request(args: argparse.Namespace) -> Dict[str, Any]:
    url = create_merge_request_url(args.api_base, args.project_id)
    payload = {
        "source_branch": args.source_branch,
        "target_branch": args.target_branch,
        "title": args.title,
        "description": args.description,
    }
    if args.remove_source_branch and not args.auto_merge:
        payload["remove_source_branch"] = "true"
    return api_json_request(
        "POST",
        url,
        args.private_token,
        payload,
    )


def post_merge_request_note(args: argparse.Namespace, mr: Dict[str, Any], body: str) -> Dict[str, Any]:
    url = merge_request_note_url(args.api_base, args.project_id, mr["id"])
    return api_json_request("POST", url, args.private_token, {"body": body})


def ensure_merge_request(args: argparse.Namespace) -> Dict[str, Any]:
    existing = list_merge_requests(args, "opened")
    if existing:
        return existing[0]
    return create_merge_request(args)


def refresh_merge_request(args: argparse.Namespace) -> Dict[str, Any]:
    current = list_merge_requests(args, "opened")
    if current:
        return current[0]

    merged = list_merge_requests(args, "merged")
    if merged:
        return merged[0]

    raise RuntimeError(
        "merge request disappeared while waiting for auto-merge "
        "(source_branch=%s target_branch=%s)" % (args.source_branch, args.target_branch)
    )


def merge_merge_request(args: argparse.Namespace, mr: Dict[str, Any]) -> Dict[str, Any]:
    url = merge_request_merge_url(args.api_base, args.project_id, mr["id"])
    payload = {}  # type: Dict[str, Any]
    if args.remove_source_branch and not args.auto_merge:
        payload["should_remove_source_branch"] = "true"
    return api_json_request("PUT", url, args.private_token, payload or None)


def is_auto_mergeable(mr: Dict[str, Any]) -> bool:
    commit_state = mr.get("commit_check_state")
    commit_block = mr.get("commit_check_block")
    merge_status = mr.get("merge_status")
    if commit_block:
        return False
    if merge_status != "can_be_merged":
        return False
    return commit_state in (None, "", "success")


def next_stage_after_merge(source_branch: str) -> str:
    if source_branch.startswith("promote-shprod-"):
        return "- 下一阶段：上海生产进入待同步状态；人工确认 DB readiness 后执行 Argo sync"
    return "- 下一阶段：等待 Argo CD 收敛并校验 live workload image"


def maybe_auto_merge(args: argparse.Namespace, mr: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    if not args.auto_merge:
        return mr, None
    try:
        facts = trailers_from_git(Path.cwd())
    except Exception:  # noqa: BLE001
        facts = release_facts_from_mapping({})

    post_merge_request_note(
        args,
        mr,
        render_merge_waiting_note(facts, mr, args.source_branch, args.target_branch),
    )

    deadline = time.time() + args.auto_merge_timeout_seconds
    latest = mr
    while time.time() < deadline:
        latest = refresh_merge_request(args)
        commit_state = latest.get("commit_check_state")
        commit_block = latest.get("commit_check_block")
        merge_status = latest.get("merge_status")
        print(
            f"auto-merge poll: mr_iid={latest.get('iid')} state={latest.get('state')} "
            f"commit_check_state={commit_state} commit_check_block={commit_block} "
            f"merge_status={merge_status}",
            file=sys.stderr,
        )
        if latest.get("state") == "merged":
            post_merge_request_note(
                args,
                latest,
                render_merged_note(facts, latest, args.source_branch, args.target_branch),
            )
            return latest, {"merged_by_platform": True}
        if is_auto_mergeable(latest):
            merged = merge_merge_request(args, latest)
            post_merge_request_note(
                args,
                latest,
                render_merged_note(facts, latest, args.source_branch, args.target_branch).replace("MR 已合并", "MR 已执行合并"),
            )
            return latest, merged
        if commit_state == "failure":
            raise RuntimeError(
                f"mr {latest.get('iid')} commit check failed before auto-merge "
                f"(merge_status={merge_status}, commit_check_block={commit_block})"
            )
        time.sleep(args.auto_merge_poll_seconds)

    raise RuntimeError(
        f"timed out waiting for mr {latest.get('iid')} to become auto-mergeable "
        f"(last_state={latest.get('commit_check_state')}, "
        f"commit_check_block={latest.get('commit_check_block')}, "
        f"merge_status={latest.get('merge_status')})"
    )


def emit(args: argparse.Namespace, mr: Dict[str, Any], merge_result: Optional[Dict[str, Any]]) -> None:
    mr_url = f"https://git.woa.com/{args.repo_path}/-/merge_requests/{mr['iid']}"
    payload = {
        "mr_id": mr["id"],
        "mr_iid": mr["iid"],
        "mr_url": mr_url,
        "source_branch": mr["source_branch"],
        "target_branch": mr["target_branch"],
        "merge_status": mr.get("merge_status"),
        "commit_check_state": mr.get("commit_check_state"),
        "commit_check_block": mr.get("commit_check_block"),
        "auto_merge_result": merge_result,
    }
    if args.format == "json":
        print(json.dumps(payload))
        return

    print(f"MR_ID={mr['id']}")
    print(f"MR_IID={mr['iid']}")
    print(f"MR_URL={mr_url}")
    print(f"MR_SOURCE_BRANCH={mr['source_branch']}")
    print(f"MR_TARGET_BRANCH={mr['target_branch']}")
    print(f"MR_MERGE_STATUS={mr.get('merge_status')}")
    print(f"MR_COMMIT_CHECK_STATE={mr.get('commit_check_state')}")
    print(f"MR_COMMIT_CHECK_BLOCK={str(bool(mr.get('commit_check_block'))).lower()}")
    print(f"MR_AUTO_MERGE_APPLIED={str(bool(merge_result)).lower()}")


def main() -> int:
    args = parse_args()
    require_gongfeng_settings(args)
    args.private_token = resolve_private_token(args)
    mr = ensure_merge_request(args)
    merge_result = None
    if args.auto_merge:
        mr, merge_result = maybe_auto_merge(args, mr)
    emit(args, mr, merge_result)
    return 0
