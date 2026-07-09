#!/usr/bin/env python3
"""Export compact Hermes session summaries through Tencent Cloud TAT.

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
import statistics
import sys
import time
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
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
DEFAULT_NAME_PREFIX = ""
DEFAULT_CREATED_AFTER = ""


@dataclass
class SessionRow:
    instance_id: str
    instance_name: str
    started_at_raw: str
    started_at_iso: str
    source: str
    model: str
    message_count: int
    title: str


@dataclass
class InstanceResult:
    instance_id: str
    instance_name: str = ""
    task_status: str = ""
    exit_code: int | None = None
    dropped: int = 0
    session_count: int = 0
    parsed_count: int = 0
    output_bytes: int = 0
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
  echo "__HERMES_SESSION_ERROR__ python_not_found"
  exit 127
fi

hermes sessions export - 2>&1 | "$pybin" -c '
import json
import sys

def clean(value):
    if value is None:
        return ""
    text = str(value)
    text = text.replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return text[:160]

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        session = json.loads(line)
    except Exception:
        continue
    messages = session.get("messages") or []
    title = session.get("title") or "(无标题)"
    values = [
        clean(session.get("started_at", "")),
        clean(session.get("source", "")),
        clean(session.get("model", "")),
        str(len(messages)),
        clean(title),
    ]
    print("\t".join(values))
'
"""


