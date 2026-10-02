#!/usr/bin/env python3
"""Repeatable, bounded FDB key/byte footprint qualification.

The Engine endpoint performs at most one bounded FDB range-read transaction per
request. This client walks exact application, Depot, and Cell-scoped Gasoline
prefixes and repeats the walk. A result is qualifying only when two complete
passes have identical content digests and totals while application writers are
stopped.

The byte counts are raw logical key plus value bytes. They deliberately exclude
FDB replication, storage-engine, mutation-log, and filesystem amplification.
"""

import argparse
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Set, Tuple


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
VALID_SCOPES = ("application", "depot", "gasoline")


def request_json(
    url: str, timeout_seconds: float, token: Optional[str]
) -> Dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    if token:
        request.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        payload = error.read().decode(errors="replace")
        raise RuntimeError(
            "GET {} returned HTTP {}: {}".format(url, error.code, payload)
        ) from error


def decode_key(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    try:
        return base64.urlsafe_b64decode((value + padding).encode("ascii"))
    except Exception as error:
        raise RuntimeError("invalid unpadded base64url key") from error


def validate_page(
    page: Dict[str, Any], scope: str, limit: int, previous_last: Optional[bytes]
) -> Tuple[Optional[bytes], Optional[str]]:
    if page.get("scope") != scope:
        raise RuntimeError(
            "footprint endpoint returned scope {!r}, expected {!r}".format(
                page.get("scope"), scope
            )
        )
    for field in ("row_count", "key_bytes", "value_bytes", "raw_bytes"):
        if not isinstance(page.get(field), int) or page[field] < 0:
            raise RuntimeError("invalid non-negative integer field {}".format(field))
    if page["row_count"] > limit:
        raise RuntimeError("footprint page exceeded the requested hard limit")
    if page["raw_bytes"] != page["key_bytes"] + page["value_bytes"]:
        raise RuntimeError("raw_bytes does not equal key_bytes + value_bytes")
    if not SHA256_PATTERN.fullmatch(str(page.get("page_sha256", ""))):
        raise RuntimeError("invalid page_sha256")

    first = page.get("first_key")
    last = page.get("last_key")
    next_cursor = page.get("next_cursor")
    if page["row_count"] == 0:
        if first is not None or last is not None or next_cursor is not None:
            raise RuntimeError("empty footprint page returned keys or a cursor")
        return previous_last, None
    if not isinstance(first, str) or not isinstance(last, str):
        raise RuntimeError("non-empty footprint page is missing key bounds")
    first_raw = decode_key(first)
    last_raw = decode_key(last)
    if first_raw > last_raw:
        raise RuntimeError("footprint page key bounds are reversed")
    if previous_last is not None and first_raw <= previous_last:
        raise RuntimeError("footprint page did not advance past the prior cursor")
    if next_cursor is not None:
        if not isinstance(next_cursor, str):
            raise RuntimeError("invalid footprint cursor")
        if decode_key(next_cursor) != last_raw:
            raise RuntimeError("next_cursor does not equal the page's last key")
    return last_raw, next_cursor


def scan_scope(
    api_url: str,
    scope: str,
    limit: int,
    timeout_seconds: float,
    token: Optional[str],
) -> Dict[str, Any]:
    if scope not in VALID_SCOPES:
        raise ValueError("unsupported footprint scope: {}".format(scope))
    cursor = None  # type: Optional[str]
    previous_last = None  # type: Optional[bytes]
    seen_cursors = set()  # type: Set[str]
    totals = {"keys": 0, "key_bytes": 0, "value_bytes": 0, "raw_bytes": 0}
    transcript = hashlib.sha256()
    pages = 0
    started = time.perf_counter()

    while True:
        query = {"scope": scope, "limit": str(limit)}
        if cursor is not None:
            query["start_after"] = cursor
        url = api_url.rstrip("/") + "/depot/inspect/footprint?" + urllib.parse.urlencode(query)
        page = request_json(url, timeout_seconds, token)
        previous_last, next_cursor = validate_page(page, scope, limit, previous_last)
        pages += 1
        totals["keys"] += page["row_count"]
        totals["key_bytes"] += page["key_bytes"]
        totals["value_bytes"] += page["value_bytes"]
        totals["raw_bytes"] += page["raw_bytes"]
        transcript.update(
            json.dumps(
                {
                    "row_count": page["row_count"],
                    "key_bytes": page["key_bytes"],
                    "value_bytes": page["value_bytes"],
                    "page_sha256": page["page_sha256"],
                    "first_key": page.get("first_key"),
                    "last_key": page.get("last_key"),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        )
        if next_cursor is None:
            break
        if next_cursor in seen_cursors:
            raise RuntimeError("footprint endpoint returned a cursor cycle")
        seen_cursors.add(next_cursor)
        cursor = next_cursor

    return {
        "scope": scope,
        "pages": pages,
        "page_limit": limit,
        "keys": totals["keys"],
        "key_bytes": totals["key_bytes"],
        "value_bytes": totals["value_bytes"],
        "raw_bytes": totals["raw_bytes"],
        "content_sha256": transcript.hexdigest(),
        "duration_seconds": time.perf_counter() - started,
    }


def require_offline_engine(args: argparse.Namespace) -> None:
    if args.cell_id is None or args.execution_site_file is None:
        raise ValueError("offline footprint requires cell-id and execution-site-file")
    actual_cell = args.execution_site_file.read_text().strip()
    if actual_cell != args.cell_id or not args.cell_id.startswith("actor-bj-"):
        raise ValueError("offline footprint must run on the matching Beijing Cell")
    state = subprocess.run(
        [
            "systemctl",
            "show",
            "--property=ActiveState",
            "--value",
            args.engine_service,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
        timeout=args.request_timeout_seconds,
    )
    active_state = state.stdout.strip()
    if state.returncode != 0 or active_state != "inactive":
        raise RuntimeError(
            "{} must be cleanly inactive before offline footprint; ActiveState={!r}".format(
                args.engine_service, active_state
            )
        )


def scan_offline(args: argparse.Namespace, scopes: List[str]) -> Dict[str, Dict[str, Any]]:
    command = [
        str(args.engine_bin),
        "--config",
        str(args.config),
        "depot",
        "footprint",
        "--page-limit",
        str(args.limit),
    ]
    for scope in scopes:
        command.extend(("--scope", scope))
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=args.offline_timeout_seconds,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "offline footprint exited {}: {}".format(
                result.returncode, result.stderr[-4000:]
            )
        )
    try:
        document = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("offline footprint returned malformed JSON") from error
    if document.get("offline_reader") is not True:
        raise RuntimeError("offline footprint did not identify itself as an offline reader")
    measured = document.get("scopes")
    if not isinstance(measured, dict) or set(measured) != set(scopes):
        raise RuntimeError("offline footprint returned the wrong scopes")
    for scope, scan in measured.items():
        if scan.get("scope") != scope:
            raise RuntimeError("offline footprint returned a mismatched scope")
        for field in ("pages", "keys", "key_bytes", "value_bytes", "raw_bytes"):
            if not isinstance(scan.get(field), int) or scan[field] < 0:
                raise RuntimeError("offline footprint returned invalid {}".format(field))
        if scan["raw_bytes"] != scan["key_bytes"] + scan["value_bytes"]:
            raise RuntimeError("offline footprint raw byte total is inconsistent")
        if not SHA256_PATTERN.fullmatch(str(scan.get("content_sha256", ""))):
            raise RuntimeError("offline footprint returned an invalid digest")
    return measured


def stable_fields(scan: Dict[str, Any]) -> Tuple[Any, ...]:
    return (
        scan["keys"],
        scan["key_bytes"],
        scan["value_bytes"],
        scan["raw_bytes"],
        scan["content_sha256"],
    )


def baseline_delta(
    baseline_path: pathlib.Path,
    stable: Dict[str, Dict[str, Any]],
    actor_count: Optional[int],
) -> Dict[str, Any]:
    if actor_count is None or actor_count <= 0:
        raise ValueError("baseline comparison requires a positive actor-count")
    document = json.loads(baseline_path.read_text())
    baseline = document.get("stable")
    if document.get("verdict") != "passed" or not isinstance(baseline, dict):
        raise ValueError("baseline is not a passed footprint receipt")
    result = {}
    for scope, final in stable.items():
        before = baseline.get(scope)
        if not isinstance(before, dict):
            raise ValueError("baseline is missing scope {}".format(scope))
        delta = {}
        per_actor = {}
        for field in ("keys", "key_bytes", "value_bytes", "raw_bytes"):
            prior = before.get(field)
            if not isinstance(prior, int):
                raise ValueError("baseline has invalid {} for {}".format(field, scope))
            change = final[field] - prior
            if change < 0:
                raise RuntimeError(
                    "{} {} shrank between baseline and final receipt".format(scope, field)
                )
            delta[field] = change
            per_actor[field] = change / actor_count
        result[scope] = {"delta": delta, "per_actor": per_actor}
    return {
        "actor_count": actor_count,
        "baseline": str(baseline_path.resolve()),
        "scopes": result,
        "attribution": "dedicated Cell delta with no unrelated writers or datasets",
    }


def run_qualification(args: argparse.Namespace) -> Dict[str, Any]:
    if args.passes < 2:
        raise ValueError("passes must be at least 2 for a stable footprint proof")
    if args.limit <= 0 or args.limit > 1_000:
        raise ValueError("limit must be between 1 and 1000")
    scopes = args.scope or list(VALID_SCOPES)
    if len(set(scopes)) != len(scopes):
        raise ValueError("scope values must be unique")
    if any(scope not in VALID_SCOPES for scope in scopes):
        raise ValueError("scope must be application, depot, or gasoline")
    token = None
    if args.auth_token_env:
        token = os.environ.get(args.auth_token_env)
        if token is None:
            raise ValueError(
                "auth token environment variable {} is not set".format(
                    args.auth_token_env
                )
            )

    offline = args.engine_bin is not None
    if offline != (args.config is not None):
        raise ValueError("engine-bin and config must be provided together")
    if offline:
        require_offline_engine(args)

    results = {}  # type: Dict[str, List[Dict[str, Any]]]
    for pass_index in range(args.passes):
        if offline:
            require_offline_engine(args)
            measured = scan_offline(args, scopes)
            for scope in scopes:
                results.setdefault(scope, []).append(measured[scope])
        else:
            for scope in scopes:
                results.setdefault(scope, []).append(
                    scan_scope(
                        args.api_url,
                        scope,
                        args.limit,
                        args.request_timeout_seconds,
                        token,
                    )
                )
        if pass_index + 1 < args.passes and args.pause_seconds:
            time.sleep(args.pause_seconds)
    if offline:
        require_offline_engine(args)

    unstable = {
        scope: scans
        for scope, scans in results.items()
        if any(stable_fields(scan) != stable_fields(scans[0]) for scan in scans[1:])
    }
    if unstable:
        raise RuntimeError(
            "footprint changed between passes; stop every application writer before measuring: {}".format(
                ", ".join(sorted(unstable))
            )
        )

    stable = {scope: scans[0] for scope, scans in results.items()}
    if all(scope in stable for scope in VALID_SCOPES):
        if stable["application"]["keys"] < (
            stable["depot"]["keys"] + stable["gasoline"]["keys"]
        ):
            raise RuntimeError("application key count is smaller than disjoint Depot + Gasoline")
        if stable["application"]["raw_bytes"] < (
            stable["depot"]["raw_bytes"] + stable["gasoline"]["raw_bytes"]
        ):
            raise RuntimeError("application bytes are smaller than disjoint Depot + Gasoline")

    receipt = {
        "verdict": "passed",
        "acquisition": "offline-engine-cli" if offline else "live-api",
        "cell_id": args.cell_id,
        "passes": args.passes,
        "writers_required_stopped": True,
        "byte_semantics": "raw logical key+value bytes; excludes FDB/storage replication overhead",
        "scopes": results,
        "stable": stable,
    }
    if not offline:
        receipt["api_url"] = args.api_url.rstrip("/")
    if args.baseline is not None:
        receipt["baseline_delta"] = baseline_delta(
            args.baseline, stable, args.actor_count
        )
    return receipt


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://127.0.0.1:6420")
    parser.add_argument("--engine-bin", type=pathlib.Path)
    parser.add_argument("--config", type=pathlib.Path)
    parser.add_argument("--engine-service", default="actor-rivet-engine.service")
    parser.add_argument("--offline-timeout-seconds", type=float, default=3600)
    parser.add_argument("--cell-id")
    parser.add_argument("--execution-site-file", type=pathlib.Path)
    parser.add_argument("--scope", action="append", choices=VALID_SCOPES)
    parser.add_argument("--passes", type=int, default=2)
    parser.add_argument("--limit", type=int, default=1_000)
    parser.add_argument("--pause-seconds", type=float, default=1.0)
    parser.add_argument("--request-timeout-seconds", type=float, default=30.0)
    parser.add_argument(
        "--auth-token-env",
        help="environment variable containing an API bearer token; never pass a token on argv",
    )
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--baseline", type=pathlib.Path)
    parser.add_argument("--actor-count", type=int)
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
