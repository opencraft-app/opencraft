#!/usr/bin/env python3
"""Collect Hermes send channel configurations through Tencent Cloud TAT.

Credentials are read from environment variables:
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY
  TENCENTCLOUD_TOKEN (optional)
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import json
import os
import re
import statistics
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from hermes_insights_tat import (
    TERMINAL_STATUSES,
    TencentCloudAPIError,
    TencentCloudClient,
    chunked,
    decode_output,
    describe_instances,
    describe_instances_by_ids,
)


DEFAULT_REGION = "ap-shanghai"
DEFAULT_CREATED_AFTER = ""
DEFAULT_NAME_PREFIX = ""


@dataclass
class ChannelRecord:
    instance_id: str
    instance_name: str = ""
    channel_index: int = 0
    channel_type: str = ""
    channel_name: str = ""
    channel_id: str = ""
    enabled: str = ""
    status: str = ""
    summary: str = ""
    raw_channel_redacted_json: str = ""


@dataclass
class InstanceChannels:
    instance_id: str
    instance_name: str = ""
    task_status: str = ""
    exit_code: int | None = None
    hermes_exit_code: int | None = None
    dropped: int = 0
    output_bytes: int = 0
    channel_count: int = 0
    channel_types: str = ""
    channel_summary: str = ""
    raw_redacted_json: str = ""
    error: str = ""
    invocation_id: str = ""
    batch_index: int | None = None


def build_remote_script() -> str:
    return r"""#!/bin/sh
pybin=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    pybin="$candidate"
    break
  fi
done
if [ -z "$pybin" ]; then
  echo "__HERMES_CHANNELS_JSON__{\"error\":\"python_not_found\",\"channels\":[],\"channel_count\":0}"
  exit 127
fi

"$pybin" - <<'PY'
import json
import re
import subprocess
import sys

SENSITIVE = re.compile(r"(token|secret|password|passwd|credential|authorization|auth|cookie|webhook|url|uri|endpoint|access[_-]?key|secret[_-]?key|key$)", re.I)
TYPE_KEYS = ("type", "channel_type", "platform", "source", "kind", "provider", "name")
NAME_KEYS = ("name", "channel_name", "display_name", "title", "remark", "label")
ID_KEYS = ("id", "channel_id", "account_id", "bot_id", "user_id", "chat_id", "open_id", "union_id")
STATUS_KEYS = ("status", "state")
GENERIC_PARENT_KEYS = {"channels", "channel_configs", "senders", "configs", "providers", "items", "data", "results", "platforms"}

def clean_text(value, limit=240):
    if value is None:
        return ""
    text = str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]

def redact(obj, key=""):
    if isinstance(obj, dict):
        return {str(k): redact(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v, key) for v in obj]
    if key and SENSITIVE.search(key):
        return "[REDACTED]" if obj not in (None, "", [], {}) else obj
    return obj

def find_first(mapping, keys):
    if not isinstance(mapping, dict):
        return ""
    lowered = {str(k).lower(): k for k in mapping}
    for key in keys:
        actual = lowered.get(key.lower())
        if actual is not None:
            return mapping.get(actual)
    return ""

def infer_enabled(mapping):
    if not isinstance(mapping, dict):
        return ""
    for key, value in mapping.items():
        lk = str(key).lower()
        if lk in ("enabled", "is_enabled", "enable"):
            return str(bool(value)).lower() if isinstance(value, bool) else clean_text(value)
        if lk in ("disabled", "is_disabled"):
            if isinstance(value, bool):
                return str(not value).lower()
            return ""
    return ""

def prune_empty(obj):
    if isinstance(obj, dict):
        pruned = {}
        for key, value in obj.items():
            child = prune_empty(value)
            if child in ({}, [], "", None):
                continue
            pruned[key] = child
        return pruned
    if isinstance(obj, list):
        return [child for child in (prune_empty(item) for item in obj) if child not in ({}, [], "", None)]
    return obj

def to_raw_json(obj, limit=1500):
    try:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        text = clean_text(obj, limit)
    return text[:limit]

