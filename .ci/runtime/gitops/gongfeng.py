"""Shared Gongfeng API helpers for CI runtime scripts."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from argparse import Namespace
from pathlib import Path
from typing import Any, Mapping


def env_int(name: str) -> int | None:
    value = os.environ.get(name, "").strip()
    return int(value) if value else None


def require_settings(
    api_base: str | None,
    project_id: int | None,
    repo_path: str | None = None,
    *,
    require_repo_path: bool = False,
) -> None:
    missing = []
    if not api_base:
        missing.append("GIT_WOA_API_BASE or --api-base")
    if project_id is None:
        missing.append("GITOPS_PROJECT_ID or --project-id")
    if require_repo_path and not repo_path:
        missing.append("GITOPS_REPO_PATH or --repo-path")
    if missing:
        raise RuntimeError("missing Gongfeng settings: " + ", ".join(missing))


def require_settings_from_args(args: Namespace, *, require_repo_path: bool = False) -> None:
    require_settings(
        getattr(args, "api_base", None),
        getattr(args, "project_id", None),
        getattr(args, "repo_path", None),
        require_repo_path=require_repo_path,
    )


def resolve_private_token(
    private_token: str | None = None,
    private_token_file: str = "/etc/lightclaw-ci/git_woa_private_token",
) -> str:
    if private_token:
        return private_token.strip()

    try:
        token = Path(private_token_file).read_text().strip()
        if token:
            return token
    except FileNotFoundError:
        pass

    env_token = os.environ.get("GIT_WOA_PRIVATE_TOKEN", "").strip()
    if env_token:
        return env_token

    raise RuntimeError(
        "missing Git WOA token; provide --private-token, ensure %s exists, or set GIT_WOA_PRIVATE_TOKEN"
        % private_token_file
    )


def resolve_private_token_from_args(args: Namespace) -> str:
    return resolve_private_token(
        getattr(args, "private_token", None),
        getattr(args, "private_token_file", "/etc/lightclaw-ci/git_woa_private_token"),
    )


def api_text_request(
    method: str,
    url: str,
    private_token: str,
    form_data: Mapping[str, Any] | None = None,
) -> str:
    headers = {"PRIVATE-TOKEN": private_token}
    data = None
    if form_data is not None:
        data = urllib.parse.urlencode(form_data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode()


def api_json_request(
    method: str,
    url: str,
    private_token: str,
    form_data: Mapping[str, Any] | None = None,
) -> Any:
    payload = api_text_request(method, url, private_token, form_data)
    return json.loads(payload) if payload else None


def merge_requests_url(api_base: str, project_id: int, **params: str) -> str:
    query = urllib.parse.urlencode(params)
    return f"{api_base}/projects/{project_id}/merge_requests?{query}"


def create_merge_request_url(api_base: str, project_id: int) -> str:
    return f"{api_base}/projects/{project_id}/merge_requests"


def merge_request_note_url(api_base: str, project_id: int, mr_id: int) -> str:
    return f"{api_base}/projects/{project_id}/merge_requests/{mr_id}/notes"


def merge_request_merge_url(api_base: str, project_id: int, mr_id: int) -> str:
    # Gongfeng currently exposes the merge endpoint under singular merge_request.
    return f"{api_base}/projects/{project_id}/merge_request/{mr_id}/merge"


def branch_url(api_base: str, project_id: int, branch: str) -> str:
    encoded_branch = urllib.parse.quote(branch, safe="")
    return f"{api_base}/projects/{project_id}/repository/branches/{encoded_branch}"
