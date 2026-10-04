#!/usr/bin/env python3
"""Batch-preview or reset one-user LLMGateway subscription quotas through CTL.

This script performs one finite pass. ``--limit all`` removes the per-run user
cap; it does not repeatedly reset the same users. See ``--help`` for examples.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib import error, parse, request


USER_ID = re.compile(r"^usr_[A-Za-z0-9_-]+$")
CONFIRM = "RESET-USER-QUOTAS"
INELIGIBLE_PASS_CODES = frozenset({
    "PASS_ISOLATING", "PASS_RENEWING", "PASS_DELETING", "PASS_TERMINATING",
    "PASS_MODIFYING", "PASS_ISOLATED", "INSTANCE_NO_ACTIVE_PASS",
})


class OperationError(Exception):
    pass


class HTTPServiceError(OperationError):
    def __init__(self, status: int, code: str | None, method: str, path: str):
        self.status = status
        self.code = code
        suffix = f": {code}" if code else ""
        super().__init__(f"CTL HTTP {status} for {method} {path.split('?')[0]}{suffix}")


def emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def positive_limit(value: str) -> int | None:
    if value == "all":
        return None
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("limit must be a positive integer or 'all'") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("limit must be a positive integer or 'all'")
    return parsed


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--users-file", type=Path, help="one usr_ ID per line; # comments allowed")
    source.add_argument("--user-id", action="append", help="repeat to provide explicit users")
    source.add_argument("--all-running-bots", action="store_true", help="deduplicate owners of Running CTL Bots")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--kubeconfig", type=Path, help="start and stop a local ctl-api port-forward automatically")
    target.add_argument("--base-url", help="existing direct/port-forward CTL URL; never kubectl proxy")
    parser.add_argument("--namespace", default="ctl", help="Kubernetes namespace (default: ctl)")
    parser.add_argument("--environment", required=True, help="stable environment ID, e.g. shprod or sgprod; checkpoint isolation")
    parser.add_argument("--token-env", default="CTL_INTERNAL_TOKEN", help="token environment variable for --base-url")
    parser.add_argument("--skip-additive-credit", action="store_true", help="skip users with active credit-package: or free-credit: subscriptions")
    parser.add_argument("--credit-skip-file", type=Path, help="0600 JSONL list of skipped users for later handling")
    parser.add_argument("--skip-ineligible-pass", action="store_true", help="record and skip known CTL inactive-pass guard failures on preview")
    parser.add_argument("--ineligible-pass-file", type=Path, help="0600 JSONL list of pass-state skips for later handling")
    parser.add_argument("--llmgateway-kubeconfig", type=Path, help="LLMGateway cluster kubeconfig for additive-credit checks")
    parser.add_argument("--llmgateway-base-url", help="existing local/HTTPS LLMGateway URL for additive-credit checks")
    parser.add_argument("--llmgateway-token-env", default="LLMGATEWAY_INTERNAL_TOKEN")
    parser.add_argument("--llmgateway-namespace", default="llmgateway")
    parser.add_argument("--state-file", required=True, type=Path, help="0600 JSONL checkpoint; use a new file per campaign")
    parser.add_argument("--limit", type=positive_limit, default=10, metavar="N|all", help="unique users attempted this run (default: 10)")
    parser.add_argument("--execute", action="store_true", help="perform real resets; default is dry-run only")
    parser.add_argument("--confirm", help=f"required with --execute: {CONFIRM}")
    parser.add_argument("--interval", type=float, default=0.25, help="seconds between users (default: 0.25)")
    parser.add_argument("--timeout", type=float, default=15, help="HTTP timeout in seconds (default: 15)")
    args = parser.parse_args(argv)
    if args.execute and args.confirm != CONFIRM:
        parser.error(f"--execute requires --confirm {CONFIRM}")
    if not args.execute and args.confirm:
        parser.error("--confirm is only valid with --execute")
    if args.interval < 0 or args.timeout <= 0:
        parser.error("--interval must be nonnegative and --timeout must be positive")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.environment):
        parser.error("--environment must contain only letters, digits, underscores or hyphens")
    if args.base_url and not args.base_url.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        parser.error("--base-url must be a local port-forward URL or HTTPS")
    if args.skip_additive_credit:
        if not args.credit_skip_file or bool(args.llmgateway_kubeconfig) == bool(args.llmgateway_base_url):
            parser.error("--skip-additive-credit requires --credit-skip-file and exactly one LLMGateway endpoint")
        if args.credit_skip_file == args.state_file:
            parser.error("--credit-skip-file must differ from --state-file")
    elif args.credit_skip_file or args.llmgateway_kubeconfig or args.llmgateway_base_url:
        parser.error("credit-check options require --skip-additive-credit")
    if args.skip_ineligible_pass != bool(args.ineligible_pass_file):
        parser.error("--skip-ineligible-pass requires --ineligible-pass-file and vice versa")
    if args.ineligible_pass_file and args.ineligible_pass_file in (args.state_file, args.credit_skip_file):
        parser.error("--ineligible-pass-file must differ from other state files")
    if args.llmgateway_base_url and not args.llmgateway_base_url.startswith(("http://127.0.0.1:", "http://localhost:", "https://")):
        parser.error("--llmgateway-base-url must be a local port-forward URL or HTTPS")
    return args


def kubectl(kubeconfig: Path, namespace: str, *args: str) -> list[str]:
    return ["kubectl", f"--kubeconfig={kubeconfig}", "-n", namespace, *args]


def kube_token(kubeconfig: Path, namespace: str, secret_name: str, secret_key: str) -> str:
    command = kubectl(kubeconfig, namespace, "get", "secret", secret_name, "-o", f"jsonpath={{.data.{secret_key}}}")
    for attempt in range(4):
        try:
            result = subprocess.run(command, capture_output=True, check=True, timeout=30)
            break
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 3:
                raise
            time.sleep(0.5 * (attempt + 1))
    try:
        token = base64.b64decode(result.stdout, validate=True).decode("utf-8").strip()
    except (ValueError, UnicodeError) as exc:
        raise OperationError("CTL token secret is invalid") from exc
    if not token:
        raise OperationError("CTL token secret is empty")
    return token


@contextlib.contextmanager
def service_endpoint(base_url: str | None, token_env: str, kubeconfig: Path | None,
                     namespace: str, service: str, secret_name: str, secret_key: str):
    if base_url:
        token = os.environ.get(token_env, "").strip()
        if not token:
            raise OperationError(f"{token_env} is required for a direct service URL")
        yield base_url.rstrip("/"), token
        return

    token = kube_token(kubeconfig, namespace, secret_name, secret_key)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    command = kubectl(kubeconfig, namespace, "port-forward", "--address=127.0.0.1", f"svc/{service}", f"{port}:80")
    child = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise OperationError("kubectl port-forward exited before becoming ready")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise OperationError("kubectl port-forward did not become ready")
        yield f"http://127.0.0.1:{port}", token
    finally:
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


def ctl_endpoint(args: argparse.Namespace):
    return service_endpoint(args.base_url, args.token_env, args.kubeconfig, args.namespace,
                            "ctl-api", "ctl-runtime-secrets", "LIGHTCLAW_INTERNAL_SERVICE_TOKEN")


def llmgateway_endpoint(args: argparse.Namespace):
    return service_endpoint(args.llmgateway_base_url, args.llmgateway_token_env,
                            args.llmgateway_kubeconfig, args.llmgateway_namespace,
                            "llmgateway-control", "llmgateway-control-runtime", "INTERNAL_SERVICE_TOKEN")


class CTLClient:
    def __init__(self, base_url: str, token: str, timeout: float):
        self.base_url = base_url
        self.token = token
        self.timeout = timeout

    def call(self, method: str, path: str, body: dict | None = None, *, envelope: bool = True) -> dict:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = request.Request(self.base_url + path, data=payload, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                result = json.load(response)
        except error.HTTPError as exc:
            try:
                error_body = json.loads(exc.read(4096))
                code = error_body.get("code") if isinstance(error_body, dict) else None
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code):
                    code = None
            except (ValueError, UnicodeError, OSError):
                code = None
            raise HTTPServiceError(exc.code, code, method, path) from exc
        except (error.URLError, TimeoutError, OSError) as exc:
            raise OperationError(f"CTL transport error for {method} {path.split('?')[0]}: {type(exc).__name__}") from exc
        except (ValueError, UnicodeError) as exc:
            raise OperationError("CTL returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise OperationError("CTL returned an unexpected JSON payload")
        if not envelope:
            return result
        if result.get("code") != "OK" or not isinstance(result.get("data"), dict):
            code = result.get("code") if isinstance(result, dict) else "invalid_envelope"
            raise OperationError(f"CTL rejected {method} {path.split('?')[0]}: {code}")
        return result["data"]

    def call_read_only(self, method: str, path: str, body: dict | None = None, *, envelope: bool = True) -> dict:
        """Retry only safe probes; never use this for a real quota reset write."""
        for attempt in range(4):
            try:
                return self.call(method, path, body, envelope=envelope)
            except OperationError as exc:
                message = str(exc)
                transient = "transport error" in message or any(f"HTTP {code}" in message for code in (502, 503, 504))
                if not transient or attempt == 3:
                    raise
                time.sleep(0.5 * (attempt + 1))
        raise AssertionError("unreachable")

    def reset(self, user_id: str, dry_run: bool) -> dict:
        path = f"/internal/users/{parse.quote(user_id, safe='')}/gateway/quota/reset"
        operation = self.call_read_only if dry_run else self.call
        result = operation("POST", path, {"dry_run": dry_run})
        if result.get("user_id") != user_id or result.get("dry_run") is not dry_run:
            raise OperationError("CTL reset response identity or mode does not match request")
        return result

    def additive_credit_kind(self, user_id: str) -> str | None:
        path = f"/api/internal/users/{parse.quote(user_id, safe='')}/subscriptions/active"
        result = self.call_read_only("GET", path, envelope=False)
        data = result.get("data")
        if result.get("success") is not True or not isinstance(data, dict) or data.get("user_id") != user_id:
            raise OperationError(f"LLMGateway active subscriptions are unavailable for {user_id}")
        subscriptions = data.get("subscriptions")
        if not isinstance(subscriptions, list):
            raise OperationError(f"LLMGateway active subscription list is invalid for {user_id}")
        kinds = set()
        for subscription in subscriptions:
            if not isinstance(subscription, dict) or subscription.get("user_id") != user_id:
                raise OperationError(f"LLMGateway subscription identity is invalid for {user_id}")
            name = subscription.get("name", "")
            if not isinstance(name, str):
                raise OperationError(f"LLMGateway subscription name is invalid for {user_id}")
            if name.startswith("credit-package:"):
                kinds.add("credit_package")
            elif name.startswith("free-credit:"):
                kinds.add("free_credit")
            elif name and not name.startswith("package:"):
                raise OperationError(f"unknown active subscription kind for {user_id}")
        if "credit_package" in kinds:
            return "credit_package"
        if "free_credit" in kinds:
            return "free_credit"
        return None


def validate_user_id(user_id: str) -> str:
    user_id = user_id.strip()
    if not USER_ID.fullmatch(user_id):
        raise OperationError(f"invalid user ID: {user_id[:60]}")
    return user_id


def targets(args: argparse.Namespace, client: CTLClient) -> list[str]:
    if args.user_id:
        raw = args.user_id
    elif args.users_file:
        raw = [line.split("#", 1)[0].strip() for line in args.users_file.read_text(encoding="utf-8").splitlines()]
    else:
        raw = []
        page = 1
        while True:
            query = parse.urlencode({"status": "Running", "page": page, "page_size": 200})
            data = client.call("GET", f"/internal/bots?{query}", envelope=False)
            items = data.get("items")
            if not isinstance(items, list):
                raise OperationError("CTL bot list has no items array")
            raw.extend(item.get("user_id", "") for item in items if isinstance(item, dict))
            if not items or page * 200 >= data.get("total", 0):
                break
            page += 1
    unique = list(dict.fromkeys(validate_user_id(value) for value in raw if value.strip()))
    if not unique:
        raise OperationError("target set is empty")
    return unique


@contextlib.contextmanager
def checkpoint(path: Path, environment: str):
    if path.is_symlink():
        raise OperationError("state file must not be a symlink")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "a+", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.seek(0)
        latest = {}
        for line in stream:
            item = json.loads(line)
            if item.get("environment") != environment:
                raise OperationError("state file belongs to another environment; use a separate state file")
            latest[(item.get("mode"), item.get("user_id"))] = item.get("status")
        inflight = [user_id for (mode, user_id), status in latest.items() if mode == "execute" and status == "inflight"]
        if inflight:
            raise OperationError(f"unresolved reset outcome for {inflight[0]}; reconcile before resuming")
        completed = {key for key, status in latest.items()
                     if status in ("ready", "reset", "already_reset", "skipped_additive_credit", "skipped_ineligible_pass")}
        stream.seek(0, os.SEEK_END)
        yield stream, completed


@contextlib.contextmanager
def skip_file(path: Path, environment: str):
    if path.is_symlink():
        raise OperationError("skip file must not be a symlink")
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "a+", encoding="utf-8") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stream.seek(0)
        skipped = set()
        for line in stream:
            item = json.loads(line)
            if item.get("environment") != environment:
                raise OperationError("skip file belongs to another environment")
            skipped.add(validate_user_id(item.get("user_id", "")))
        stream.seek(0, os.SEEK_END)
        yield stream, skipped


def record_skip(stream, skipped: set, environment: str, user_id: str, kind: str) -> None:
    if user_id in skipped:
        return
    stream.write(json.dumps({"environment": environment, "user_id": user_id,
                             "reason": kind, "recorded_at": int(time.time())}, ensure_ascii=False) + "\n")
    stream.flush()
    os.fsync(stream.fileno())
    skipped.add(user_id)


def record(stream, completed: set, environment: str, mode: str, user_id: str, result: dict) -> None:
    item = {
        "environment": environment,
        "mode": mode,
        "user_id": user_id,
        "status": result["status"],
        "amount_used_before": result.get("amount_used_before"),
        "amount_used_after": result.get("amount_used_after"),
        "subscription_id": result.get("subscription_id"),
        "reason": result.get("reason"),
        "recorded_at": int(time.time()),
    }
    stream.write(json.dumps(item, ensure_ascii=False) + "\n")
    stream.flush()
    os.fsync(stream.fileno())
    if result["status"] != "inflight":
        completed.add((mode, user_id))


def run(args: argparse.Namespace) -> int:
    mode = "execute" if args.execute else "dry-run"
    with contextlib.ExitStack() as stack:
        state, completed = stack.enter_context(checkpoint(args.state_file, args.environment))
        if args.skip_additive_credit:
            skipped_state, skipped = stack.enter_context(skip_file(args.credit_skip_file, args.environment))
            gateway_url, gateway_token = stack.enter_context(llmgateway_endpoint(args))
            gateway_client = CTLClient(gateway_url, gateway_token, args.timeout)
        else:
            skipped_state, skipped, gateway_client = None, set(), None
        if args.skip_ineligible_pass:
            ineligible_state, ineligible = stack.enter_context(skip_file(args.ineligible_pass_file, args.environment))
        else:
            ineligible_state, ineligible = None, set()
        url, token = stack.enter_context(ctl_endpoint(args))
        client = CTLClient(url, token, args.timeout)
        user_ids = targets(args, client)
        pending = [user_id for user_id in user_ids if (mode, user_id) not in completed]
        selected = pending if args.limit is None else pending[: args.limit]
        emit("start", environment=args.environment, mode=mode, discovered=len(user_ids), pending=len(pending), selected=len(selected))
        for index, user_id in enumerate(selected, 1):
            kind = "previous_skip_record" if user_id in skipped else gateway_client.additive_credit_kind(user_id) if gateway_client else None
            if kind:
                record_skip(skipped_state, skipped, args.environment, user_id, kind)
                result = {"status": "skipped_additive_credit", "reason": kind}
                record(state, completed, args.environment, mode, user_id, result)
                emit("user", index=index, user_id=user_id, status=result["status"], reason=kind)
                continue
            try:
                preview = client.reset(user_id, True)
            except HTTPServiceError as exc:
                if not args.skip_ineligible_pass or exc.status != 403 or exc.code not in INELIGIBLE_PASS_CODES:
                    raise
                record_skip(ineligible_state, ineligible, args.environment, user_id, exc.code)
                result = {"status": "skipped_ineligible_pass", "reason": exc.code}
                record(state, completed, args.environment, mode, user_id, result)
                emit("user", index=index, user_id=user_id, status=result["status"], reason=exc.code)
                continue
            if preview.get("status") != "ready" or preview.get("amount_used_after") != preview.get("amount_used_before"):
                raise OperationError(f"unexpected preview result for {user_id}")
            if args.execute:
                if preview.get("amount_used_before") == 0:
                    result = {**preview, "status": "already_reset", "amount_used_after": 0}
                else:
                    kind = gateway_client.additive_credit_kind(user_id) if gateway_client else None
                    if kind:
                        record_skip(skipped_state, skipped, args.environment, user_id, kind)
                        result = {"status": "skipped_additive_credit", "reason": kind}
                        record(state, completed, args.environment, mode, user_id, result)
                        emit("user", index=index, user_id=user_id, status=result["status"], reason=kind)
                        continue
                    second_preview = client.reset(user_id, True)
                    if any(second_preview.get(key) != preview.get(key) for key in
                           ("set_id", "subscription_id", "upstream_plan_id", "next_reset_time", "end_time")):
                        raise OperationError(f"reset target changed before write for {user_id}")
                    record(state, completed, args.environment, mode, user_id,
                           {**preview, "status": "inflight"})
                    result = client.reset(user_id, False)
                    if result.get("status") != "reset" or result.get("amount_used_after") != 0 or not result.get("schedule_unchanged"):
                        raise OperationError(f"reset result requires manual reconciliation for {user_id}")
                    if any(result.get(key) != preview.get(key) for key in ("set_id", "subscription_id", "next_reset_time", "end_time")):
                        raise OperationError(f"reset target changed; manually reconcile {user_id}")
            else:
                result = preview
            record(state, completed, args.environment, mode, user_id, result)
            emit("user", index=index, user_id=user_id, status=result["status"], amount_used_before=result.get("amount_used_before"), amount_used_after=result.get("amount_used_after"))
            if index < len(selected) and args.interval:
                time.sleep(args.interval)
        emit("done", environment=args.environment, mode=mode, processed=len(selected),
             remaining=len(pending) - len(selected), next_user_id=pending[len(selected)] if len(pending) > len(selected) else None)
    return 0


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return run(args)
    except (OperationError, OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired, BlockingIOError) as exc:
        emit("error", kind=type(exc).__name__, message=str(exc)[:240])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
