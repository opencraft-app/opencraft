#!/usr/bin/env python3
"""
Post a note to a GitOps merge request.
"""

from __future__ import annotations

import argparse
import os

from harness_ci.gongfeng import (
    api_text_request,
    env_int,
    merge_request_note_url,
    require_settings_from_args,
    resolve_private_token_from_args,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Post a note to a GitOps merge request.")
    parser.add_argument("--api-base", default=os.environ.get("GIT_WOA_API_BASE"))
    parser.add_argument("--project-id", type=int, default=env_int("GITOPS_PROJECT_ID"))
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--mr-id", required=True, type=int)
    parser.add_argument("--body", required=True)
    return parser.parse_args()


def require_gongfeng_settings(args: argparse.Namespace) -> None:
    require_settings_from_args(args)


def resolve_private_token(args: argparse.Namespace) -> str:
    return resolve_private_token_from_args(args)


def main() -> int:
    args = parse_args()
    require_gongfeng_settings(args)
    private_token = resolve_private_token(args)
    url = merge_request_note_url(args.api_base, args.project_id, args.mr_id)
    api_text_request("POST", url, private_token, {"body": args.body})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
