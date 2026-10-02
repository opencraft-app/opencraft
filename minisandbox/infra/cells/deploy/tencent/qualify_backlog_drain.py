#!/usr/bin/env python3
"""Qualify bounded Depot/Gasoline maintenance drain after a load process stops.

This starts the command following `--`, samples indexed durable queues while it
runs, then requires three consecutive drained samples before the deadline.
Future GC rows protected by a recovery window are reported but are not treated
as due backlog. Cold publish uses the sharded one-row-per-job FDB index; command
reconciliation is summed over exact active Envoy prefixes.
"""

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Set


ZERO_DRAIN_LANES = (
    "hot_compaction_dirty",
    "hot_compaction_jobs",
    "cold_publish",
    "branch_gc_due",
    "cold_gc_due",
    "reconciliation",
)
DEFAULT_OBSERVED_LANES = ZERO_DRAIN_LANES


def request_json(url: str, timeout: float, token: Optional[str]) -> Dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        payload = error.read().decode(errors="replace")
        raise RuntimeError(
            "GET {} returned HTTP {}: {}".format(url, error.code, payload)
        ) from error


def scan_pages(
    api_url: str,
    path: str,
    query: Dict[str, str],
    expected_scope: str,
    timeout: float,
    token: Optional[str],
    due_queue: bool = False,
) -> Dict[str, int]:
    cursor = None  # type: Optional[str]
    seen = set()  # type: Set[str]
    totals = {"rows": 0, "due": 0, "future": 0, "pages": 0}
    while True:
        current_query = dict(query)
        current_query["limit"] = "1000"
        if cursor is not None:
            current_query["start_after"] = cursor
        url = api_url.rstrip("/") + path + "?" + urllib.parse.urlencode(current_query)
        page = request_json(url, timeout, token)
        if page.get("scope") != expected_scope:
            raise RuntimeError("backlog endpoint returned the wrong scope")
        row_count = page.get("row_count")
        if not isinstance(row_count, int) or row_count < 0 or row_count > 1000:
            raise RuntimeError("backlog endpoint returned an invalid row_count")
        totals["rows"] += row_count
        totals["pages"] += 1
        if due_queue:
            due = page.get("due_rows")
            future = page.get("future_retained_rows")
            if (
                not isinstance(due, int)
                or not isinstance(future, int)
                or due < 0
                or future < 0
                or due + future != row_count
            ):
                raise RuntimeError("due queue page returned inconsistent counters")
            totals["due"] += due
            totals["future"] += future
        next_cursor = page.get("next_cursor")
        if next_cursor is None:
            break
        if not isinstance(next_cursor, str) or next_cursor in seen:
            raise RuntimeError("backlog endpoint returned an invalid cursor")
        seen.add(next_cursor)
        cursor = next_cursor
    return totals


def list_envoys(
    api_url: str,
    namespace: str,
    pools: List[str],
    timeout: float,
    token: Optional[str],
) -> List[str]:
    keys = []
    seen = set()  # type: Set[str]
    for pool in pools:
        cursor = None
        while True:
            query = {"namespace": namespace, "name": pool, "limit": "100"}
            if cursor is not None:
                query["cursor"] = cursor
            payload = request_json(
                api_url.rstrip("/") + "/envoys?" + urllib.parse.urlencode(query),
                timeout,
                token,
            )
            envoys = payload.get("envoys")
            if not isinstance(envoys, list):
                raise RuntimeError("Envoy inventory returned no list")
            for envoy in envoys:
                if not isinstance(envoy, dict) or envoy.get("pool_name") != pool:
                    raise RuntimeError("Envoy inventory returned an invalid pool record")
                key = envoy.get("envoy_key")
                if not isinstance(key, str) or not key or key in seen:
                    raise RuntimeError("Envoy inventory returned an invalid/duplicate key")
                if envoy.get("stop_ts") is None:
                    seen.add(key)
                    keys.append(key)
            pagination = payload.get("pagination")
            next_cursor = pagination.get("cursor") if isinstance(pagination, dict) else None
            if next_cursor is None or not envoys:
                break
            if next_cursor == cursor:
                raise RuntimeError("Envoy inventory cursor did not advance")
            cursor = str(next_cursor)
    return sorted(keys)


def snapshot(args: argparse.Namespace, token: Optional[str]) -> Dict[str, Any]:
    footprint_scopes = {
        "hot_compaction_dirty": "depot-dirty",
        "hot_compaction_jobs": "depot-hot-jobs",
        "cold_publish": "depot-cold-publish",
    }
    lanes = {}  # type: Dict[str, int]
    pages = {}  # type: Dict[str, int]
    for lane, scope in footprint_scopes.items():
        result = scan_pages(
            args.api_url,
            "/depot/inspect/footprint",
            {"scope": scope},
            scope,
            args.request_timeout_seconds,
            token,
        )
        lanes[lane] = result["rows"]
        pages[lane] = result["pages"]

    for lane, scope in (("branch_gc", "branch-gc"), ("cold_gc", "cold-gc")):
        result = scan_pages(
            args.api_url,
            "/depot/inspect/due-queue",
            {"scope": scope},
            scope,
            args.request_timeout_seconds,
            token,
            due_queue=True,
        )
        lanes[lane + "_due"] = result["due"]
        lanes[lane + "_future_retained"] = result["future"]
        pages[lane] = result["pages"]

    envoy_keys = list_envoys(
        args.api_url,
        args.namespace,
        args.pool_name,
        args.request_timeout_seconds,
        token,
    )
    if len(envoy_keys) < args.min_envoys:
        raise RuntimeError(
            "only {} live Envoys found; expected at least {}".format(
                len(envoy_keys), args.min_envoys
            )
        )
    reconciliation = 0
    reconciliation_pages = 0
    per_envoy = {}
    for envoy_key in envoy_keys:
        result = scan_pages(
            args.api_url,
            "/depot/inspect/footprint",
            {
                "scope": "reconciliation",
                "namespace": args.namespace,
                "envoy_key": envoy_key,
            },
            "reconciliation:" + envoy_key,
            args.request_timeout_seconds,
            token,
        )
        per_envoy[envoy_key] = result["rows"]
        reconciliation += result["rows"]
        reconciliation_pages += result["pages"]
    lanes["reconciliation"] = reconciliation
    pages["reconciliation"] = reconciliation_pages
    return {
        "at_monotonic_seconds": time.monotonic(),
        "lanes": lanes,
        "pages": pages,
        "live_envoys": envoy_keys,
        "reconciliation_by_envoy": per_envoy,
    }