def normalize_channel(obj, parent_key="", index=0):
    if not isinstance(obj, dict):
        return {
            "channel_index": index,
            "channel_type": clean_text(parent_key or type(obj).__name__),
            "channel_name": "",
            "channel_id": "",
            "enabled": "",
            "status": "",
            "summary": clean_text(obj),
            "raw_channel_redacted_json": to_raw_json(redact(obj), limit=1500),
        }
    redacted = redact(obj)
    channel_type = clean_text(parent_key if parent_key and parent_key not in GENERIC_PARENT_KEYS else find_first(obj, TYPE_KEYS))
    channel_name = clean_text(find_first(obj, NAME_KEYS))
    channel_id = clean_text(find_first(obj, ID_KEYS))
    enabled = infer_enabled(obj)
    status = clean_text(find_first(obj, STATUS_KEYS))
    parts = []
    if channel_type:
        parts.append(channel_type)
    if channel_name and channel_name != channel_type:
        parts.append(channel_name)
    if status:
        parts.append("status=" + status)
    if enabled:
        parts.append("enabled=" + enabled)
    return {
        "channel_index": index,
        "channel_type": channel_type,
        "channel_name": channel_name,
        "channel_id": channel_id,
        "enabled": enabled,
        "status": status,
        "summary": "; ".join(parts),
        "raw_channel_redacted_json": to_raw_json(redacted),
    }

def list_candidate_channels(obj, parent_key=""):
    if isinstance(obj, list):
        if all(not isinstance(item, (dict, list)) for item in obj):
            return [normalize_channel({"values": obj}, parent_key)]
        channels = []
        for item in obj:
            channels.extend(list_candidate_channels(item, parent_key))
        return channels
    if not isinstance(obj, dict):
        return []

    # Common shapes: {"channels": [...]}, {"data": [...]}, {"items": [...]}
    for key in ("channels", "channel_configs", "senders", "configs", "providers", "items", "data", "results"):
        value = obj.get(key)
        if isinstance(value, list):
            channels = []
            for item in value:
                channels.extend(list_candidate_channels(item, key))
            return channels

    # Platform map shape: {"platforms": {"weixin": [...], "qqbot": [...]}}
    for key in ("platforms", "platform"):
        value = obj.get(key)
        if isinstance(value, dict):
            channels = []
            for platform, platform_value in value.items():
                if isinstance(platform_value, list):
                    for item in platform_value:
                        channels.extend(list_candidate_channels(item, str(platform)))
                elif isinstance(platform_value, dict):
                    channels.extend(list_candidate_channels(platform_value, str(platform)))
            if channels:
                return channels

    # Map shape: {"weixin": {...}, "feishu": {...}}
    map_channels = []
    for key, value in obj.items():
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    map_channels.append(normalize_channel(item, str(key)))
        elif isinstance(value, dict):
            if any(str(k).lower() in {"enabled", "is_enabled", "status", "type", "name", "channel_id", "id"} for k in value):
                map_channels.append(normalize_channel(value, str(key)))
    if map_channels:
        return map_channels

    # Single channel object.
    if any(str(k).lower() in {"enabled", "is_enabled", "status", "type", "channel_type", "platform", "provider"} for k in obj):
        return [normalize_channel(obj, parent_key)]
    return []

