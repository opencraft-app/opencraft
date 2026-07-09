#!/usr/bin/env python3
"""Merge Hermes channel collection results back to an account/CVM TSV.

Inputs:
  - an account table with account_id, instance_ids, actual_cvm_ids, bound_email
  - hermes_channels_tat.py outputs: cvm_channel_summary.csv and channel_detail.csv

Outputs are local only. This script does not call Tencent Cloud or touch CVMs.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


DEFAULT_CORE_CHANNELS = [
    "weixin",
    "feishu",
    "qqbot",
    "lightclawbot",
    "wecom",
    "wecom_callback",
    "yuanbao",
    "telegram",
    "dingtalk",
    "email",
    "webhook",
]


def read_delimited(path: Path, delimiter: str | None = None) -> list[dict[str, str]]:
    if delimiter is None:
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    with path.open(encoding="utf-8-sig", newline="") as fp:
        return list(csv.DictReader(fp, delimiter=delimiter))


def read_fields(path: Path, delimiter: str | None = None) -> list[str]:
    if delimiter is None:
        delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    with path.open(encoding="utf-8-sig", newline="") as fp:
        return list(csv.DictReader(fp, delimiter=delimiter).fieldnames or [])


def write_delimited(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    with path.open("w", encoding="utf-8-sig", newline="") as fp:
        writer = csv.DictWriter(fp, fieldnames=fieldnames, delimiter=delimiter)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key, "") for key in fieldnames})


def split_ids(value: str) -> list[str]:
    parts = re.split(r"[,;|\s，；]+", value or "")
    return [part.strip() for part in parts if part.strip()]


def to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def compact_json(value: Any, limit: int = 12000) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(text) > limit:
        return text[: limit - 20] + "...[TRUNCATED]"
    return text


def is_partial(instance: dict[str, str]) -> bool:
    error = instance.get("error") or ""
    return to_int(instance.get("dropped")) > 0 or "output_dropped" in error


def is_success(instance: dict[str, str]) -> bool:
    if not instance:
        return False
    if is_partial(instance):
        return False
    if instance.get("error"):
        return False
    status = instance.get("task_status") or ""
    exit_code = instance.get("exit_code")
    return status == "SUCCESS" and str(exit_code) in ("", "0")


def is_failed(instance: dict[str, str]) -> bool:
    if not instance:
        return True
    if is_partial(instance):
        return False
    return not is_success(instance)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-tsv", required=True, type=Path, help="Source TSV with account_id and actual_cvm_ids columns.")
    parser.add_argument("--channel-dir", type=Path, help="Directory containing cvm_channel_summary.csv and channel_detail.csv.")
    parser.add_argument("--cvm-summary", type=Path, help="Path to cvm_channel_summary.csv. Overrides --channel-dir.")
    parser.add_argument("--channel-detail", type=Path, help="Path to channel_detail.csv. Overrides --channel-dir.")
    parser.add_argument("--out-dir", required=True, type=Path, help="Output directory for merged local artifacts.")
    parser.add_argument("--output-prefix", help="Output filename prefix. Defaults to account TSV stem.")
    parser.add_argument(
        "--core-channel",
        action="append",
        dest="core_channels",
        help="Channel type to emit as a has_<type> column. Can be repeated; defaults to common Hermes channels.",
    )
    return parser.parse_args()


def resolve_inputs(args: argparse.Namespace) -> tuple[Path, Path]:
    if args.channel_dir:
        cvm_summary = args.cvm_summary or args.channel_dir / "cvm_channel_summary.csv"
        channel_detail = args.channel_detail or args.channel_dir / "channel_detail.csv"
    else:
        if not args.cvm_summary or not args.channel_detail:
            raise SystemExit("Provide either --channel-dir or both --cvm-summary and --channel-detail.")
        cvm_summary = args.cvm_summary
        channel_detail = args.channel_detail
    if not cvm_summary.exists():
        raise SystemExit(f"Missing CVM summary: {cvm_summary}")
    if not channel_detail.exists():
        raise SystemExit(f"Missing channel detail: {channel_detail}")
    return cvm_summary, channel_detail


def main() -> None:
    args = parse_args()
    cvm_summary_path, channel_detail_path = resolve_inputs(args)
    prefix = args.output_prefix or args.account_tsv.stem
    core_channels = args.core_channels or DEFAULT_CORE_CHANNELS

    source_fields = read_fields(args.account_tsv, delimiter="\t")
    cvm_rows = read_delimited(cvm_summary_path)
    channel_rows = read_delimited(channel_detail_path)
    instances = {row.get("instance_id", ""): row for row in cvm_rows if row.get("instance_id")}

    channels_by_cvm: dict[str, list[dict[str, str]]] = {}
    for row in channel_rows:
        instance_id = row.get("instance_id") or ""
        if instance_id:
            channels_by_cvm.setdefault(instance_id, []).append(row)

    account_rows: list[dict[str, Any]] = []
    detail_rows: list[dict[str, Any]] = []
    status_counter: Counter[str] = Counter()
    account_type_counter: Counter[str] = Counter()
    account_channel_count_counter: Counter[int] = Counter()
    account_with_cvm = 0
    account_without_cvm = 0
    account_has_channel = 0
    account_multi_channel = 0
    users: dict[str, dict[str, Any]] = {}

    for row in read_delimited(args.account_tsv, delimiter="\t"):
        account_id = (row.get("account_id") or "").strip()
        cvm_ids = split_ids(row.get("actual_cvm_ids", ""))
        if cvm_ids:
            account_with_cvm += 1
        else:
            account_without_cvm += 1

        related_instances = [instances.get(cvm_id, {}) for cvm_id in cvm_ids]
        related_channels = [channel for cvm_id in cvm_ids for channel in channels_by_cvm.get(cvm_id, [])]

        success_count = sum(1 for item in related_instances if is_success(item))
        partial_count = sum(1 for item in related_instances if item and is_partial(item))
        failed_count = sum(1 for item in related_instances if is_failed(item))
        total_channel_count = len(related_channels)
        type_counter = Counter((channel.get("channel_type") or "(unknown)") for channel in related_channels)
        channel_types = sorted(type_counter)
        channel_summary = "; ".join(f"{key}:{value}" for key, value in sorted(type_counter.items()))

        if not cvm_ids:
            fetch_status = "no_cvm_id"
        elif failed_count == 0 and partial_count == 0:
            fetch_status = "success"
        elif success_count + partial_count > 0:
            fetch_status = "partial_success"
        else:
            fetch_status = "failed"
        status_counter[fetch_status] += 1

        if total_channel_count:
            account_has_channel += 1
        if total_channel_count > 1:
            account_multi_channel += 1
        account_channel_count_counter[total_channel_count] += 1
        for channel_type in channel_types:
            account_type_counter[channel_type] += 1

        errors = []
        for cvm_id, item in zip(cvm_ids, related_instances):
            if not item:
                errors.append(f"{cvm_id}:missing_result")
            elif item.get("error"):
                errors.append(f"{cvm_id}:{item.get('error')}")

        channel_json = []
        for channel in related_channels:
            channel_json_item = {
                "actual_cvm_id": channel.get("instance_id", ""),
                "channel_type": channel.get("channel_type", ""),
                "channel_name": channel.get("channel_name", ""),
                "channel_id": channel.get("channel_id", ""),
                "enabled": channel.get("enabled", ""),
                "status": channel.get("status", ""),
                "summary": channel.get("summary", ""),
                "raw_channel_redacted_json": channel.get("raw_channel_redacted_json", ""),
            }
            channel_json.append(channel_json_item)
            detail_rows.append(
                {
                    "account_id": account_id,
                    "bound_email": row.get("bound_email", ""),
                    "business_instance_ids": row.get("instance_ids", ""),
                    "actual_cvm_id": channel.get("instance_id", ""),
                    "channel_type": channel.get("channel_type", ""),
                    "channel_name": channel.get("channel_name", ""),
                    "channel_id": channel.get("channel_id", ""),
                    "channel_enabled": channel.get("enabled", ""),
                    "channel_status": channel.get("status", ""),
                    "channel_summary": channel.get("summary", ""),
                    "raw_channel_redacted_json": channel.get("raw_channel_redacted_json", ""),
                    "fetch_status": fetch_status,
                    "fetch_error": " | ".join(errors),
                }
            )

        augmented = dict(row)
        augmented.update(
            {
                "channel_fetch_status": fetch_status,
                "channel_fetch_error": " | ".join(errors),
                "channel_cvm_count": len(cvm_ids),
                "channel_success_cvm_count": success_count,
                "channel_partial_cvm_count": partial_count,
                "channel_failed_cvm_count": failed_count,
                "channel_count_total": total_channel_count,
                "channel_types": ",".join(channel_types),
                "channel_summary": channel_summary,
                "channel_json_redacted": compact_json(channel_json),
            }
        )
        for channel_type in core_channels:
            augmented[f"has_{channel_type}"] = "1" if channel_type in type_counter else "0"
        known = set(core_channels)
        augmented["has_other_channel"] = "1" if any(channel_type not in known for channel_type in type_counter) else "0"
        account_rows.append(augmented)

        if account_id:
            user = users.setdefault(account_id, {"has_email": False, "all_types": set(), "non_lightclawbot_types": set(), "rows": 0})
            user["rows"] += 1
            if (row.get("bound_email") or "").strip():
                user["has_email"] = True
            user["all_types"].update(channel_types)
            user["non_lightclawbot_types"].update(channel_type for channel_type in channel_types if channel_type != "lightclawbot")

    account_fields = [
        *source_fields,
        "channel_fetch_status",
        "channel_fetch_error",
        "channel_cvm_count",
        "channel_success_cvm_count",
        "channel_partial_cvm_count",
        "channel_failed_cvm_count",
        "channel_count_total",
        "channel_types",
        "channel_summary",
        "channel_json_redacted",
        *[f"has_{channel_type}" for channel_type in core_channels],
        "has_other_channel",
    ]
    detail_fields = [
        "account_id",
        "bound_email",
        "business_instance_ids",
        "actual_cvm_id",
        "channel_type",
        "channel_name",
        "channel_id",
        "channel_enabled",
        "channel_status",
        "channel_summary",
        "raw_channel_redacted_json",
        "fetch_status",
        "fetch_error",
    ]

    all_users = set(users)
    email_users = {account_id for account_id, user in users.items() if user["has_email"]}
    non_lightclawbot_users = {account_id for account_id, user in users.items() if user["non_lightclawbot_types"]}
    qualified_users = email_users | non_lightclawbot_users
    not_qualified = all_users - qualified_users
    non_lightclawbot_type_counter: Counter[str] = Counter()
    for user in users.values():
        for channel_type in user["non_lightclawbot_types"]:
            non_lightclawbot_type_counter[channel_type] += 1

    summary = {
        "account_rows": len(account_rows),
        "unique_account_ids": len(all_users),
        "duplicate_account_rows": len(account_rows) - len(all_users),
        "accounts_with_cvm": account_with_cvm,
        "accounts_without_cvm": account_without_cvm,
        "accounts_with_channels": account_has_channel,
        "accounts_without_channels_or_without_cvm": len(account_rows) - account_has_channel,
        "accounts_multi_channel": account_multi_channel,
        "account_fetch_status_distribution": dict(status_counter),
        "account_channel_type_distribution": dict(account_type_counter.most_common()),
        "account_channel_count_distribution": dict(sorted(account_channel_count_counter.items())),
        "deduped_user_rule_email_or_non_lightclawbot": {
            "qualified_user_ids": len(qualified_users),
            "email_users": len(email_users),
            "non_lightclawbot_channel_users": len(non_lightclawbot_users),
            "both_email_and_non_lightclawbot": len(email_users & non_lightclawbot_users),
            "email_only_no_non_lightclawbot": len(email_users - non_lightclawbot_users),
            "non_lightclawbot_only_no_email": len(non_lightclawbot_users - email_users),
            "not_qualified": len(not_qualified),
            "not_qualified_with_lightclawbot_only": sum(1 for account_id in not_qualified if users[account_id]["all_types"] == {"lightclawbot"}),
            "not_qualified_with_no_channel": sum(1 for account_id in not_qualified if not users[account_id]["all_types"]),
            "non_lightclawbot_type_user_presence": dict(non_lightclawbot_type_counter.most_common()),
        },
    }

    account_out = args.out_dir / f"{prefix}_channels.tsv"
    detail_out = args.out_dir / f"{prefix}_channel_detail.csv"
    summary_json_out = args.out_dir / f"{prefix}_summary.json"
    summary_csv_out = args.out_dir / f"{prefix}_summary.csv"

    write_delimited(account_out, account_rows, account_fields)
    write_delimited(detail_out, detail_rows, detail_fields)
    summary_json_out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    summary_rows = [
        {"metric": "account_rows", "value": summary["account_rows"]},
        {"metric": "unique_account_ids", "value": summary["unique_account_ids"]},
        {"metric": "duplicate_account_rows", "value": summary["duplicate_account_rows"]},
        {"metric": "accounts_with_cvm", "value": summary["accounts_with_cvm"]},
        {"metric": "accounts_with_channels", "value": summary["accounts_with_channels"]},
        {"metric": "accounts_multi_channel", "value": summary["accounts_multi_channel"]},
        {
            "metric": "qualified_user_ids_email_or_non_lightclawbot",
            "value": summary["deduped_user_rule_email_or_non_lightclawbot"]["qualified_user_ids"],
        },
    ]
    write_delimited(summary_csv_out, summary_rows, ["metric", "value"])
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
