#!/usr/bin/env python3
"""Safely reset one VelaGW user's quota without changing its natural schedule."""

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


class APIError(RuntimeError):
    pass


class SafetyError(RuntimeError):
    pass


class Client:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        opener: Callable[..., Any],
        timeout: float,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.opener = opener
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        request = urllib.request.Request(self.base_url + path, data=encoded, method=method)
        request.add_header("Authorization", "Bearer " + self.token)
        request.add_header("Accept", "application/json")
        if encoded is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self.opener(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode(errors="replace")
            raise APIError(f"HTTP {exc.code}: {raw[:500]}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise APIError(str(exc)[:500]) from exc
        if not isinstance(payload, dict):
            raise APIError("response is not a JSON object")
        if payload.get("success") is False:
            raise APIError(str(payload.get("message") or payload.get("error") or "request failed")[:500])
        return payload.get("data", payload)


def _binding_values(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise SafetyError("user binding response is invalid")
    row = data.get("row", data)
    if not isinstance(row, dict):
        raise SafetyError("user binding row is invalid")
    values = row.get("values", row)
    if not isinstance(values, dict):
        raise SafetyError("user binding values are invalid")
    return values


def _as_list(data: Any, field: str) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get(field), list):
        return data[field]
    raise SafetyError(f"response does not contain a {field} list")


def _active_subscriptions(data: Any) -> list[dict[str, Any]]:
    active: list[dict[str, Any]] = []
    for item in _as_list(data, "items"):
        if not isinstance(item, dict):
            continue
        sub = item.get("subscription", item)
        if isinstance(sub, dict) and str(sub.get("status", "")).strip().lower() == "active":
            active.append(sub)
    return active


def _integer(value: Any, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise SafetyError(f"{name} is not an integer") from exc
    if result <= 0:
        raise SafetyError(f"{name} must be positive")
    return result


def _nonnegative_integer(value: Any, name: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as exc:
        raise SafetyError(f"{name} is not an integer") from exc
    if result < 0:
        raise SafetyError(f"{name} must not be negative")
    return result


def _subscriptions_path(set_id: str, upstream_user_id: int) -> str:
    return (
        "/_llmgateway_console/" + urllib.parse.quote(set_id, safe="")
        + "/api/subscription/admin/users/" + str(upstream_user_id) + "/subscriptions"
    )


def _load_target(client: Client, user_id: str) -> tuple[str, int, str, int, dict[str, Any]]:
    escaped_user = urllib.parse.quote(user_id, safe="")
    binding = _binding_values(client.request("GET", "/api/admin/resources/user_bindings/rows/" + escaped_user))
    set_id = str(binding.get("set_id", "")).strip()
    upstream_user_id = _integer(binding.get("upstream_user_id"), "upstream_user_id")
    business_plan_id = str(binding.get("last_plan_id", "")).strip()
    if not set_id or not business_plan_id:
        raise SafetyError("user binding is missing set_id or last_plan_id")

    mappings = _as_list(
        client.request("GET", "/api/plans/" + urllib.parse.quote(business_plan_id, safe="") + "/sets"),
        "items",
    )
    ready = [
        item for item in mappings
        if isinstance(item, dict)
        and str(item.get("set_id", "")).strip() == set_id
        and str(item.get("status", "")).strip().lower() == "ready"
    ]
    if len(ready) != 1:
        raise SafetyError("expected exactly one ready plan mapping for the user's set")
    upstream_plan_id = _integer(ready[0].get("upstream_plan_id"), "upstream_plan_id")

    active = _active_subscriptions(client.request("GET", _subscriptions_path(set_id, upstream_user_id)))
    matching = [sub for sub in active if _integer(sub.get("plan_id"), "plan_id") == upstream_plan_id]
    if len(active) != 1 or len(matching) != 1:
        raise SafetyError("expected exactly one active subscription and one matching plan")
    return set_id, upstream_user_id, business_plan_id, upstream_plan_id, matching[0]


def run_reset(
    base_url: str,
    token: str,
    user_id: str,
    *,
    execute: bool,
    confirm_user_id: str,
    opener: Callable[..., Any] = urllib.request.urlopen,
    output: TextIO = sys.stdout,
    timeout: float = 30,
) -> int:
    base_url = base_url.strip()
    token = token.strip()
    user_id = user_id.strip()
    if not base_url or not token:
        raise ValueError("VELAGW_ADMIN_BASE_URL and VELAGW_ADMIN_TOKEN are required")
    if not USER_ID_RE.fullmatch(user_id):
        raise ValueError("invalid user ID")
    if execute and confirm_user_id.strip() != user_id:
        raise ValueError("confirmation user ID must exactly match --user-id")

    client = Client(base_url, token, opener=opener, timeout=timeout)
    set_id, upstream_user_id, business_plan_id, upstream_plan_id, before = _load_target(client, user_id)
    subscription_id = _integer(before.get("id"), "subscription_id")
    amount_before = _nonnegative_integer(before.get("amount_used"), "amount_used")
    next_reset_time = _integer(before.get("next_reset_time"), "next_reset_time")
    end_time = _integer(before.get("end_time"), "end_time")
    summary: dict[str, Any] = {
        "user_id": user_id,
        "set_id": set_id,
        "upstream_user_id": upstream_user_id,
        "business_plan_id": business_plan_id,
        "upstream_plan_id": upstream_plan_id,
        "subscription_id": subscription_id,
        "amount_used_before": amount_before,
        "dry_run": not execute,
        "status": "ready" if not execute else "pending",
    }
    if not execute:
        print(json.dumps(summary, separators=(",", ":")), file=output, flush=True)
        return 0
    if amount_before == 0:
        summary.update({"status": "already_reset", "amount_used_after": 0, "schedule_unchanged": True})
        print(json.dumps(summary, separators=(",", ":")), file=output, flush=True)
        return 0

    reset_path = (
        "/_llmgateway_console/" + urllib.parse.quote(set_id, safe="")
        + "/api/subscription/admin/users/" + str(upstream_user_id) + "/subscriptions/reset"
    )
    reset_result = client.request(
        "POST", reset_path, {"plan_id": upstream_plan_id, "advance_reset_time": False},
    )
    if not isinstance(reset_result, dict):
        raise SafetyError("reset response is invalid")
    if int(reset_result.get("reset_count", 0)) != 1 or int(reset_result.get("user_count", 0)) != 1:
        raise SafetyError("reset did not affect exactly one subscription for one user")
    if reset_result.get("advance_reset_time") is not False:
        raise SafetyError("reset unexpectedly advanced the natural reset time")

    after_active = _active_subscriptions(client.request("GET", _subscriptions_path(set_id, upstream_user_id)))
    after_matching = [sub for sub in after_active if _integer(sub.get("plan_id"), "plan_id") == upstream_plan_id]
    if len(after_active) != 1 or len(after_matching) != 1:
        raise SafetyError("active subscription set changed during reset")
    after = after_matching[0]
    if _integer(after.get("id"), "subscription_id") != subscription_id:
        raise SafetyError("active subscription ID changed during reset")
    if _nonnegative_integer(after.get("amount_used"), "amount_used") != 0:
        raise SafetyError("quota is not zero after reset")
    schedule_unchanged = (
        _integer(after.get("next_reset_time"), "next_reset_time") == next_reset_time
        and _integer(after.get("end_time"), "end_time") == end_time
    )
    if not schedule_unchanged:
        raise SafetyError("subscription reset schedule or end time changed")
    summary.update({
        "status": "reset",
        "dry_run": False,
        "amount_used_after": 0,
        "schedule_unchanged": True,
    })
    print(json.dumps(summary, separators=(",", ":")), file=output, flush=True)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--base-url", default=os.getenv("VELAGW_ADMIN_BASE_URL", ""))
    parser.add_argument("--execute", action="store_true", help="Reset after all safety checks pass")
    parser.add_argument("--confirm-user-id", default="", help="Must equal --user-id when --execute is used")
    parser.add_argument("--timeout", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.getenv("VELAGW_ADMIN_TOKEN", "")
    try:
        return run_reset(
            args.base_url,
            token,
            args.user_id,
            execute=args.execute,
            confirm_user_id=args.confirm_user_id,
            timeout=args.timeout,
        )
    except (ValueError, APIError, SafetyError) as exc:
        print(json.dumps({"status": "failed", "error": str(exc)[:500]}, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
