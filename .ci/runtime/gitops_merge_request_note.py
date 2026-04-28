#!/usr/bin/env python3
"""
Post a note to a GitOps merge request.
"""

from __future__ import annotations

import argparse
import os
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Post a note to a GitOps merge request.")
    parser.add_argument("--api-base", default=os.environ.get("GIT_WOA_API_BASE"))
    parser.add_argument("--project-id", type=int, default=env_int("GITOPS_PROJECT_ID"))
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--mr-id", required=True, type=int)
    parser.add_argument("--body", required=True)
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
    return payload


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


def main() -> int:
    args = parse_args()
    require_gongfeng_settings(args)
    private_token = resolve_private_token(args)
    url = f"{args.api_base}/projects/{args.project_id}/merge_requests/{args.mr_id}/notes"
    api_request("POST", url, private_token, {"body": args.body})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