def run_command(client: TencentCloudClient, region: str, instance_ids: list[str], timeout: int) -> str:
    script = build_remote_script()
    response = client.request(
        "tat",
        "RunCommand",
        "2020-10-28",
        region,
        {
            "CommandName": "hermes-session-summaries",
            "Description": "Export compact Hermes session summaries",
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


def poll_tasks(
    client: TencentCloudClient,
    region: str,
    invocation_id: str,
    poll_interval: int,
    max_wait: int,
) -> list[dict[str, Any]]:
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


def to_iso_timestamp(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        value = float(text)
    except ValueError:
        return text
    try:
        return dt.datetime.fromtimestamp(value, dt.UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return text


def parse_sessions_output(instance_id: str, instance_name: str, output: str) -> tuple[list[SessionRow], int]:
    rows: list[SessionRow] = []
    malformed = 0
    for line in output.splitlines():
        if not line.strip():
            continue
        if line.startswith("__HERMES_SESSION_ERROR__"):
            malformed += 1
            continue
        parts = line.split("\t")
        if len(parts) != 5:
            malformed += 1
            continue
        started_at, source, model, message_count, title = parts
        try:
            msg_count = int(message_count)
        except ValueError:
            malformed += 1
            continue
        rows.append(
            SessionRow(
                instance_id=instance_id,
                instance_name=instance_name,
                started_at_raw=started_at,
                started_at_iso=to_iso_timestamp(started_at),
                source=source,
                model=model,
                message_count=msg_count,
                title=title,
            )
        )
    return rows, malformed


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * pct
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    weight = pos - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def summarize(rows: list[SessionRow], instances: list[InstanceResult]) -> dict[str, Any]:
    parsed_instances = [item for item in instances if item.error == ""]
    active_instances = [item for item in parsed_instances if item.session_count > 0]
    skipped_instances = [item for item in instances if item.error]
    dropped_instances = [item for item in instances if item.dropped > 0]
    source_counter = Counter(row.source or "(empty)" for row in rows)
    model_counter = Counter(row.model or "(empty)" for row in rows)
    title_counter = Counter(row.title or "(empty)" for row in rows)
    source_model_counter = Counter((row.source or "(empty)", row.model or "(empty)") for row in rows)
    instance_session_counts = [item.session_count for item in parsed_instances]
    active_session_counts = [item.session_count for item in active_instances]
    message_counts = [row.message_count for row in rows]
    return {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "matched_instances": len(instances),
        "parsed_instances": len(parsed_instances),
        "active_instances": len(active_instances),
        "zero_session_instances": len(parsed_instances) - len(active_instances),
        "skipped_instances": len(skipped_instances),
        "partial_output_instances": len(dropped_instances),
        "total_sessions": len(rows),
        "total_messages_in_sessions": sum(message_counts),
        "avg_sessions_per_parsed_instance": statistics.mean(instance_session_counts) if instance_session_counts else 0,
        "median_sessions_per_parsed_instance": statistics.median(instance_session_counts) if instance_session_counts else 0,
        "avg_sessions_per_active_instance": statistics.mean(active_session_counts) if active_session_counts else 0,
        "median_sessions_per_active_instance": statistics.median(active_session_counts) if active_session_counts else 0,
        "p90_sessions_per_active_instance": percentile(active_session_counts, 0.90),
        "p95_sessions_per_active_instance": percentile(active_session_counts, 0.95),
        "p99_sessions_per_active_instance": percentile(active_session_counts, 0.99),
        "avg_messages_per_session": statistics.mean(message_counts) if message_counts else 0,
        "median_messages_per_session": statistics.median(message_counts) if message_counts else 0,
        "p90_messages_per_session": percentile(message_counts, 0.90),
        "p95_messages_per_session": percentile(message_counts, 0.95),
        "p99_messages_per_session": percentile(message_counts, 0.99),
        "top_sources": source_counter.most_common(20),
        "top_models": model_counter.most_common(20),
        "top_titles": title_counter.most_common(50),
        "top_source_models": [(source, model, count) for (source, model), count in source_model_counter.most_common(50)],
        "task_status_distribution": Counter(item.task_status or "(empty)" for item in instances),
        "error_distribution": Counter(item.error for item in skipped_instances),
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


def write_outputs(out_dir: Path, rows: list[SessionRow], instances: list[InstanceResult], raw_tasks: list[dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    summary = summarize(rows, instances)
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, default=dict), encoding="utf-8")
    (out_dir / "raw_tasks.json").write_text(json.dumps(raw_tasks, ensure_ascii=False, indent=2), encoding="utf-8")
    write_csv(out_dir / "sessions.csv", [asdict(row) for row in rows])
    write_csv(out_dir / "instances.csv", [asdict(item) for item in instances])
    skipped = [asdict(item) for item in instances if item.error]
    write_csv(out_dir / "skipped.csv", skipped)

    source_rows = [{"source": source, "sessions": count} for source, count in Counter(row.source or "(empty)" for row in rows).most_common()]
    model_rows = [{"model": model, "sessions": count} for model, count in Counter(row.model or "(empty)" for row in rows).most_common()]
    title_rows = [{"title": title, "sessions": count} for title, count in Counter(row.title or "(empty)" for row in rows).most_common()]
    instance_rows = sorted([asdict(item) for item in instances], key=lambda item: item["session_count"], reverse=True)
    source_model = Counter((row.source or "(empty)", row.model or "(empty)") for row in rows)
    source_model_rows = [
        {"source": source, "model": model, "sessions": count}
        for (source, model), count in source_model.most_common()
    ]
    write_csv(out_dir / "stats_sources.csv", source_rows)
    write_csv(out_dir / "stats_models.csv", model_rows)
    write_csv(out_dir / "stats_titles.csv", title_rows)
    write_csv(out_dir / "stats_instances.csv", instance_rows)
    write_csv(out_dir / "stats_source_models.csv", source_model_rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Hermes session summaries via Tencent Cloud TAT.")
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--all-running", action="store_true")
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
    if args.all_running:
        instance_names = describe_instances(client, args.region, args.created_after, args.name_prefix)
        instance_ids = sorted(instance_names)
    else:
        instance_ids = list(args.instance_id)
        if args.instance_file:
            with Path(args.instance_file).open(encoding="utf-8") as fp:
                instance_ids.extend(line.strip() for line in fp if line.strip() and not line.startswith("#"))
        instance_names = describe_instances_by_ids(client, args.region, instance_ids)

    if args.offset:
        instance_ids = instance_ids[args.offset :]
    if args.limit:
        instance_ids = instance_ids[: args.limit]
    if not instance_ids:
        parser.error("No target instances selected.")

    all_rows: list[SessionRow] = []
    all_results: list[InstanceResult] = []
    all_tasks: list[dict[str, Any]] = []
    for batch_index, batch in enumerate(chunked(instance_ids, args.batch_size), start=1):
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
                    all_results.append(
                        InstanceResult(
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
            dropped = int(result.get("Dropped") or 0)
            rows, malformed = parse_sessions_output(instance_id, instance_names.get(instance_id, ""), output)
            error = task.get("ErrorInfo", "") or ""
            status = task.get("TaskStatus", "")
            if status != "SUCCESS":
                error = (error + " | " if error else "") + f"TaskStatus={status}"
            elif result.get("ExitCode") not in (0, None):
                error = (error + " | " if error else "") + f"ExitCode={result.get('ExitCode')}"
            elif malformed and not rows and output:
                error = (error + " | " if error else "") + "output_not_parsed"
            if dropped:
                error = (error + " | " if error else "") + f"output_dropped={dropped}"

            all_rows.extend(rows)
            all_results.append(
                InstanceResult(
                    instance_id=instance_id,
                    instance_name=instance_names.get(instance_id, ""),
                    task_status=status,
                    exit_code=result.get("ExitCode"),
                    dropped=dropped,
                    session_count=len(rows),
                    parsed_count=len(rows),
                    output_bytes=len(output.encode("utf-8")),
                    error=error,
                    invocation_id=invocation_id,
                    batch_index=batch_index,
                )
            )

    out_dir = Path(args.out_dir or f"hermes_session_results/{dt.datetime.now().strftime('%Y%m%d_%H%M%S')}")
    write_outputs(out_dir, all_rows, all_results, all_tasks)
    summary = summarize(all_rows, all_results)
    print(json.dumps({"summary": summary, "out_dir": str(out_dir)}, ensure_ascii=False, indent=2, default=dict))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
