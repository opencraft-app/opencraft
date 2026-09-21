#!/usr/bin/env python3
"""Read-only VelaGW quota reset preflight for a list of LightVela users."""

from __future__ import annotations

import argparse
import html
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO

import reset_velagw_user_quota as quota


def parse_user_ids(lines: Iterable[str]) -> tuple[list[str], list[str]]:
    valid: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for raw in lines:
        user_id = html.unescape(raw).replace("\\_", "_").split("#", 1)[0].strip()
        if not user_id or user_id in seen:
            continue
        seen.add(user_id)
        if quota.USER_ID_RE.fullmatch(user_id):
            valid.append(user_id)
        else:
            invalid.append(user_id)
    return valid, invalid


def _safe_error(error: Exception, token: str) -> str:
    message = str(error)[:500]
    return message.replace(token, "***") if token else message


def probe_legacy_gateway(
    base_url: str,
    token: str,
    user_id: str,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    timeout: float = 30,
) -> dict[str, Any]:
    path = "/api/internal/users/" + urllib.parse.quote(user_id, safe="") + "/subscriptions"
    request = urllib.request.Request(base_url.rstrip("/") + path, method="GET")
    request.add_header("Authorization", "Bearer " + token)
    request.add_header("Accept", "application/json")
    try:
        with opener(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return {"user_id": user_id, "gateway": "ai_gateway", "status": "not_resettable", "reason": "no active legacy subscription"}
        raw = exc.read().decode(errors="replace")
        raise quota.APIError(f"legacy HTTP {exc.code}: {raw[:500]}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise quota.APIError(f"legacy gateway: {str(exc)[:500]}") from exc
    if not isinstance(payload, dict):
        raise quota.APIError("legacy gateway response is not a JSON object")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise quota.SafetyError("legacy gateway response has no subscription data")
    # Legacy ai-gateway returns its internal user UUID in data.user_id. The
    # business user remains scoped by the request path and must not be compared
    # with that internal identifier.
    if str(data.get("status", "")).strip().lower() != "active":
        return {"user_id": user_id, "gateway": "ai_gateway", "status": "not_resettable", "reason": "legacy subscription is not active"}
    subscription_id = str(data.get("id", "")).strip()
    plan_id = str(data.get("plan_id", "")).strip()
    try:
        token_balance = int(data.get("token_balance"))
    except (TypeError, ValueError) as exc:
        raise quota.SafetyError("legacy token_balance is not an integer") from exc
    if not subscription_id or not plan_id or token_balance < 0:
        raise quota.SafetyError("legacy subscription is missing required fields")
    return {
        "user_id": user_id,
        "gateway": "ai_gateway",
        "status": "legacy_active",
        "subscription_id": subscription_id,
        "plan_id": plan_id,
        "token_balance": token_balance,
        "period_start": data.get("period_start"),
        "period_end": data.get("period_end"),
    }


def run_audit(
    base_url: str,
    token: str,
    user_ids: list[str],
    invalid_user_ids: list[str],
    *,
    legacy_base_url: str = "",
    legacy_token: str = "",
    opener: Callable[..., Any] = urllib.request.urlopen,
    output: TextIO = sys.stdout,
    timeout: float = 30,
) -> int:
    ready = 0
    legacy_active = 0
    not_resettable = 0
    failed = len(invalid_user_ids)
    for user_id in invalid_user_ids:
        print(json.dumps({
            "user_id": user_id,
            "status": "failed",
            "error": "invalid user ID",
        }, separators=(",", ":")), file=output, flush=True)

    for user_id in user_ids:
        row_output = io.StringIO()
        try:
            quota.run_reset(
                base_url,
                token,
                user_id,
                execute=False,
                confirm_user_id="",
                opener=opener,
                output=row_output,
                timeout=timeout,
            )
            row = json.loads(row_output.getvalue().splitlines()[-1])
            row["status"] = "ready"
            row["gateway"] = "llm_gateway"
            ready += 1
        except quota.SafetyError as exc:
            row = {
                "user_id": user_id,
                "status": "not_resettable",
                "reason": _safe_error(exc, token),
            }
            not_resettable += 1
        except quota.APIError as exc:
            can_probe_legacy = (
                legacy_base_url.strip()
                and legacy_token.strip()
                and "HTTP 404" in str(exc)
                and "resource row not found" in str(exc)
            )
            if can_probe_legacy:
                try:
                    row = probe_legacy_gateway(
                        legacy_base_url, legacy_token, user_id, opener=opener, timeout=timeout,
                    )
                    if row["status"] == "legacy_active":
                        legacy_active += 1
                    else:
                        not_resettable += 1
                except (quota.APIError, quota.SafetyError) as legacy_exc:
                    row = {
                        "user_id": user_id,
                        "status": "failed",
                        "error": _safe_error(legacy_exc, legacy_token),
                    }
                    failed += 1
            else:
                row = {
                    "user_id": user_id,
                    "status": "failed",
                    "error": _safe_error(exc, token),
                }
                failed += 1
        except (ValueError, json.JSONDecodeError) as exc:
            row = {"user_id": user_id, "status": "failed", "error": _safe_error(exc, token)}
            failed += 1
        print(json.dumps(row, separators=(",", ":")), file=output, flush=True)

    print(json.dumps({
        "status": "summary",
        "total": len(user_ids) + len(invalid_user_ids),
        "ready": ready,
        "legacy_active": legacy_active,
        "not_resettable": not_resettable,
        "failed": failed,
    }, separators=(",", ":")), file=output, flush=True)
    return 1 if failed else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="-", help="User ID file, or - for stdin")
    parser.add_argument("--base-url", default=os.getenv("VELAGW_ADMIN_BASE_URL", ""))
    parser.add_argument("--legacy-base-url", default=os.getenv("AI_GATEWAY_INTERNAL_BASE_URL", ""))
    parser.add_argument("--timeout", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.getenv("VELAGW_ADMIN_TOKEN", "").strip()
    legacy_token = os.getenv("AI_GATEWAY_INTERNAL_SERVICE_TOKEN", "").strip()
    if not args.base_url.strip() or not token:
        print(json.dumps({
            "status": "failed",
            "error": "VELAGW_ADMIN_BASE_URL and VELAGW_ADMIN_TOKEN are required",
        }, separators=(",", ":")), file=sys.stderr)
        return 1
    if args.input == "-":
        lines = sys.stdin
        user_ids, invalid = parse_user_ids(lines)
    else:
        try:
            with Path(args.input).open(encoding="utf-8") as handle:
                user_ids, invalid = parse_user_ids(handle)
        except OSError as exc:
            print(json.dumps({"status": "failed", "error": str(exc)[:500]}, separators=(",", ":")), file=sys.stderr)
            return 1
    if not user_ids and not invalid:
        print(json.dumps({"status": "failed", "error": "no user IDs supplied"}, separators=(",", ":")), file=sys.stderr)
        return 1
    return run_audit(
        args.base_url,
        token,
        user_ids,
        invalid,
        legacy_base_url=args.legacy_base_url,
        legacy_token=legacy_token,
        timeout=args.timeout,
    )


if __name__ == "__main__":
    raise SystemExit(main())
