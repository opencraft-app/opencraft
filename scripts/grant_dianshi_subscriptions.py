#!/usr/bin/env python3
"""Grant one Dianshi-backed subscription to each LightVela user ID."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Iterable, TextIO


DEFAULT_BUNDLE_ID = "bundle_launch_ai_01"
DEFAULT_ACT_ID = 142123551192174
USER_ID_RE = re.compile(r"^usr_[0-9a-f]+$")
TERMINAL_AUTH_STATUSES = {"failed", "disabled"}


class APIError(RuntimeError):
    pass


class UserPhaseError(RuntimeError):
    def __init__(self, phase: str, message: str) -> None:
        super().__init__(message)
        self.phase = phase


def parse_user_ids(lines: Iterable[str]) -> tuple[list[str], list[str]]:
    valid: list[str] = []
    invalid: list[str] = []
    seen: set[str] = set()
    for raw in lines:
        user_id = raw.split("#", 1)[0].strip()
        if not user_id or user_id in seen:
            continue
        seen.add(user_id)
        if USER_ID_RE.fullmatch(user_id):
            valid.append(user_id)
        else:
            invalid.append(user_id)
    return valid, invalid


def _response_data(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise APIError("response is not a JSON object")
    data = payload.get("data")
    if isinstance(data, dict):
        return data
    return payload


class InternalClient:
    def __init__(
        self,
        auth_base_url: str,
        ctl_base_url: str,
        token: str,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
        request_timeout: float = 30,
    ) -> None:
        self.auth_base_url = auth_base_url.rstrip("/")
        self.ctl_base_url = ctl_base_url.rstrip("/")
        self.token = token.strip()
        self.opener = opener
        self.request_timeout = request_timeout
        if not self.auth_base_url or not self.ctl_base_url or not self.token:
            raise ValueError("auth URL, ctl URL, and internal token are required")

    def _request(self, method: str, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(url, data=encoded, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("Accept", "application/json")
        if encoded is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with self.opener(request, timeout=self.request_timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
                message = payload.get("message") or payload.get("error") or raw
            except json.JSONDecodeError:
                message = raw
            raise APIError(f"HTTP {exc.code}: {str(message)[:500]}") from exc
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise APIError(str(exc)[:500]) from exc
        return _response_data(payload)

    def register_or_retry(self, user_id: str) -> dict[str, Any]:
        return self._request(
            "POST",
            self.auth_base_url + "/internal/shadow/binding/register-or-retry",
            {"external_user_id": user_id},
        )

    def binding_state(self, user_id: str) -> dict[str, Any]:
        query = urllib.parse.urlencode({"external_user_id": user_id})
        return self._request("GET", self.auth_base_url + "/internal/shadow/binding/state?" + query)

    def grant(self, user_id: str, bundle_id: str, act_id: int) -> dict[str, Any]:
        return self._request(
            "POST",
            self.ctl_base_url + "/internal/ctl/subscriptions/dianshi/grant",
            {"external_user_id": user_id, "bundle_id": bundle_id, "act_id": act_id},
        )


def _wait_for_active_binding(
    client: InternalClient,
    user_id: str,
    initial: dict[str, Any],
    timeout: float,
    poll_interval: float,
    sleep: Callable[[float], None],
) -> None:
    state = initial
    deadline = time.monotonic() + timeout
    while True:
        status = str(state.get("status", "")).strip().lower()
        if status == "active":
            return
        if status in TERMINAL_AUTH_STATUSES:
            code = str(state.get("last_error_code", "")).strip()
            message = str(state.get("last_error_message", "")).strip()
            detail = ": ".join(value for value in (code, message) if value)
            raise UserPhaseError("auth", detail or f"shadow binding status is {status}")
        if time.monotonic() >= deadline:
            raise UserPhaseError("auth", f"timed out waiting for active shadow binding (last status: {status or 'unknown'})")
        sleep(poll_interval)
        state = client.binding_state(user_id)


def process_user(
    client: InternalClient,
    user_id: str,
    bundle_id: str,
    act_id: int,
    *,
    timeout: float,
    poll_interval: float,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    try:
        binding = client.register_or_retry(user_id)
        _wait_for_active_binding(client, user_id, binding, timeout, poll_interval, sleep)
    except UserPhaseError:
        raise
    except Exception as exc:
        raise UserPhaseError("auth", str(exc)) from exc

    try:
        granted = client.grant(user_id, bundle_id, act_id)
    except Exception as exc:
        raise UserPhaseError("grant", str(exc)) from exc
    status = str(granted.get("status", "")).strip().lower()
    if status not in {"granted", "reused", "skipped"}:
        raise UserPhaseError("grant", f"unexpected grant status: {status or 'missing'}")
    result: dict[str, Any] = {"user_id": user_id, "phase": "grant", "status": status}
    for key in ("deal_name", "big_order_id"):
        if granted.get(key):
            result[key] = granted[key]
    return result


def run_batch(
    client: InternalClient,
    user_ids: list[str],
    invalid_user_ids: list[str],
    bundle_id: str,
    act_id: int,
    *,
    timeout: float,
    poll_interval: float,
    output: TextIO = sys.stdout,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    failed = False
    for user_id in invalid_user_ids:
        failed = True
        print(json.dumps({"user_id": user_id, "phase": "input", "status": "failed", "error": "invalid user ID"}), file=output)
    for user_id in user_ids:
        try:
            result = process_user(
                client,
                user_id,
                bundle_id,
                act_id,
                timeout=timeout,
                poll_interval=poll_interval,
                sleep=sleep,
            )
        except UserPhaseError as exc:
            failed = True
            result = {"user_id": user_id, "phase": exc.phase, "status": "failed", "error": str(exc)[:500]}
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")), file=output, flush=True)
    return 1 if failed else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Text file containing one LightVela user ID per line")
    parser.add_argument("--auth-base-url", default=os.getenv("AUTH_INTERNAL_BASE_URL", ""))
    parser.add_argument("--ctl-base-url", default=os.getenv("CTL_INTERNAL_BASE_URL", ""))
    parser.add_argument("--token", default=os.getenv("LIGHTCLAW_INTERNAL_SERVICE_TOKEN", ""))
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--act-id", type=int, default=DEFAULT_ACT_ID)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--poll-interval", type=float, default=2)
    parser.add_argument("--request-timeout", type=float, default=30)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.act_id <= 0 or args.timeout <= 0 or args.poll_interval < 0 or args.request_timeout <= 0:
        raise SystemExit("act-id and timeouts must be positive; poll-interval may be zero")
    with args.input.open("r", encoding="utf-8") as source:
        user_ids, invalid = parse_user_ids(source)
    client = InternalClient(
        args.auth_base_url,
        args.ctl_base_url,
        args.token,
        request_timeout=args.request_timeout,
    )
    return run_batch(
        client,
        user_ids,
        invalid,
        args.bundle_id,
        args.act_id,
        timeout=args.timeout,
        poll_interval=args.poll_interval,
    )


if __name__ == "__main__":
    raise SystemExit(main())
