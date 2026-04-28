#!/usr/bin/env python3
"""
Create or reuse a GitOps merge request, with optional auto-merge polling.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple


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


def env_int(name: str) -> int | None:
    value = os.environ.get(name, "").strip()
    return int(value) if value else None


def require_gongfeng_settings(args: argparse.Namespace) -> None:
    missing = []
    if not args.api_base:
        missing.append("GIT_WOA_API_BASE or --api-base")
    if args.project_id is None:
        missing.append("GITOPS_PROJECT_ID or --project-id")
    if not args.repo_path:
        missing.append("GITOPS_REPO_PATH or --repo-path")
    if missing:
        raise RuntimeError("missing Gongfeng settings: " + ", ".join(missing))


def api_request(method: str, url: str, private_token: str, form_data: Optional[Dict[str, Any]] = None) -> Any:
    headers = {"PRIVATE-TOKEN": private_token}
    data = None
    if form_data is not None:
        data = urllib.parse.urlencode(form_data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        payload = resp.read().decode()
    return json.loads(payload) if payload else None


def resolve_private_token(args: argparse.Namespace) -> str:
    if args.private_token:
        return args.private_token.strip()

    try:
        with open(args.private_token_file, "r") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        pass

    env_token = os.environ.get("GIT_WOA_PRIVATE_TOKEN", "").strip()
    if env_token:
        return env_token

    raise RuntimeError(
        "missing Git WOA token; provide --private-token, ensure %s exists, or set GIT_WOA_PRIVATE_TOKEN"
        % args.private_token_file
    )


def list_merge_requests(args: argparse.Namespace, state: str) -> List[Dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "state": state,
            "source_branch": args.source_branch,
            "target_branch": args.target_branch,
        }
    )
    url = f"{args.api_base}/projects/{args.project_id}/merge_requests?{params}"
    return api_request("GET", url, args.private_token)


def create_merge_request(args: argparse.Namespace) -> Dict[str, Any]:
    url = f"{args.api_base}/projects/{args.project_id}/merge_requests"
    payload = {
        "source_branch": args.source_branch,
        "target_branch": args.target_branch,
        "title": args.title,
        "description": args.description,
    }
    if args.remove_source_branch and not args.auto_merge:
        payload["remove_source_branch"] = "true"
    return api_request(
        "POST",
        url,
        args.private_token,
        payload,
    )


def post_merge_request_note(args: argparse.Namespace, mr: Dict[str, Any], body: str) -> Dict[str, Any]:
    url = f"{args.api_base}/projects/{args.project_id}/merge_requests/{mr['id']}/notes"
    return api_request("POST", url, args.private_token, {"body": body})


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
    url = f"{args.api_base}/projects/{args.project_id}/merge_request/{mr['id']}/merge"
    payload = {}  # type: Dict[str, Any]
    if args.remove_source_branch and not args.auto_merge:
        payload["should_remove_source_branch"] = "true"
    return api_request("PUT", url, args.private_token, payload or None)


def maybe_auto_merge(args: argparse.Namespace, mr: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    if not args.auto_merge:
        return mr, None

    post_merge_request_note(
        args,
        mr,
        "\n".join(
            [
                "自动发布进度：已进入 GitOps MR 自动合并阶段。",
                "",
                f"- source branch: `{args.source_branch}`",
                f"- target branch: `{args.target_branch}`",
                "- 状态：等待 commit checks 通过并满足 auto-merge 条件",
            ]
        ),
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
                "\n".join(
                    [
                        "自动发布进度：GitOps MR 已合并。",
                        "",
                        f"- source branch: `{args.source_branch}`",
                        f"- target branch: `{args.target_branch}`",
                        "- 下一阶段：等待 Argo CD 收敛并校验 live workload image",
                    ]
                ),
            )
            return latest, {"merged_by_platform": True}
        if commit_state == "success" and not commit_block and merge_status == "can_be_merged":
            merged = merge_merge_request(args, latest)
            post_merge_request_note(
                args,
                latest,
                "\n".join(
                    [
                        "自动发布进度：GitOps MR 已执行合并。",
                        "",
                        f"- source branch: `{args.source_branch}`",
                        f"- target branch: `{args.target_branch}`",
                        "- 下一阶段：等待 Argo CD 收敛并校验 live workload image",
                    ]
                ),
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


if __name__ == "__main__":
    raise SystemExit(main())
