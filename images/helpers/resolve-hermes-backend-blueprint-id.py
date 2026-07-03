#!/usr/bin/env python3
"""Resolve the newest usable Hermes backend Lighthouse blueprint id."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from typing import Any


BLUEPRINT_ID_RE = re.compile(r"^lhbp-[A-Za-z0-9_-]+$")


def log(message: str) -> None:
    print(f"[resolve-hermes-blueprint] {message}", file=sys.stderr)


def parse_time(value: str) -> datetime:
    text = value.strip()
    if not text:
        return datetime.min.replace(tzinfo=timezone.utc)
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def run_tccli(region: str, limit: int, offset: int) -> dict[str, Any]:
    cmd = [
        "tccli",
        "lighthouse",
        "DescribeBlueprints",
        "--region",
        region,
        "--Limit",
        str(limit),
        "--Offset",
        str(offset),
        "--output",
        "json",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            "tccli lighthouse DescribeBlueprints failed "
            f"(exit {result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
        )
    try:
        loaded = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"tccli returned invalid JSON: {exc}") from exc
    if not isinstance(loaded, dict):
        raise RuntimeError("tccli returned non-object JSON")
    return loaded


def item_text(item: dict[str, Any]) -> str:
    fields = (
        "BlueprintName",
        "DisplayTitle",
        "DisplayName",
        "Description",
        "OsName",
        "Platform",
    )
    return "\n".join(str(item.get(field, "")) for field in fields)


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def matches_name(item: dict[str, Any], blueprint_name: str) -> bool:
    candidates = (
        str(item.get("BlueprintName", "")),
        str(item.get("DisplayTitle", "")),
        str(item.get("DisplayName", "")),
    )
    expected = normalize_name(blueprint_name)
    return any(normalize_name(candidate) == expected for candidate in candidates)


def is_excluded(item: dict[str, Any], exclude_patterns: list[str]) -> bool:
    haystack = item_text(item).lower()
    return any(pattern.lower() in haystack for pattern in exclude_patterns)


def collect_blueprints(region: str, limit: int) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    total = None
    while True:
        payload = run_tccli(region, limit, offset)
        page = payload.get("BlueprintSet") or payload.get("Blueprints") or []
        if not isinstance(page, list):
            raise RuntimeError("tccli response missing BlueprintSet list")
        items.extend(item for item in page if isinstance(item, dict))
        total = payload.get("TotalCount", total)
        offset += limit
        if total is not None and offset >= int(total):
            break
        if not page:
            break
    return items


def resolve_latest_blueprint(
    region: str,
    blueprint_name: str,
    exclude_patterns: list[str],
    limit: int,
) -> dict[str, Any]:
    blueprints = collect_blueprints(region, limit)
    candidates = []
    for item in blueprints:
        blueprint_id = str(item.get("BlueprintId", "")).strip()
        if not BLUEPRINT_ID_RE.match(blueprint_id):
            continue
        if item.get("BlueprintState") != "NORMAL":
            continue
        if not matches_name(item, blueprint_name):
            continue
        if is_excluded(item, exclude_patterns):
            continue
        candidates.append(item)
    if not candidates:
        raise RuntimeError(
            "no NORMAL Hermes blueprint matched "
            f"name={blueprint_name!r} region={region!r} excludes={exclude_patterns!r}"
        )
    candidates.sort(key=lambda item: parse_time(str(item.get("CreatedTime", ""))), reverse=True)
    return candidates[0]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=os.environ.get("HERMES_BACKEND_BLUEPRINT_REGION", "ap-beijing"))
    parser.add_argument("--name", default=os.environ.get("HERMES_BACKEND_BLUEPRINT_NAME", "hermes_agent"))
    parser.add_argument(
        "--exclude",
        action="append",
        default=None,
        help="case-insensitive substring to exclude; may be repeated",
    )
    parser.add_argument("--limit", type=int, default=100)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_id = os.environ.get("HERMES_BACKEND_BLUEPRINT_ID", "").strip()
    if env_id:
        if not BLUEPRINT_ID_RE.match(env_id):
            log(f"invalid HERMES_BACKEND_BLUEPRINT_ID: {env_id}")
            return 1
        log(f"using explicit HERMES_BACKEND_BLUEPRINT_ID={env_id}")
        print(env_id)
        return 0

    excludes = args.exclude if args.exclude is not None else ["南京", "nanjing"]
    try:
        selected = resolve_latest_blueprint(args.region, args.name, excludes, args.limit)
    except Exception as exc:
        log(str(exc))
        return 1
    blueprint_id = str(selected["BlueprintId"])
    log(
        "resolved latest Hermes blueprint "
        f"id={blueprint_id} name={selected.get('BlueprintName')} "
        f"created={selected.get('CreatedTime')} region={args.region}"
    )
    print(blueprint_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