def main():
    try:
        proc = subprocess.run(
            ["hermes", "send", "--list", "--json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=240,
        )
    except Exception as exc:
        print("__HERMES_CHANNELS_JSON__" + json.dumps({
            "error": "command_exception: " + str(exc),
            "channels": [],
            "channel_count": 0,
        }, ensure_ascii=False, separators=(",", ":")))
        sys.exit(1)

    stdout = proc.stdout or ""
    stderr = proc.stderr or ""
    payload = {
        "hermes_exit_code": proc.returncode,
        "stdout_bytes": len(stdout.encode("utf-8", errors="replace")),
        "stderr_tail": stderr[-500:],
        "channels": [],
        "channel_count": 0,
        "channel_types": [],
        "raw_redacted_json": "",
    }

    data = None
    if stdout.strip():
        try:
            data = json.loads(stdout)
        except Exception as exc:
            payload["parse_error"] = str(exc)
            payload["stdout_tail"] = stdout[-500:]
    else:
        payload["empty_stdout"] = True

    if data is not None:
        redacted = prune_empty(redact(data))
        channels = list_candidate_channels(data)
        for index, item in enumerate(channels, start=1):
            item["channel_index"] = index
        payload["channels"] = channels
        payload["channel_count"] = len(channels)
        payload["channel_types"] = sorted({item.get("channel_type") or "(unknown)" for item in channels})
        payload["raw_redacted_json"] = to_raw_json(redacted, limit=3000)

    print("__HERMES_CHANNELS_JSON__" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    sys.exit(proc.returncode)

main()
PY
"""


def run_command(client: TencentCloudClient, region: str, instance_ids: list[str], timeout: int) -> str:
    script = build_remote_script()
    response = client.request(
        "tat",
        "RunCommand",
        "2020-10-28",
        region,
        {
            "CommandName": "hermes-send-channel-list",
            "Description": "Collect Hermes send channel configuration summary",
            "Content": base64.b64encode(script.encode("utf-8")).decode("ascii"),
            "CommandType": "SHELL",
            "WorkingDirectory": "/home/agentuser",
            "Timeout": timeout,
            "SaveCommand": False,
            "Username": "agentuser",
            "InstanceIds": instance_ids,
        },
    )
    return response["InvocationId"]


def describe_invocation_tasks(client: TencentCloudClient, region: str, invocation_id: str) -> list[dict[str, Any]]:
    response = client.request(
        "tat",
        "DescribeInvocationTasks",
        "2020-10-28",
        region,
        {
            "Offset": 0,
            "Limit": 100,
            "HideOutput": False,
            "Filters": [{"Name": "invocation-id", "Values": [invocation_id]}],
        },
    )
    return response.get("InvocationTaskSet", [])


def poll_tasks(client: TencentCloudClient, region: str, invocation_id: str, poll_interval: int, max_wait: int) -> list[dict[str, Any]]:
    deadline = time.time() + max_wait
    last_statuses: set[str] = set()
    while True:
        tasks = describe_invocation_tasks(client, region, invocation_id)
        statuses = {task.get("TaskStatus", "UNKNOWN") for task in tasks}
        if statuses != last_statuses:
            print(f"Invocation {invocation_id}: statuses={','.join(sorted(statuses)) or 'PENDING'}", file=sys.stderr)
            last_statuses = statuses
        if tasks and all(status in TERMINAL_STATUSES for status in statuses):
            return tasks
        if time.time() >= deadline:
            raise TimeoutError(f"Timed out waiting for invocation {invocation_id}; latest statuses={sorted(statuses)}")
        time.sleep(poll_interval)


def parse_channel_payload(output: str) -> dict[str, Any] | None:
    match = re.search(r"__HERMES_CHANNELS_JSON__(\{.*\})", output, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        return {
            "parse_error": f"invalid_payload_json: {exc}",
            "channels": [],
            "channel_count": 0,
            "raw_redacted_json": "",
        }


def summarize_instance(item: InstanceChannels, channels: list[ChannelRecord]) -> None:
    counter = Counter(ch.channel_type or "(unknown)" for ch in channels)
    item.channel_count = len(channels)
    item.channel_types = ",".join(sorted(counter))
    item.channel_summary = "; ".join(f"{name}:{count}" for name, count in sorted(counter.items()))


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    weight = pos - lo
    return ordered[lo] * (1 - weight) + ordered[hi] * weight


def summarize(instances: list[InstanceChannels], channels: list[ChannelRecord]) -> dict[str, Any]:
    parsed = [item for item in instances if not item.error]
    channel_counts = [item.channel_count for item in parsed]
    active = [item for item in parsed if item.channel_count > 0]
    type_counter = Counter(ch.channel_type or "(unknown)" for ch in channels)
    status_counter = Counter(item.task_status or "(empty)" for item in instances)
    error_counter = Counter()
    for item in instances:
        if not item.error:
            continue
        if "output_dropped=" in item.error:
            error_counter["output_dropped"] += 1
        elif "AgentNotInstalled" in item.error:
            error_counter["AgentNotInstalled"] += 1
        elif "InvalidUser" in item.error:
            error_counter["InvalidUser agentuser not exists"] += 1
        elif "DELIVER_FAILED" in item.error:
            error_counter["DELIVER_FAILED"] += 1
        elif "parse" in item.error.lower():
            error_counter["parse_error"] += 1
        elif "ExitCode" in item.error:
            error_counter["nonzero_exit"] += 1
        else:
            error_counter[item.error[:160]] += 1
    return {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "matched_instances": len(instances),
        "parsed_instances": len(parsed),
        "instances_with_channels": len(active),
        "zero_channel_instances": len(parsed) - len(active),
        "skipped_instances": len(instances) - len(parsed),
        "partial_output_instances": sum(1 for item in instances if item.dropped > 0),
        "total_channels": len(channels),
        "avg_channels_per_parsed_instance": statistics.mean(channel_counts) if channel_counts else 0,
        "median_channels_per_parsed_instance": statistics.median(channel_counts) if channel_counts else 0,
        "p90_channels_per_parsed_instance": percentile(channel_counts, 0.90),
        "p95_channels_per_parsed_instance": percentile(channel_counts, 0.95),
        "p99_channels_per_parsed_instance": percentile(channel_counts, 0.99),
        "channel_type_distribution": dict(type_counter.most_common()),
        "task_status_distribution": dict(status_counter),
        "error_distribution": dict(error_counter),
    }


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if fieldnames is None and rows:
        fieldnames = list(rows[0])
    with path.open("w", encoding="utf-8-sig", newline="") as fp:
        if not fieldnames:
            fp.write("")
            return
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def write_outputs(out_dir: Path, instances: list[InstanceChannels], channels: list[ChannelRecord], raw_tasks: list[dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = summarize(instances, channels)
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "raw_tasks.json").write_text(json.dumps(raw_tasks, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "channels_by_cvm_redacted.json").write_text(
        json.dumps(
            {
                item.instance_id: {
                    "instance_name": item.instance_name,
                    "channel_count": item.channel_count,
                    "channel_types": item.channel_types,
                    "channel_summary": item.channel_summary,
                    "raw_redacted_json": item.raw_redacted_json,
                    "error": item.error,
                }
                for item in instances
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    write_csv(out_dir / "cvm_channel_summary.csv", [asdict(item) for item in instances])
    write_csv(out_dir / "channel_detail.csv", [asdict(item) for item in channels])
    write_csv(out_dir / "skipped_channels.csv", [asdict(item) for item in instances if item.error])
    type_rows = [{"channel_type": key, "channels": value} for key, value in Counter(ch.channel_type or "(unknown)" for ch in channels).most_common()]
    write_csv(out_dir / "stats_channel_types.csv", type_rows)


def load_instance_ids_from_file(path: str) -> list[str]:
    with Path(path).open(encoding="utf-8") as fp:
        return [line.strip() for line in fp if line.strip() and not line.startswith("#")]


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Hermes send channel configuration summaries via Tencent Cloud TAT.")
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--all-running", action="store_true")
    parser.add_argument(
        "--invocation-id",
        action="append",
        default=[],
        help="Read an existing TAT invocation instead of running a new command; repeatable",
    )
    parser.add_argument("--name-prefix", default=DEFAULT_NAME_PREFIX)
    parser.add_argument("--created-after", default=DEFAULT_CREATED_AFTER)
    parser.add_argument("--instance-id", action="append", default=[])
    parser.add_argument("--instance-file", default="")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--poll-interval", type=int, default=5)
    parser.add_argument("--max-wait", type=int, default=600)
    parser.add_argument("--out-dir", default="")
    args = parser.parse_args()

    if args.batch_size < 1 or args.batch_size > 100:
        parser.error("--batch-size must be between 1 and 100")

    secret_id = os.environ.get("TENCENTCLOUD_SECRET_ID")
    secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY")
    token = os.environ.get("TENCENTCLOUD_TOKEN")
    if not secret_id or not secret_key:
        parser.error("Set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY in the environment.")

    client = TencentCloudClient(secret_id, secret_key, token)
    if args.invocation_id:
        instance_ids = []
        instance_names: dict[str, str] = {}
    elif args.all_running:
        instance_names = describe_instances(client, args.region, args.created_after, args.name_prefix)
        instance_ids = sorted(instance_names)
    else:
        instance_ids = list(args.instance_id)
        if args.instance_file:
            instance_ids.extend(load_instance_ids_from_file(args.instance_file))
        # Preserve input order while removing duplicates.
        instance_ids = list(dict.fromkeys(instance_ids))
        instance_names = describe_instances_by_ids(client, args.region, instance_ids)

    if args.offset:
        instance_ids = instance_ids[args.offset :]
    if args.limit:
        instance_ids = instance_ids[: args.limit]
    if not instance_ids and not args.invocation_id:
        parser.error("No target instances selected.")

    all_instances: list[InstanceChannels] = []
    all_channels: list[ChannelRecord] = []
    all_tasks: list[dict[str, Any]] = []

    batches: list[Any] = args.invocation_id if args.invocation_id else chunked(instance_ids, args.batch_size)
    for batch_index, batch in enumerate(batches, start=1):
        if args.invocation_id:
            invocation_id = batch
            print(f"Reading invocation {invocation_id}", file=sys.stderr)
            tasks = poll_tasks(client, args.region, invocation_id, args.poll_interval, args.max_wait)
            task_instance_ids = [task.get("InstanceId", "") for task in tasks if task.get("InstanceId")]
            instance_names.update(describe_instances_by_ids(client, args.region, task_instance_ids))
        else:
            print(f"Running batch {batch_index}: {len(batch)} instance(s)", file=sys.stderr)
            pending_batch = list(batch)
            tasks: list[dict[str, Any]] = []
            invocation_id = ""
            while pending_batch:
                try:
                    invocation_id = run_command(client, args.region, pending_batch, args.timeout)
                except TencentCloudAPIError as exc:
                    bad_match = re.search(r"instance `([^`]+)`", str(exc))
                    if bad_match and bad_match.group(1) in pending_batch:
                        bad_instance_id = bad_match.group(1)
                        print(f"Skipping {bad_instance_id}: {exc}", file=sys.stderr)
                        all_instances.append(
                            InstanceChannels(
                                instance_id=bad_instance_id,
                                instance_name=instance_names.get(bad_instance_id, ""),
                                task_status="RUN_COMMAND_FAILED",
                                error=str(exc),
                                batch_index=batch_index,
                            )
                        )
                        pending_batch = [item for item in pending_batch if item != bad_instance_id]
                        continue
                    raise
                tasks = poll_tasks(client, args.region, invocation_id, args.poll_interval, args.max_wait)
                break

        all_tasks.extend(tasks)
        for task in tasks:
            instance_id = task.get("InstanceId", "")
            output = decode_output(task)
            result = task.get("TaskResult") or {}
            status = task.get("TaskStatus", "")
            dropped = int(result.get("Dropped") or 0)
            payload = parse_channel_payload(output)
            item = InstanceChannels(
                instance_id=instance_id,
                instance_name=instance_names.get(instance_id, ""),
                task_status=status,
                exit_code=result.get("ExitCode"),
                dropped=dropped,
                output_bytes=len(output.encode("utf-8")),
                invocation_id=invocation_id,
                batch_index=batch_index,
            )
            error_parts: list[str] = []
            if status != "SUCCESS":
                error_parts.append((task.get("ErrorInfo") or "") + (f" | TaskStatus={status}" if status else ""))
            if result.get("ExitCode") not in (0, None):
                error_parts.append(f"ExitCode={result.get('ExitCode')}")
            if dropped:
                error_parts.append(f"output_dropped={dropped}")
            if payload is None:
                if output:
                    error_parts.append("channels output was not parsed")
                else:
                    error_parts.append("channels output was empty")
            else:
                item.hermes_exit_code = payload.get("hermes_exit_code")
                item.raw_redacted_json = payload.get("raw_redacted_json") or ""
                if payload.get("error"):
                    error_parts.append(str(payload.get("error")))
                if payload.get("parse_error"):
                    error_parts.append("parse_error=" + str(payload.get("parse_error")))
                if payload.get("hermes_exit_code") not in (0, None):
                    error_parts.append(f"hermes_exit_code={payload.get('hermes_exit_code')}")
                channel_rows: list[ChannelRecord] = []
                for ch in payload.get("channels") or []:
                    channel_rows.append(
                        ChannelRecord(
                            instance_id=instance_id,
                            instance_name=instance_names.get(instance_id, ""),
                            channel_index=int(ch.get("channel_index") or 0),
                            channel_type=ch.get("channel_type") or "",
                            channel_name=ch.get("channel_name") or "",
                            channel_id=ch.get("channel_id") or "",
                            enabled=ch.get("enabled") or "",
                            status=ch.get("status") or "",
                            summary=ch.get("summary") or "",
                            raw_channel_redacted_json=ch.get("raw_channel_redacted_json") or "",
                        )
                    )
                all_channels.extend(channel_rows)
                summarize_instance(item, channel_rows)
            item.error = " | ".join(part for part in error_parts if part.strip())
            all_instances.append(item)

    out_dir = Path(args.out_dir or f"hermes_channel_results/{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}")
    write_outputs(out_dir, all_instances, all_channels, all_tasks)
    print(json.dumps({"summary": summarize(all_instances, all_channels), "out_dir": str(out_dir)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
