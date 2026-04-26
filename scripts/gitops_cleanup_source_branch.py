#!/usr/bin/env python3
"""
Delete a promote branch after its GitOps MR has been merged.
"""

import argparse
import json
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
    parser.add_argument("--private-token", required=True)
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


def delete_branch(args: argparse.Namespace) -> None:
    encoded_branch = urllib.parse.quote(args.source_branch, safe="")
    url = f"{args.api_base}/projects/{args.project_id}/repository/branches/{encoded_branch}"
    try:
        api_request("DELETE", url, args.private_token)
        print("source branch deleted: %s" % args.source_branch)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        if exc.code == 404:
            print("source branch already absent: %s" % args.source_branch)
            return
        raise RuntimeError(
            "failed to delete source branch %s: http=%s body=%s"
            % (args.source_branch, exc.code, body)
        )


def main() -> int:
    args = parse_args()
    deadline = time.time() + args.wait_seconds
    while time.time() < deadline:
        merged = list_merged_merge_requests(args)
        if merged:
            delete_branch(args)
            return 0
        print(
            "cleanup poll: source_branch=%s target_branch=%s merged_mr_found=false"
            % (args.source_branch, args.target_branch),
            file=sys.stderr,
        )
        time.sleep(args.poll_seconds)

    print(
        "cleanup timeout: source_branch=%s target_branch=%s branch left intact"
        % (args.source_branch, args.target_branch),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
