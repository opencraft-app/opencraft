#!/usr/bin/env python3
"""Safely migrate one running legacy-gateway Bot to VelaGW."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, TextIO


USER_ID_RE = re.compile(r"^usr_[0-9A-Za-z]+$")
INSTANCE_ID_RE = re.compile(r"^ins[-_][0-9A-Za-z]+$")


class APIError(RuntimeError):
    pass


class SafetyError(RuntimeError):
    pass


def _response_data(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise APIError("response is not a JSON object")
    if payload.get("success") is False:
        raise APIError(str(payload.get("message") or payload.get("error") or "request failed")[:500])
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    raise APIError("response does not contain an object data field")


def _post(
    base_url: str,
    token: str,
    path: str,
    body: dict[str, Any],
    *,
    opener: Callable[..., Any],
    timeout: float,
) -> dict[str, Any]:
    encoded = json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(base_url.rstrip("/") + path, data=encoded, method="POST")
    request.add_header("Authorization", "Bearer " + token)
    request.add_header("Content-Type", "application/json")
    request.add_header("Accept", "application/json")
    try:
        with opener(request, timeout=timeout) as response:
            return _response_data(json.loads(response.read().decode()))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        raise APIError(f"HTTP {exc.code}: {raw[:500]}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise APIError(str(exc)[:500]) from exc


def _public_result(data: dict[str, Any], phase: str) -> dict[str, Any]:
    result = {"phase": phase, "status": "ok"}
    for key in (
        "user_id",
        "instance_id",
        "previous_gateway",
        "target_gateway",
        "dry_run",
        "migrated",
        "already_migrated",
        "key_id",
        "key_prefix",
        "legacy_key_revoked",
    ):
        if key in data:
            result[key] = data[key]
    return result


def _validate_target(data: dict[str, Any], user_id: str, instance_id: str) -> None:
    if data.get("user_id") != user_id or data.get("instance_id") != instance_id:
        raise SafetyError("server response target does not match requested user and instance")


def run_migration(
    ctl_base_url: str,
    token: str,
    user_id: str,
    instance_id: str,
    *,
    execute: bool,
    confirm_user_id: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    output: TextIO = sys.stdout,
    timeout: float = 180,
) -> int:
    ctl_base_url = ctl_base_url.strip()
    token = token.strip()
    user_id = user_id.strip()
    instance_id = instance_id.strip()
    if not ctl_base_url or not token:
        raise ValueError("CTL_INTERNAL_BASE_URL and LIGHTCLAW_INTERNAL_SERVICE_TOKEN are required")
    if not USER_ID_RE.fullmatch(user_id):
        raise ValueError("invalid user ID")
    if not INSTANCE_ID_RE.fullmatch(instance_id):
        raise ValueError("invalid instance ID")
    if execute and confirm_user_id.strip() != user_id:
        raise ValueError("confirmation user ID must exactly match --user-id")

    path = "/internal/instances/" + urllib.parse.quote(instance_id, safe="") + "/gateway/migrate"
    dry_run = _post(
        ctl_base_url,
        token,
        path,
        {"user_id": user_id, "dry_run": True},
        opener=opener,
        timeout=timeout,
    )
    _validate_target(dry_run, user_id, instance_id)
    print(json.dumps(_public_result(dry_run, "preflight"), separators=(",", ":")), file=output, flush=True)
    if not execute:
        return 0

    migrated = _post(
        ctl_base_url,
        token,
        path,
        {"user_id": user_id, "dry_run": False},
        opener=opener,
        timeout=timeout,
    )
    _validate_target(migrated, user_id, instance_id)
    if not migrated.get("migrated") and not migrated.get("already_migrated"):
        raise SafetyError("migration response did not confirm a completed migration")
    print(json.dumps(_public_result(migrated, "execute"), separators=(",", ":")), file=output, flush=True)
    return 0 if migrated.get("legacy_key_revoked", True) else 2


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--ctl-base-url", default=os.getenv("CTL_INTERNAL_BASE_URL", ""))
    parser.add_argument("--execute", action="store_true", help="Run the migration after a successful preflight")
    parser.add_argument("--confirm-user-id", default="", help="Must equal --user-id when --execute is used")
    parser.add_argument("--timeout", type=float, default=180)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", "")
    try:
        return run_migration(
            args.ctl_base_url,
            token,
            args.user_id,
            args.instance_id,
            execute=args.execute,
            confirm_user_id=args.confirm_user_id,
            timeout=args.timeout,
        )
    except (ValueError, APIError, SafetyError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:500]}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

