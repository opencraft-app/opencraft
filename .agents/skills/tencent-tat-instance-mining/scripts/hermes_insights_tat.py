#!/usr/bin/env python3
"""Run `hermes insights` on Tencent Cloud CVMs through TAT and summarize usage.

Credentials are read from environment variables:
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY
  TENCENTCLOUD_TOKEN (optional, for temporary credentials)
"""

from __future__ import annotations

import argparse
import base64
import csv
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_REGION = "ap-shanghai"
DEFAULT_DAYS = 30
DEFAULT_CREATED_AFTER = ""
DEFAULT_NAME_PREFIX = ""
TERMINAL_STATUSES = {"SUCCESS", "FAILED", "TIMEOUT", "CANCELLED", "START_FAILED", "DELIVER_FAILED"}


class TencentCloudAPIError(RuntimeError):
    pass


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


class TencentCloudClient:
    def __init__(self, secret_id: str, secret_key: str, token: str | None = None) -> None:
        self.secret_id = secret_id
        self.secret_key = secret_key
        self.token = token
        self.ssl_context = self._build_ssl_context()

    @staticmethod
    def _build_ssl_context() -> ssl.SSLContext:
        try:
            import certifi  # type: ignore

            return ssl.create_default_context(cafile=certifi.where())
        except Exception:
            return ssl.create_default_context()

    def request(self, service: str, action: str, version: str, region: str, params: dict[str, Any]) -> dict[str, Any]:
        host = f"{service}.tencentcloudapi.com"
        endpoint = f"https://{host}"
        payload = json.dumps(params, separators=(",", ":"), ensure_ascii=False)
        timestamp = int(time.time())
        date = dt.datetime.fromtimestamp(timestamp, dt.UTC).strftime("%Y-%m-%d")

        http_request_method = "POST"
        canonical_uri = "/"
        canonical_querystring = ""
        content_type = "application/json; charset=utf-8"
        canonical_headers = f"content-type:{content_type}\nhost:{host}\n"
        signed_headers = "content-type;host"
        hashed_request_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        canonical_request = "\n".join(
            [
                http_request_method,
                canonical_uri,
                canonical_querystring,
                canonical_headers,
                signed_headers,
                hashed_request_payload,
            ]
        )

        algorithm = "TC3-HMAC-SHA256"
        credential_scope = f"{date}/{service}/tc3_request"
        hashed_canonical_request = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()
        string_to_sign = "\n".join([algorithm, str(timestamp), credential_scope, hashed_canonical_request])

        secret_date = _sign(("TC3" + self.secret_key).encode("utf-8"), date)
        secret_service = _sign(secret_date, service)
        secret_signing = _sign(secret_service, "tc3_request")
        signature = hmac.new(secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"{algorithm} Credential={self.secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )

        headers = {
            "Authorization": authorization,
            "Content-Type": content_type,
            "Host": host,
            "X-TC-Action": action,
            "X-TC-Version": version,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Region": region,
        }
        if self.token:
            headers["X-TC-Token"] = self.token

        req = urllib.request.Request(endpoint, data=payload.encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30, context=self.ssl_context) as resp:
                body = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise TencentCloudAPIError(f"{action} HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise TencentCloudAPIError(f"{action} request failed: {exc}") from exc

        data = json.loads(body)
        response = data.get("Response", data)
        if "Error" in response:
            err = response["Error"]
            raise TencentCloudAPIError(f"{action} {err.get('Code')}: {err.get('Message')}")
        return response


@dataclass
class InstanceMetrics:
    instance_id: str
    instance_name: str = ""
    task_status: str = ""
    exit_code: int | None = None
    error: str = ""
    period: str = ""
    sessions: int | None = None
    messages: int | None = None
    tool_calls: int | None = None
    user_messages: int | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    uncategorized_tokens: int | None = None
    active_time: str = ""
    active_days: int | None = None
    avg_session: str = ""
    avg_msgs_session: float | None = None
    peak_hours: str = ""
    best_streak_days: int | None = None
    longest_session: str = ""
    most_messages: str = ""
    most_tokens: str = ""
    tokens_per_configured_day: float | None = None
    tokens_per_active_day: float | None = None
    tokens_per_session: float | None = None
    tokens_per_message: float | None = None
    output_token_share: float | None = None
    models: dict[str, int] = field(default_factory=dict)
    platforms: dict[str, dict[str, int]] = field(default_factory=dict)


def parse_int(value: str) -> int:
    return int(value.replace(",", "").strip())


def find_number(label: str, text: str) -> int | None:
    pattern = rf"{re.escape(label)}:\s*([0-9][0-9,]*)"
    match = re.search(pattern, text)
    return parse_int(match.group(1)) if match else None


def compute_derived_metrics(metrics: InstanceMetrics, days: int) -> None:
    if metrics.total_tokens is None:
        return
    if metrics.input_tokens is not None and metrics.output_tokens is not None:
        metrics.uncategorized_tokens = metrics.total_tokens - metrics.input_tokens - metrics.output_tokens
    if metrics.output_tokens is not None and metrics.total_tokens:
        metrics.output_token_share = metrics.output_tokens / metrics.total_tokens
    metrics.tokens_per_configured_day = metrics.total_tokens / days
    if metrics.active_days:
        metrics.tokens_per_active_day = metrics.total_tokens / metrics.active_days
    if metrics.sessions:
        metrics.tokens_per_session = metrics.total_tokens / metrics.sessions
    if metrics.messages:
        metrics.tokens_per_message = metrics.total_tokens / metrics.messages


def parse_hermes_output(instance_id: str, output: str, days: int, instance_name: str = "") -> InstanceMetrics:
    metrics = InstanceMetrics(instance_id=instance_id, instance_name=instance_name)
    if "No sessions found" in output:
        metrics.sessions = 0
        metrics.messages = 0
        metrics.tool_calls = 0
        metrics.user_messages = 0
        metrics.input_tokens = 0
        metrics.output_tokens = 0
        metrics.total_tokens = 0
        compute_derived_metrics(metrics, days)
        return metrics

    period = re.search(r"Period:\s*(.+)", output)
    if period:
        metrics.period = period.group(1).strip()

    metrics.sessions = find_number("Sessions", output)
    metrics.messages = find_number("Messages", output)
    metrics.tool_calls = find_number("Tool calls", output)
    metrics.user_messages = find_number("User messages", output)
    metrics.input_tokens = find_number("Input tokens", output)
    metrics.output_tokens = find_number("Output tokens", output)
    metrics.total_tokens = find_number("Total tokens", output)
    metrics.active_days = find_number("Active days", output)

    active_time = re.search(r"Active time:\s*(.*?)\s+Avg session:", output)
    if active_time:
        metrics.active_time = active_time.group(1).strip()
    avg_session = re.search(r"Avg session:\s*([^\n]+)", output)
    if avg_session:
        metrics.avg_session = avg_session.group(1).strip()
    avg_msgs = re.search(r"Avg msgs/session:\s*([0-9.]+)", output)
    if avg_msgs:
        metrics.avg_msgs_session = float(avg_msgs.group(1))
    peak_hours = re.search(r"Peak hours:\s*(.+)", output)
    if peak_hours:
        metrics.peak_hours = peak_hours.group(1).strip()
    best_streak = re.search(r"Best streak:\s*([0-9]+)", output)
    if best_streak:
        metrics.best_streak_days = int(best_streak.group(1))

    for label, attr in [
        ("Longest session", "longest_session"),
        ("Most messages", "most_messages"),
        ("Most tokens", "most_tokens"),
    ]:
        match = re.search(rf"{re.escape(label)}\s+(.+)", output)
        if match:
            setattr(metrics, attr, match.group(1).strip())

    model_block = re.search(r"🤖 Models Used\s*[-─]+\s*(.*?)(?:\n\s*\n|\n\s*📱)", output, re.S)
    if model_block:
        for line in model_block.group(1).splitlines():
            match = re.match(r"\s*(\S.*?)\s+([0-9,]+)\s+([0-9,]+)\s*$", line)
            if match and not match.group(1).lower().startswith("model"):
                metrics.models[match.group(1).strip()] = parse_int(match.group(3))

    platform_block = re.search(r"📱 Platforms\s*[-─]+\s*(.*?)(?:\n\s*\n|\n\s*📅)", output, re.S)
    if platform_block:
        for line in platform_block.group(1).splitlines():
            match = re.match(r"\s*(\S.*?)\s+([0-9,]+)\s+([0-9,]+)\s+([0-9,]+)\s*$", line)
            if match and not match.group(1).lower().startswith("platform"):
                metrics.platforms[match.group(1).strip()] = {
                    "sessions": parse_int(match.group(2)),
                    "messages": parse_int(match.group(3)),
                    "tokens": parse_int(match.group(4)),
                }

    compute_derived_metrics(metrics, days)
    return metrics


def parse_compact_hermes_output(instance_id: str, output: str, days: int, instance_name: str = "") -> InstanceMetrics | None:
    match = re.search(r"__HERMES_INSIGHTS_JSON__(\{.*\})", output, re.S)
    if not match:
        return None
    data = json.loads(match.group(1))
    metrics = InstanceMetrics(instance_id=instance_id, instance_name=instance_name)
    for key, value in data.items():
        if hasattr(metrics, key):
            setattr(metrics, key, value)
    compute_derived_metrics(metrics, days)
    return metrics


def build_remote_script(days: int, remote_output: str) -> str:
    if remote_output == "raw":
        return f"hermes insights --days {days}"

    if remote_output == "overview":
        return f"""hermes insights --days {days} 2>&1 | awk '
BEGIN {{ in_overview = 0 }}
/No sessions found/ {{ print; exit }}
/Period:/ {{ in_overview = 1; print; next }}
/Overview/ {{ in_overview = 1; print; next }}
in_overview && /Models Used/ {{ exit }}
in_overview {{ print }}
'"""

    return f"""#!/bin/sh
set -u
tmp="${{TMPDIR:-/tmp}}/hermes-insights-$$.txt"
trap 'rm -f "$tmp"' EXIT
hermes insights --days {days} >"$tmp" 2>&1
hermes_rc=$?
pybin=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    pybin="$candidate"
    break
  fi
done
if [ -z "$pybin" ]; then
  echo "__HERMES_INSIGHTS_JSON__{{\\"error\\":\\"python_not_found_for_compact_parse\\",\\"hermes_exit_code\\":$hermes_rc}}"
  exit "$hermes_rc"
fi
"$pybin" - "$tmp" "$hermes_rc" <<'PY'
# -*- coding: utf-8 -*-
from __future__ import print_function
import io
import json
import re
import sys

path = sys.argv[1]
hermes_exit_code = int(sys.argv[2])
text = io.open(path, "r", encoding="utf-8", errors="replace").read()

def parse_int(value):
    return int(value.replace(",", "").strip())

def find_number(label):
    m = re.search(re.escape(label) + r":\\s*([0-9][0-9,]*)", text)
    return parse_int(m.group(1)) if m else None

def section_between(start, end):
    pattern = re.escape(start) + r".*?[-─]+\\s*(.*?)" + re.escape(end)
    m = re.search(pattern, text, re.S)
    return m.group(1) if m else ""

data = {{
    "remote_output_mode": "compact",
    "hermes_exit_code": hermes_exit_code,
    "period": "",
    "sessions": find_number("Sessions"),
    "messages": find_number("Messages"),
    "tool_calls": find_number("Tool calls"),
    "user_messages": find_number("User messages"),
    "input_tokens": find_number("Input tokens"),
    "output_tokens": find_number("Output tokens"),
    "total_tokens": find_number("Total tokens"),
    "active_days": find_number("Active days"),
    "models": {{}},
    "platforms": {{}},
}}

m = re.search(r"Period:\\s*(.+)", text)
if m:
    data["period"] = m.group(1).strip()
m = re.search(r"Avg session:\\s*(~?[0-9h m]+)", text)
if m:
    data["avg_session"] = m.group(1).strip()
m = re.search(r"Active time:\\s*(.*?)\\s+Avg session:", text)
if m:
    data["active_time"] = m.group(1).strip()
m = re.search(r"Avg session:\\s*([^\\n]+)", text)
if m:
    data["avg_session"] = m.group(1).strip()
m = re.search(r"Avg msgs/session:\\s*([0-9.]+)", text)
if m:
    data["avg_msgs_session"] = float(m.group(1))
m = re.search(r"Peak hours:\\s*(.+)", text)
if m:
    data["peak_hours"] = m.group(1).strip()
m = re.search(r"Best streak:\\s*([0-9]+)", text)
if m:
    data["best_streak_days"] = int(m.group(1))

for label, key in [
    ("Longest session", "longest_session"),
    ("Most messages", "most_messages"),
    ("Most tokens", "most_tokens"),
]:
    m = re.search(re.escape(label) + r"\\s+(.+)", text)
    if m:
        data[key] = m.group(1).strip()

model_block = section_between("Models Used", "Platforms")
for line in model_block.splitlines():
    m = re.match(r"\\s*(\\S.*?)\\s+([0-9,]+)\\s+([0-9,]+)\\s*$", line)
    if m and not m.group(1).lower().startswith("model"):
        data["models"][m.group(1).strip()] = parse_int(m.group(3))

platform_block = section_between("Platforms", "Activity Patterns")
for line in platform_block.splitlines():
    m = re.match(r"\\s*(\\S.*?)\\s+([0-9,]+)\\s+([0-9,]+)\\s+([0-9,]+)\\s*$", line)
    if m and not m.group(1).lower().startswith("platform"):
        data["platforms"][m.group(1).strip()] = {{
            "sessions": parse_int(m.group(2)),
            "messages": parse_int(m.group(3)),
            "tokens": parse_int(m.group(4)),
        }}

if data["total_tokens"] is None:
    data["parse_error"] = "total_tokens_not_found"
    data["tail"] = text[-2000:]

print("__HERMES_INSIGHTS_JSON__" + json.dumps(data, ensure_ascii=False, separators=(",", ":")))
PY
exit "$hermes_rc"
"""


def chunked(values: list[str], size: int) -> list[list[str]]:
    return [values[i : i + size] for i in range(0, len(values), size)]


def parse_cloud_time(value: str) -> dt.datetime | None:
    if not value:
        return None
    normalized = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        normalized = f"{normalized}T00:00:00+00:00"
    elif normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def instance_matches(item: dict[str, Any], created_after: str, name_prefix: str) -> bool:
    instance_name = item.get("InstanceName", "")
    if name_prefix and not instance_name.startswith(name_prefix):
        return False

    if created_after:
        created_time = parse_cloud_time(item.get("CreatedTime", ""))
        threshold = parse_cloud_time(created_after)
        if created_time is None or threshold is None:
            return False
        if created_time <= threshold:
            return False

    return True


def describe_instances(client: TencentCloudClient, region: str, created_after: str, name_prefix: str) -> dict[str, str]:
    instances: dict[str, str] = {}
    scanned = 0
    offset = 0
    while True:
        response = client.request(
            "cvm",
            "DescribeInstances",
            "2017-03-12",
            region,
            {
                "Offset": offset,
                "Limit": 100,
                "Filters": [{"Name": "instance-state", "Values": ["RUNNING"]}],
            },
        )
        for item in response.get("InstanceSet", []):
            scanned += 1
            if instance_matches(item, created_after, name_prefix):
                instances[item["InstanceId"]] = item.get("InstanceName", "")
        total = response.get("TotalCount", 0)
        offset += 100
        if offset >= total:
            break
    print(
        f"Selected {len(instances)} of {scanned} RUNNING instance(s) "
        f"with created_after={created_after or '-'} name_prefix={name_prefix or '-'}",
        file=sys.stderr,
    )
    return instances


def describe_instances_by_ids(client: TencentCloudClient, region: str, instance_ids: list[str]) -> dict[str, str]:
    instances: dict[str, str] = {}
    for batch in chunked(instance_ids, 100):
        response = client.request(
            "cvm",
            "DescribeInstances",
            "2017-03-12",
            region,
            {"InstanceIds": batch},
        )
        for item in response.get("InstanceSet", []):
            instances[item["InstanceId"]] = item.get("InstanceName", "")
    return instances


def run_command(
    client: TencentCloudClient,
    region: str,
    instance_ids: list[str],
    days: int,
    timeout: int,
    remote_output: str,
) -> str:
    script = build_remote_script(days, remote_output)
    response = client.request(
        "tat",
        "RunCommand",
        "2020-10-28",
        region,
        {
            "CommandName": f"hermes-insights-{days}d",
            "Description": f"Collect Hermes Insights usage for last {days} days",
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


def decode_output(task: dict[str, Any]) -> str:
    encoded = (task.get("TaskResult") or {}).get("Output") or ""
    if not encoded:
        return ""
    return base64.b64decode(encoded).decode("utf-8", errors="replace")


def summarize(metrics: list[InstanceMetrics], days: int) -> dict[str, Any]:
    successful = [m for m in metrics if m.total_tokens is not None]
    total_tokens = sum(m.total_tokens or 0 for m in successful)
    total_sessions = sum(m.sessions or 0 for m in successful)
    total_messages = sum(m.messages or 0 for m in successful)
    instance_count = len(metrics)
    successful_count = len(successful)
    model_tokens: dict[str, int] = {}
    platform_tokens: dict[str, int] = {}
    for item in successful:
        for model, tokens in item.models.items():
            model_tokens[model] = model_tokens.get(model, 0) + tokens
        for platform, values in item.platforms.items():
            platform_tokens[platform] = platform_tokens.get(platform, 0) + values.get("tokens", 0)

    return {
        "instance_count": instance_count,
        "successful_count": successful_count,
        "failed_count": instance_count - successful_count,
        "total_tokens": total_tokens,
        "avg_tokens_per_instance_30d": total_tokens / successful_count if successful_count else 0,
        "avg_tokens_per_instance_per_configured_day": total_tokens / successful_count / days if successful_count else 0,
        "total_tokens_per_configured_day": total_tokens / days if days else 0,
        "total_sessions": total_sessions,
        "total_messages": total_messages,
        "tokens_per_session": total_tokens / total_sessions if total_sessions else 0,
        "tokens_per_message": total_tokens / total_messages if total_messages else 0,
        "model_tokens": dict(sorted(model_tokens.items(), key=lambda kv: kv[1], reverse=True)),
        "platform_tokens": dict(sorted(platform_tokens.items(), key=lambda kv: kv[1], reverse=True)),
    }


def write_outputs(out_dir: Path, metrics: list[InstanceMetrics], raw: list[dict[str, Any]], summary: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "raw_tasks.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "metrics.json").write_text(
        json.dumps({"summary": summary, "instances": [asdict(m) for m in metrics]}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    rows = []
    for m in metrics:
        row = asdict(m)
        row["models"] = json.dumps(m.models, ensure_ascii=False)
        row["platforms"] = json.dumps(m.platforms, ensure_ascii=False)
        rows.append(row)
    if rows:
        with (out_dir / "metrics.csv").open("w", encoding="utf-8", newline="") as fp:
            writer = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect Hermes Insights via Tencent Cloud TAT.")
    parser.add_argument("--region", default=DEFAULT_REGION, help="Tencent Cloud region, default: ap-shanghai")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS, help="Hermes Insights window, default: 30")
    parser.add_argument("--instance-id", action="append", default=[], help="Target CVM instance ID; repeatable")
    parser.add_argument("--instance-file", default="", help="File containing target CVM instance IDs, one per line")
    parser.add_argument("--all-running", action="store_true", help="Run against all RUNNING CVMs in the region")
    parser.add_argument(
        "--invocation-id",
        action="append",
        default=[],
        help="Read an existing TAT invocation instead of running a new command; repeatable",
    )
    parser.add_argument(
        "--created-after",
        default=DEFAULT_CREATED_AFTER,
        help="Only include RUNNING instances created after this ISO date/time when using --all-running.",
    )
    parser.add_argument(
        "--name-prefix",
        default=DEFAULT_NAME_PREFIX,
        help="Only include RUNNING instances whose name starts with this prefix when using --all-running.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Limit the number of target instances, useful for sampling")
    parser.add_argument("--offset", type=int, default=0, help="Skip this many selected instances before running")
    parser.add_argument("--batch-size", type=int, default=100, help="Instances per TAT invocation, max 100 here")
    parser.add_argument("--timeout", type=int, default=300, help="Remote command timeout in seconds")
    parser.add_argument("--poll-interval", type=int, default=5, help="Polling interval in seconds")
    parser.add_argument("--max-wait", type=int, default=600, help="Max wait per batch in seconds")
    parser.add_argument(
        "--remote-output",
        choices=["overview", "compact", "raw"],
        default="overview",
        help=(
            "overview streams only the Hermes Overview section without creating files; "
            "compact parses more sections on the instance; raw returns the full report."
        ),
    )
    parser.add_argument("--out-dir", default="", help="Output directory; default: hermes_insights_results/<timestamp>")
    args = parser.parse_args()

    if args.batch_size < 1 or args.batch_size > 100:
        parser.error("--batch-size must be between 1 and 100")

    secret_id = os.environ.get("TENCENTCLOUD_SECRET_ID")
    secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY")
    token = os.environ.get("TENCENTCLOUD_TOKEN")
    if not secret_id or not secret_key:
        parser.error("Set TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY in the environment.")

    client = TencentCloudClient(secret_id, secret_key, token)
    instance_names: dict[str, str] = {}
    if args.invocation_id:
        instance_ids = []
    elif args.all_running:
        instance_names = describe_instances(client, args.region, args.created_after, args.name_prefix)
        instance_ids = sorted(instance_names)
    else:
        instance_ids = list(args.instance_id)
        if args.instance_file:
            with Path(args.instance_file).open(encoding="utf-8") as fp:
                instance_ids.extend(line.strip() for line in fp if line.strip() and not line.startswith("#"))
        instance_names = describe_instances_by_ids(client, args.region, instance_ids)

    if args.limit:
        if args.limit < 1:
            parser.error("--limit must be greater than 0")
        instance_ids = instance_ids[: args.limit]
    if args.offset:
        if args.offset < 0:
            parser.error("--offset must be greater than or equal to 0")
        instance_ids = instance_ids[args.offset :]

    if not instance_ids and not args.invocation_id:
        parser.error("Provide --instance-id or use --all-running.")

    all_tasks: list[dict[str, Any]] = []
    all_metrics: list[InstanceMetrics] = []
    batches = args.invocation_id if args.invocation_id else chunked(instance_ids, args.batch_size)
    for batch_index, batch in enumerate(batches, start=1):
        if args.invocation_id:
            invocation_id = batch
            print(f"Reading invocation {invocation_id}", file=sys.stderr)
            tasks = poll_tasks(client, args.region, invocation_id, args.poll_interval, args.max_wait)
            task_instance_ids = [task.get("InstanceId", "") for task in tasks if task.get("InstanceId")]
            instance_names = describe_instances_by_ids(client, args.region, task_instance_ids)
        else:
            print(f"Running batch {batch_index}: {len(batch)} instance(s)", file=sys.stderr)
            pending_batch = list(batch)
            tasks = []
            while pending_batch:
                try:
                    invocation_id = run_command(client, args.region, pending_batch, args.days, args.timeout, args.remote_output)
                except TencentCloudAPIError as exc:
                    bad_match = re.search(r"instance `([^`]+)`", str(exc))
                    if bad_match and bad_match.group(1) in pending_batch:
                        bad_instance_id = bad_match.group(1)
                        print(f"Skipping {bad_instance_id}: {exc}", file=sys.stderr)
                        metric = InstanceMetrics(
                            instance_id=bad_instance_id,
                            instance_name=instance_names.get(bad_instance_id, ""),
                            task_status="RUN_COMMAND_FAILED",
                            error=str(exc),
                        )
                        all_metrics.append(metric)
                        pending_batch = [item for item in pending_batch if item != bad_instance_id]
                        continue
                    raise
                tasks = poll_tasks(client, args.region, invocation_id, args.poll_interval, args.max_wait)
                break
        all_tasks.extend(tasks)
        for task in tasks:
            instance_id = task.get("InstanceId", "")
            output = decode_output(task)
            metric = parse_compact_hermes_output(instance_id, output, args.days, instance_names.get(instance_id, ""))
            if metric is None:
                metric = parse_hermes_output(instance_id, output, args.days, instance_names.get(instance_id, ""))
            metric.task_status = task.get("TaskStatus", "")
            metric.error = task.get("ErrorInfo", "")
            result = task.get("TaskResult") or {}
            metric.exit_code = result.get("ExitCode")
            if metric.total_tokens is None and output:
                metric.error = (metric.error + " | " if metric.error else "") + "Hermes output was not parsed"
            elif metric.total_tokens is None:
                metric.error = (metric.error + " | " if metric.error else "") + "Hermes output was empty"
            all_metrics.append(metric)

    summary = summarize(all_metrics, args.days)
    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir or f"hermes_insights_results/{timestamp}")
    write_outputs(out_dir, all_metrics, all_tasks, summary)

    print(json.dumps({"summary": summary, "out_dir": str(out_dir)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