def is_drained(sample: Dict[str, Any]) -> bool:
    lanes = sample["lanes"]
    return all(lanes.get(lane) == 0 for lane in ZERO_DRAIN_LANES)


def command_receipt(command: List[str]) -> Dict[str, Any]:
    """Identify the load command without copying possible argv secrets."""
    encoded = json.dumps(command, separators=(",", ":")).encode("utf-8")
    return {
        "executable": pathlib.Path(command[0]).name,
        "argument_count": len(command) - 1,
        "argv_sha256": hashlib.sha256(encoded).hexdigest(),
    }


def run_qualification(args: argparse.Namespace) -> Dict[str, Any]:
    if not args.load_command:
        raise ValueError("a load command is required after --")
    load_command = list(args.load_command)
    if load_command and load_command[0] == "--":
        load_command.pop(0)
    if not load_command:
        raise ValueError("load command is empty")
    if args.interval_seconds <= 0 or args.drain_timeout_seconds <= 0:
        raise ValueError("interval and drain timeout must be positive")
    if args.request_timeout_seconds <= 0:
        raise ValueError("request-timeout-seconds must be positive")
    if args.min_envoys <= 0:
        raise ValueError("min-envoys must be positive")
    if not args.pool_name or any(not pool for pool in args.pool_name):
        raise ValueError("at least one non-empty pool-name is required")
    if len(set(args.pool_name)) != len(args.pool_name):
        raise ValueError("pool-name values must be unique")
    if args.settled_samples < 2:
        raise ValueError("settled-samples must be at least 2")
    required_observed = args.require_observed or list(DEFAULT_OBSERVED_LANES)
    unknown = set(required_observed) - set(ZERO_DRAIN_LANES)
    if unknown:
        raise ValueError("unknown require-observed lanes: {}".format(sorted(unknown)))
    token = None
    if args.auth_token_env:
        token = os.environ.get(args.auth_token_env)
        if token is None:
            raise ValueError("auth token environment variable is not set")

    samples = []  # type: List[Dict[str, Any]]
    observed = {lane: False for lane in required_observed}
    child = subprocess.Popen(load_command)
    load_started = time.monotonic()
    try:
        while child.poll() is None:
            sample = snapshot(args, token)
            sample["phase"] = "active_input"
            samples.append(sample)
            for lane in required_observed:
                observed[lane] = observed[lane] or sample["lanes"].get(lane, 0) > 0
            time.sleep(args.interval_seconds)
        child_returncode = child.wait()
    except Exception:
        if child.poll() is None:
            child.terminate()
        raise
    input_stopped = time.monotonic()
    if child_returncode != 0:
        raise RuntimeError("load command exited {}".format(child_returncode))
    missing = [lane for lane, was_observed in observed.items() if not was_observed]
    if missing:
        raise RuntimeError(
            "load did not create observable durable backlog for: {}".format(
                ", ".join(missing)
            )
        )

    deadline = input_stopped + args.drain_timeout_seconds
    consecutive = 0
    while time.monotonic() < deadline:
        sample = snapshot(args, token)
        sample["phase"] = "draining"
        samples.append(sample)
        consecutive = consecutive + 1 if is_drained(sample) else 0
        if consecutive >= args.settled_samples:
            break
        time.sleep(args.interval_seconds)
    if consecutive < args.settled_samples:
        raise RuntimeError(
            "maintenance backlog did not remain drained for {} consecutive samples".format(
                args.settled_samples
            )
        )

    return {
        "verdict": "passed",
        "api_url": args.api_url.rstrip("/"),
        "namespace": args.namespace,
        "pools": args.pool_name,
        "load_command_receipt": command_receipt(load_command),
        "load_duration_seconds": input_stopped - load_started,
        "drain_duration_seconds": time.monotonic() - input_stopped,
        "required_observed": required_observed,
        "settled_samples": args.settled_samples,
        "samples": samples,
        "gc_semantics": (
            "only due rows must drain; future_retained rows remain protected by recovery windows"
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:6420")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--pool-name", action="append", required=True)
    parser.add_argument("--min-envoys", type=int, default=2)
    parser.add_argument("--interval-seconds", type=float, default=5)
    parser.add_argument("--drain-timeout-seconds", type=float, default=1800)
    parser.add_argument("--settled-samples", type=int, default=3)
    parser.add_argument("--require-observed", action="append", choices=ZERO_DRAIN_LANES)
    parser.add_argument("--request-timeout-seconds", type=float, default=30)
    parser.add_argument("--auth-token-env")
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("load_command", nargs=argparse.REMAINDER)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = run_qualification(args)
    encoded = json.dumps(result, indent=2, sort_keys=True)
    print(encoded)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(encoded + "\n")
        os.replace(str(temporary), str(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
