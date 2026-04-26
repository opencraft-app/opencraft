#!/usr/bin/env python3
"""
Delete a promote branch after its GitOps MR has been merged.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Delete a source branch after its GitOps MR is merged.")
    parser.add_argument("--api-base", default="https://git.woa.com/api/v3")
    parser.add_argument("--project-id", type=int, default=1731878)
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    parser.add_argument("--wait-seconds", type=int, default=120)
    parser.add_argument("--poll-seconds", type=int, default=5)
    return parser.parse_args()


def api_request(method: str, url: str, private_token: str) -> Any:
    headers = {"PRIVATE-TOKEN": private_token}
    req = urllib.request.Request(url, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        payload = resp.read().decode()
    return json.loads(payload) if payload else None


def resolve_private_token(args: argparse.Namespace) -> str:
    if args.private_token:
        return args.private_token.strip()

    env_token = os.environ.get("GIT_WOA_PRIVATE_TOKEN", "").strip()
    if env_token:
        return env_token

    try:
        with open(args.private_token_file, "r") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        raise RuntimeError(
            "missing Git WOA token; provide --private-token, set GIT_WOA_PRIVATE_TOKEN, or ensure %s exists"
            % args.private_token_file
        )


def list_merged_merge_requests(args: argparse.Namespace) -> List[Dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "state": "merged",
            "source_branch": args.source_branch,
            "target_branch": args.target_branch,
        }
    )
    url = f"{args.api_base}/projects/{args.project_id}/merge_requests?{params}"
    return api_request("GET", url, args.private_token)


def branch_exists(args: argparse.Namespace) -> bool:
    encoded_branch = urllib.parse.quote(args.source_branch, safe="")
    url = f"{args.api_base}/projects/{args.project_id}/repository/branches/{encoded_branch}"
    try:
        api_request("GET", url, args.private_token)
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        body = exc.read().decode(errors="replace")
        raise RuntimeError(
            "failed to query source branch %s: http=%s body=%s"
            % (args.source_branch, exc.code, body)
        )


def delete_branch(args: argparse.Namespace) -> None:
    encoded_branch = urllib.parse.quote(args.source_branch, safe="")
    url = f"{args.api_base}/projects/{args.project_id}/repository/branches/{encoded_branch}"
    print(
        "cleanup delete: source_branch=%s branch_exists_before=%s"
        % (args.source_branch, str(branch_exists(args)).lower()),
        file=sys.stderr,
    )
    try:
        api_request("DELETE", url, args.private_token)
        print("source branch delete request succeeded: %s" % args.source_branch, file=sys.stderr)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        if exc.code == 404:
            print("source branch already absent at delete time: %s" % args.source_branch, file=sys.stderr)
            return
        raise RuntimeError(
            "failed to delete source branch %s: http=%s body=%s"
            % (args.source_branch, exc.code, body)
        )
    print(
        "cleanup delete result: source_branch=%s branch_exists_after=%s"
        % (args.source_branch, str(branch_exists(args)).lower()),
        file=sys.stderr,
    )


def main() -> int:
    args = parse_args()
    args.private_token = resolve_private_token(args)
    deadline = time.time() + args.wait_seconds
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        merged = list_merged_merge_requests(args)
        if merged:
            mr = merged[0]
            print(
                "cleanup merge detected: attempt=%s source_branch=%s target_branch=%s mr_iid=%s resolved_at=%s merge_commit_sha=%s"
                % (
                    attempt,
                    args.source_branch,
                    args.target_branch,
                    mr.get("iid"),
                    mr.get("resolved_at"),
                    mr.get("merge_commit_sha"),
                ),
                file=sys.stderr,
            )
            delete_branch(args)
            return 0
        print(
            "cleanup poll: attempt=%s source_branch=%s target_branch=%s merged_mr_found=false branch_exists=%s"
            % (
                attempt,
                args.source_branch,
                args.target_branch,
                str(branch_exists(args)).lower(),
            ),
            file=sys.stderr,
        )
        time.sleep(args.poll_seconds)

    print(
        "cleanup timeout: source_branch=%s target_branch=%s branch_left_intact=%s"
        % (args.source_branch, args.target_branch, str(branch_exists(args)).lower()),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
