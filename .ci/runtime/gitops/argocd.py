"""Shared Argo CD API and settings helpers for CI runtime scripts."""

from __future__ import annotations

import json
import os
import ssl
import urllib.request
from argparse import Namespace
from pathlib import Path
from typing import Any, Mapping


def read_secret_value(path: str) -> str:
    return Path(path).read_text().strip()


def effective_string_setting(value: str | None) -> str:
    if not value:
        return ""
    value = value.strip()
    if value.startswith("${{") and value.endswith("}}"):
        return ""
    return value


def resolve_string_setting(
    cli_value: str | None,
    env_name: str,
    file_path: str,
    default: str = "",
) -> str:
    cli_value = effective_string_setting(cli_value)
    if cli_value:
        return cli_value

    env_value = effective_string_setting(os.environ.get(env_name))
    if env_value:
        return env_value

    file_candidate = Path(file_path)
    if file_candidate.is_file():
        file_value = effective_string_setting(read_secret_value(str(file_candidate)))
        if file_value:
            return file_value

    return effective_string_setting(default)


def resolve_bool_setting(cli_flag: bool, env_name: str, file_path: str, default: bool = False) -> bool:
    if cli_flag:
        return True

    env_value = os.environ.get(env_name, "").strip().lower()
    if env_value in {"1", "true", "yes", "on"}:
        return True
    if env_value in {"0", "false", "no", "off"}:
        return False

    file_candidate = Path(file_path)
    if file_candidate.is_file():
        file_value = read_secret_value(str(file_candidate)).strip().lower()
        if file_value in {"1", "true", "yes", "on"}:
            return True
        if file_value in {"0", "false", "no", "off"}:
            return False

    return default


def create_ssl_context(*, insecure_skip_verify: bool) -> ssl.SSLContext:
    if insecure_skip_verify:
        # Only enabled by the explicit Argo CD insecure-skip-verify setting for private CI endpoints.
        return ssl._create_unverified_context()  # nosemgrep: unverified-ssl-context
    return ssl.create_default_context()


def resolve_settings(args: Namespace) -> tuple[str, str, str, ssl.SSLContext]:
    base_url = resolve_string_setting(
        getattr(args, "argocd_base_url", None),
        "ARGOCD_BASE_URL",
        "/etc/lightclaw-ci/argocd_base_url",
        "https://argocd.lightclaw.tech",
    )
    username = resolve_string_setting(
        getattr(args, "argocd_username", None),
        "ARGOCD_USERNAME",
        "/etc/lightclaw-ci/argocd_username",
    )
    password = resolve_string_setting(
        getattr(args, "argocd_password", None),
        "ARGOCD_PASSWORD",
        "/etc/lightclaw-ci/argocd_password",
    )
    insecure_skip_verify = resolve_bool_setting(
        bool(getattr(args, "argocd_insecure_skip_verify", False)),
        "ARGOCD_INSECURE_SKIP_VERIFY",
        "/etc/lightclaw-ci/argocd_insecure_skip_verify",
        False,
    )

    if not username or not password:
        raise RuntimeError(
            "missing Argo CD credentials; provide --argocd-username/--argocd-password, "
            "set ARGOCD_USERNAME/ARGOCD_PASSWORD, or populate /etc/lightclaw-ci/argocd_username "
            "and /etc/lightclaw-ci/argocd_password"
        )

    ssl_context = create_ssl_context(insecure_skip_verify=insecure_skip_verify)
    return base_url.rstrip("/"), username, password, ssl_context


def api_request(
    method: str,
    url: str,
    ssl_context: ssl.SSLContext,
    token: str,
    form_data: Mapping[str, Any] | None = None,
) -> Any:
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if form_data is not None:
        data = json.dumps(form_data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=ssl_context) as resp:
        payload = resp.read().decode()
    return json.loads(payload) if payload else None


def login(base_url: str, username: str, password: str, ssl_context: ssl.SSLContext) -> str:
    req = urllib.request.Request(
        f"{base_url}/api/v1/session",
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ssl_context) as resp:
        payload = json.loads(resp.read().decode())
    token = payload.get("token", "").strip()
    if not token:
        raise RuntimeError("argo cd login succeeded but no token was returned")
    return token
