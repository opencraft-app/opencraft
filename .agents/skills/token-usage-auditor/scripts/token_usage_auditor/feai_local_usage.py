from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import TextIO

CNY_PER_CREDIT = Decimal("0.07")
CODEBUDDYCODE_PROVIDER = "codebuddycode"
LOCAL_USAGE_AUDIT_MAX_ITEMS = 20
LOCAL_USAGE_AUDIT_MAX_TEXT = 240
LOCAL_USAGE_AUDIT_MAX_SESSION_TEXT = 120
SUPPORTED_PROVIDERS = (
    "codex",
    "codebuddy",
    "codebuddycode",
    "codebuddy-vscode",
    "claudecode-internal",
    "gemini",
    "opencode",
)
CODEBUDDY_IDE_LOG_USAGE_RE = re.compile(
    r"Agent execution successful with usage:\s*(\{.*\})"
)
CODEBUDDY_IDE_LOG_TIME_RE = re.compile(r"^\[(\d{4})/(\d{1,2})/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})")
ABSOLUTE_PATH_RE = re.compile(r"(?<![\w.-])(?:~|/)[^\s,;:]+")


def main(argv: list[str] | None = None, stdout: TextIO | None = None, stderr: TextIO | None = None) -> int:
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    args = build_parser().parse_args(argv)

    if args.format not in ("local-usage-audit", "local-usage-diagnosis"):
        stderr.write("FE-AI bundled auditor only supports --format local-usage-audit or local-usage-diagnosis\n")
        return 2

    ctx = load_context(args.feai_project or args.project_root, args.feai_change, args.usage_context)
    provider = args.provider or ctx["provider"]
    if not provider:
        stderr.write("FE-AI usage provider is required via provider argument or usage-context.provider\n")
        return 2
    if provider not in SUPPORTED_PROVIDERS:
        stderr.write(
            "FE-AI bundled auditor only supports providers: "
            f"{', '.join(SUPPORTED_PROVIDERS)}\n"
        )
        return 2

    ctx["projectRoot"] = args.project_root or ctx["projectRoot"]
    ctx["changeName"] = args.feai_change or ctx["changeName"]
    ctx["provider"] = provider
    ctx["windowSource"] = range_source(args, ctx)
    session_ids = resolve_session_ids(args.session_id or (), ctx["sessionIds"])

    try:
        start, end = resolve_range(args, ctx)
    except ValueError as exc:
        if args.format == "local-usage-diagnosis":
            output = json.dumps(
                build_missing_window_diagnosis(ctx, session_ids, provider, str(exc)),
                ensure_ascii=False,
                indent=2,
            )
            stdout.write(output + "\n")
            return 0
        stderr.write(f"{exc}\n")
        return 2

    records = read_records(provider, resolve_roots(args.fixture_root, ctx["projectRoot"], provider))
    if args.format == "local-usage-diagnosis":
        output = json.dumps(
            build_diagnosis(ctx, session_ids, records, start, end, provider),
            ensure_ascii=False,
            indent=2,
        )
        stdout.write(output + "\n")
        return 0

    totals, notes, audit_session_ids = aggregate_with_session_fallback(
        records,
        start,
        end,
        provider,
        ctx["projectRoot"],
        session_ids,
        allow_session_fallback=not args.session_id,
    )
    output = json.dumps(
        build_audit(ctx, audit_session_ids, start, end, totals, notes, provider),
        ensure_ascii=False,
        indent=2,
    )

    if args.output:
        Path(args.output).write_text(output)
        stdout.write(f"Wrote local-usage-audit report to {args.output}\n")
    else:
        stdout.write(output + "\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Output FE-AI metadata.localUsageAudit JSON.")
    parser.add_argument("provider", nargs="?", choices=SUPPORTED_PROVIDERS, help="Defaults to usage-context provider.")
    parser.add_argument("--feai-project", help="FE-AI project root containing .codebuddy/.cache/metrics")
    parser.add_argument("--feai-change", help="FE-AI change name used under .codebuddy/.cache/metrics")
    parser.add_argument("--usage-context", help="Path to usage-context.json")
    parser.add_argument("--project-root", help="Project root used to narrow project-scoped logs")
    parser.add_argument("--session-id", action="append", default=None, help="Only include this session id. Can be repeated or comma-separated")
    parser.add_argument("--from-time", help="Exact start time, ISO-8601 or Unix timestamp")
    parser.add_argument("--to-time", help="Exact end time, ISO-8601 or Unix timestamp")
    parser.add_argument("--format", choices=("local-usage-audit", "local-usage-diagnosis"), default="local-usage-audit")
    parser.add_argument("--output", help="Write output to a file")
    parser.add_argument("--fixture-root", help=argparse.SUPPRESS)
    return parser


def load_context(project_root: str | None, change_name: str | None, usage_context: str | None) -> dict:
    notes: list[str] = []
    project_path = Path(project_root).expanduser() if project_root else None
    context_path = (
        Path(usage_context).expanduser()
        if usage_context
        else (
            project_path / ".codebuddy" / ".cache" / "metrics" / change_name / "usage-context.json"
            if project_path is not None and change_name
            else None
        )
    )
    data = read_json_object(context_path, notes) if context_path is not None else {}
    resolved_project = str(project_path) if project_path is not None else string_or_none(data.get("projectRoot"))
    resolved_change = change_name or string_or_none(data.get("changeName"))

    window = data.get("window") if isinstance(data.get("window"), dict) else {}
    window_start = parse_datetime(window.get("start"))
    window_end = parse_datetime(window.get("end"))
    window_source = "usage-context" if window_start or window_end else None

    timeline_path = (
        Path(resolved_project) / ".codebuddy" / ".cache" / "metrics" / resolved_change / "timeline.log"
        if resolved_project and resolved_change
        else None
    )
    timeline_start, timeline_end = read_timeline_window(timeline_path, notes)
    if window_start is None and timeline_start is not None:
        window_start = timeline_start
        window_source = merge_window_source(window_source, "feai.timeline")
    if window_end is None and timeline_end is not None:
        window_end = timeline_end
        window_source = merge_window_source(window_source, "feai.timeline")

    return {
        "projectRoot": resolved_project,
        "changeName": resolved_change,
        "provider": string_or_none(data.get("provider")),
        "sessionIds": string_tuple(data.get("sessionIds") or data.get("session_ids")),
        "windowStart": window_start,
        "windowEnd": window_end,
        "windowSource": window_source,
        "notes": tuple(notes),
    }


def resolve_range(args, ctx: dict) -> tuple[datetime, datetime]:
    now = datetime.now().astimezone()
    if args.from_time or args.to_time:
        start = parse_datetime_arg(args.from_time, "--from-time") if args.from_time else ctx["windowStart"]
        if start is None:
            raise ValueError("--from-time is required when no FE-AI window start is available")
        end = parse_datetime_arg(args.to_time, "--to-time") if args.to_time else now
    elif ctx["windowStart"] is not None:
        start = ctx["windowStart"]
        end = ctx["windowEnd"] or now
    else:
        raise ValueError("FE-AI usage window is required via timeline.log, usage-context.window, or --from-time")
    if start > end:
        raise ValueError("usage window start must be earlier than or equal to end")
    return start, end


def resolve_roots(fixture_root: str | None, project_root: str | None, provider: str) -> tuple[Path, ...]:
    if provider == "codex":
        return (
            (Path(fixture_root) / "codex",)
            if fixture_root
            else (Path.home() / ".codex" / "sessions", Path.home() / ".codex" / "archived_sessions")
        )
    if provider == "codebuddy":
        return (
            (Path(fixture_root) / "codebuddy", Path(fixture_root) / "codebuddy_logs")
            if fixture_root
            else (
                Path.home() / "Library" / "Application Support" / "CodeBuddyExtension" / "Data",
                Path.home() / "Library" / "Application Support" / "CodeBuddyExtension" / "Logs" / "CodeBuddyIDE",
            )
        )
    if provider == "codebuddy-vscode":
        return (
            (Path(fixture_root) / "codebuddy_vscode",)
            if fixture_root
            else (Path.home() / "Library" / "Application Support" / "Code" / "User" / "workspaceStorage",)
        )
    if provider == "claudecode-internal":
        return (
            (Path(fixture_root) / "claudecode_internal",)
            if fixture_root
            else (Path.home() / ".claude-internal" / "projects",)
        )
    if provider == "gemini":
        return (
            (Path(fixture_root) / "gemini",)
            if fixture_root
            else (Path.home() / ".gemini" / "tmp",)
        )
    if provider == "opencode":
        return (
            (Path(fixture_root) / "opencode" / "opencode.db",)
            if fixture_root
            else (Path.home() / ".local" / "share" / "opencode" / "opencode.db",)
        )

    base = (Path(fixture_root) / "codebuddycode",) if fixture_root else (
        Path.home() / ".codebuddy" / "projects",
        Path.home() / ".codebuddy-code" / "projects",
    )
    if not project_root:
        return base
    project_path = Path(project_root).expanduser()
    absolute = str(project_path if project_path.is_absolute() else project_path.resolve())
    variants: list[str] = []
    for value in (absolute.lstrip("/").replace("/", "-"), absolute.replace("/", "-")):
        if value and value not in variants:
            variants.append(value)
    return tuple(root / variant for root in base for variant in variants)


def read_records(provider: str, roots: tuple[Path, ...]) -> list[dict]:
    if provider == "codex":
        return read_codex_records(roots)
    if provider == "codebuddy":
        return read_codebuddy_records(roots)
    if provider == "codebuddy-vscode":
        return read_codebuddy_vscode_records(roots)
    if provider == "claudecode-internal":
        return read_anthropic_roots(roots, provider)
    if provider == "gemini":
        return read_gemini_records(roots)
    if provider == "opencode":
        return read_opencode_records(roots)
    return read_codebuddycode_records(roots)


def read_codebuddycode_records(roots: tuple[Path, ...]) -> list[dict]:
    records: list[dict] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            records.extend(read_provider_data_jsonl(path, CODEBUDDYCODE_PROVIDER))
            records.extend(read_anthropic_jsonl(path, CODEBUDDYCODE_PROVIDER))
    return records


def read_codebuddy_records(roots: tuple[Path, ...]) -> list[dict]:
    history_records: list[dict] = []
    for root in roots:
        if root.exists():
            history_records.extend(read_codebuddy_ide_history(root))
    if history_records:
        return history_records

    log_records: list[dict] = []
    for root in roots:
        if root.exists():
            log_records.extend(read_codebuddy_ide_logs(root))
    if log_records:
        return log_records

    records: list[dict] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            records.extend(read_provider_data_jsonl(path, "codebuddy"))
    return records


def read_codex_records(roots: tuple[Path, ...]) -> list[dict]:
    records: list[dict] = []
    seen_request_ids: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            session_id = path.stem
            previous_total: dict[str, int] | None = None
            event_index = 0
            for obj in read_jsonl(path):
                event_type = obj.get("type")
                payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
                if event_type == "session_meta":
                    meta_id = payload.get("session_id") or payload.get("sessionId") or payload.get("id")
                    if isinstance(meta_id, str) and meta_id:
                        session_id = meta_id
                    continue

                if payload.get("type") != "token_count" and event_type != "token_count":
                    continue
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                usage = info.get("total_token_usage")
                cumulative = True
                if not isinstance(usage, dict):
                    usage = info.get("last_token_usage")
                    cumulative = False
                if not isinstance(usage, dict):
                    continue
                timestamp = parse_datetime(obj.get("timestamp") or payload.get("timestamp"))
                if timestamp is None:
                    continue
                current = codex_usage_values(usage)
                if cumulative:
                    values = delta_usage(previous_total, current)
                    previous_total = current
                else:
                    values = current
                values["cacheReadTokens"] = min(values["cacheReadTokens"], values["inputTokens"])
                if (
                    values["inputTokens"] == 0
                    and values["cacheReadTokens"] == 0
                    and values["outputTokens"] == 0
                    and values["reasoningOutputTokens"] == 0
                ):
                    continue

                event_index += 1
                request_id = f"{session_id}:{event_index}"
                if request_id in seen_request_ids:
                    continue
                seen_request_ids.add(request_id)
                records.append(
                    {
                        "provider": "codex",
                        "sessionId": session_id,
                        "timestamp": timestamp,
                        "calls": 1,
                        "inputTokens": values["inputTokens"],
                        "cacheReadTokens": values["cacheReadTokens"],
                        "cacheWriteTokens": 0,
                        "outputTokens": values["outputTokens"],
                        "reasoningOutputTokens": values["reasoningOutputTokens"],
                        "reasoningOutputAvailable": "reasoning_output_tokens" in usage,
                        "credit": None,
                        "notes": (),
                    }
                )
    return records


def read_codebuddy_vscode_records(roots: tuple[Path, ...]) -> list[dict]:
    records: list[dict] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.json")):
            if path.parent.name != "gongfeng-chat":
                continue
            try:
                obj = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(obj, dict):
                continue
            default_session_id = str(obj.get("id") or path.stem)
            messages = obj.get("messages") if isinstance(obj.get("messages"), list) else []
            for message in messages:
                if not isinstance(message, dict):
                    continue
                message_time = parse_datetime(message.get("createdAt"))
                parser = message.get("parser") if isinstance(message.get("parser"), dict) else {}
                events = parser.get("events") if isinstance(parser.get("events"), list) else []
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    raw_event = event.get("rawEvent") if isinstance(event.get("rawEvent"), dict) else {}
                    usage = raw_event.get("token_usage") if isinstance(raw_event.get("token_usage"), dict) else None
                    if usage is None:
                        continue
                    completion_details = (
                        usage.get("completion_tokens_details")
                        if isinstance(usage.get("completion_tokens_details"), dict)
                        else {}
                    )
                    prompt_details = (
                        usage.get("prompt_tokens_details")
                        if isinstance(usage.get("prompt_tokens_details"), dict)
                        else {}
                    )
                    records.append(
                        {
                            "provider": "codebuddy-vscode",
                            "sessionId": str(raw_event.get("conversation_id") or default_session_id),
                            "timestamp": parse_datetime(raw_event.get("createdAt")) or message_time,
                            "calls": 1,
                            "inputTokens": int_value(usage.get("prompt_tokens")),
                            "cacheReadTokens": int_value(prompt_details.get("cached_tokens")),
                            "cacheWriteTokens": 0,
                            "outputTokens": int_value(usage.get("completion_tokens")),
                            "reasoningOutputTokens": int_value(completion_details.get("reasoning_tokens")),
                            "reasoningOutputAvailable": bool(completion_details),
                            "credit": None,
                            "notes": (),
                        }
                    )
    return records


def read_anthropic_roots(roots: tuple[Path, ...], provider: str) -> list[dict]:
    records: list[dict] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.jsonl")):
            records.extend(read_anthropic_jsonl(path, provider))
    return records


def read_gemini_records(roots: tuple[Path, ...]) -> list[dict]:
    records: list[dict] = []
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.glob("*/chats/session-*.json")):
            try:
                obj = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(obj, dict):
                continue
            session_id = obj.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                session_id = path.stem
            messages = obj.get("messages")
            if not isinstance(messages, list):
                continue
            seen_message_ids: set[str] = set()
            for index, message in enumerate(messages):
                if not isinstance(message, dict) or message.get("type") != "gemini":
                    continue
                tokens = message.get("tokens")
                if not isinstance(tokens, dict):
                    continue
                raw_input_tokens = int_value(tokens.get("input"))
                output_tokens = int_value(tokens.get("output"))
                reasoning_tokens = int_value(tokens.get("thoughts"))
                cache_read = int_value(tokens.get("cached"))
                input_tokens = max(raw_input_tokens, cache_read)
                if input_tokens + output_tokens + reasoning_tokens + cache_read == 0:
                    continue
                message_id = message.get("id")
                if not isinstance(message_id, str) or not message_id:
                    message_id = str(index)
                request_id = f"{session_id}:{message_id}"
                if request_id in seen_message_ids:
                    continue
                seen_message_ids.add(request_id)
                records.append(
                    {
                        "provider": "gemini",
                        "sessionId": session_id,
                        "timestamp": parse_datetime(message.get("timestamp")),
                        "calls": 1,
                        "inputTokens": input_tokens,
                        "cacheReadTokens": cache_read,
                        "cacheWriteTokens": 0,
                        "outputTokens": output_tokens + reasoning_tokens,
                        "reasoningOutputTokens": reasoning_tokens,
                        "reasoningOutputAvailable": True,
                        "credit": None,
                        "notes": (),
                    }
                )
    return records


def read_opencode_records(roots: tuple[Path, ...]) -> list[dict]:
    records: list[dict] = []
    for db_path in roots:
        if not db_path.is_file():
            continue
        try:
            connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            rows = connection.execute(
                """
                SELECT id, session_id, time_created, data
                FROM message
                ORDER BY time_created
                """
            )
            for _message_id, session_id, time_created, data_json in rows:
                try:
                    message = json.loads(data_json)
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                time_data = message.get("time")
                if not isinstance(time_data, dict) or time_data.get("completed") is None:
                    continue
                tokens = message.get("tokens")
                if not isinstance(tokens, dict):
                    continue
                cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
                fresh_input = int_value(tokens.get("input"))
                cache_read = int_value(cache.get("read"))
                cache_write = int_value(cache.get("write"))
                output_tokens = int_value(tokens.get("output"))
                reasoning_tokens = int_value(tokens.get("reasoning"))
                if fresh_input + cache_read + cache_write + output_tokens + reasoning_tokens == 0:
                    continue
                normalized_input = fresh_input + cache_read + cache_write
                records.append(
                    {
                        "provider": "opencode",
                        "sessionId": str(session_id),
                        "timestamp": parse_datetime(time_data.get("created")) or parse_datetime(time_created),
                        "calls": 1,
                        "inputTokens": normalized_input,
                        "cacheReadTokens": cache_read,
                        "cacheWriteTokens": cache_write,
                        "outputTokens": output_tokens + reasoning_tokens,
                        "reasoningOutputTokens": reasoning_tokens,
                        "reasoningOutputAvailable": True,
                        "credit": None,
                        "notes": (
                            "opencode input normalized as fresh input + cache read + cache write",
                        ),
                    }
                )
        except sqlite3.Error:
            continue
        finally:
            connection.close()
    return records


def read_provider_data_jsonl(path: Path, provider: str) -> list[dict]:
    records: list[dict] = []
    for obj in read_jsonl(path):
        provider_data = obj.get("providerData") if isinstance(obj.get("providerData"), dict) else {}
        usage = provider_data.get("usage") if isinstance(provider_data.get("usage"), dict) else None
        if not usage:
            continue
        raw_usage = provider_data.get("rawUsage") if isinstance(provider_data.get("rawUsage"), dict) else {}
        cache_write = int_value(raw_usage.get("prompt_cache_write_tokens")) or int_value(raw_usage.get("cache_creation_input_tokens"))
        reasoning_output = sum_detail_tokens(usage.get("outputTokensDetails"), "reasoning_tokens")
        if reasoning_output == 0:
            completion_details = raw_usage.get("completion_tokens_details")
            if isinstance(completion_details, dict):
                reasoning_output = int_value(completion_details.get("reasoning_tokens"))
        if reasoning_output == 0:
            reasoning_output = int_value(raw_usage.get("completion_thinking_tokens"))
        records.append(
            {
                "provider": provider,
                "sessionId": str(obj.get("sessionId") or path.stem),
                "timestamp": parse_datetime(obj.get("timestamp")),
                "calls": int_value(usage.get("requests"), default=1),
                "inputTokens": int_value(usage.get("inputTokens")),
                "cacheReadTokens": sum_detail_tokens(usage.get("inputTokensDetails"), "cached_tokens"),
                "cacheWriteTokens": cache_write,
                "outputTokens": int_value(usage.get("outputTokens")),
                "reasoningOutputTokens": reasoning_output,
                "reasoningOutputAvailable": True,
                "credit": optional_float(raw_usage.get("credit")),
                "notes": (),
            }
        )
    return records


def read_anthropic_jsonl(path: Path, provider: str) -> list[dict]:
    messages: dict[str, dict] = {}
    for obj in read_jsonl(path):
        if obj.get("type") not in (None, "assistant"):
            continue
        message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
        message_id = message.get("id")
        usage = message.get("usage") if isinstance(message.get("usage"), dict) else None
        if not isinstance(message_id, str) or not message_id or not usage or message.get("stop_reason") is None:
            continue
        output_tokens = int_value(usage.get("output_tokens"))
        if output_tokens == 0:
            continue
        cache_write = int_value(usage.get("cache_creation_input_tokens"))
        cache_read = int_value(usage.get("cache_read_input_tokens"))
        record = {
            "provider": provider,
            "sessionId": path.stem,
            "timestamp": parse_datetime(obj.get("timestamp")),
            "calls": 1,
            "inputTokens": int_value(usage.get("input_tokens")) + cache_write + cache_read,
            "cacheReadTokens": cache_read,
            "cacheWriteTokens": cache_write,
            "outputTokens": output_tokens,
            "reasoningOutputTokens": None,
            "reasoningOutputAvailable": False,
            "credit": None,
            "notes": (f"reasoning output unavailable in {provider} logs",),
        }
        previous = messages.get(message_id)
        if previous is None or record["outputTokens"] > previous["outputTokens"]:
            messages[message_id] = record
    return list(messages.values())


def read_codebuddy_ide_history(root: Path) -> list[dict]:
    records: list[dict] = []
    for path in sorted(root.rglob("*.json")):
        if path.parent.name != "messages":
            continue
        try:
            obj = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        message = json_dict(obj.get("message"))
        role = obj.get("role") or message.get("role")
        if role != "assistant":
            continue
        extra = json_dict(obj.get("extra"))
        stats = extra.get("statsSnapshot") if isinstance(extra.get("statsSnapshot"), dict) else {}
        input_tokens = int_value(extra.get("lastStepInputTokens")) or int_value(stats.get("inputTokens"))
        output_tokens = int_value(extra.get("lastStepOutputTokens")) or int_value(stats.get("lastOutputTokens"))
        cache_read = int_value(extra.get("lastStepCachedInputTokens")) or int_value(stats.get("cachedInputTokens"))
        cache_write = int_value(stats.get("cacheWriteTokens"))
        reasoning_output = int_value(stats.get("thinkingTokens"))
        credit = optional_float(stats.get("credit"))
        if input_tokens + output_tokens + cache_read + cache_write + reasoning_output == 0 and credit is None:
            continue
        records.append(
            {
                "provider": "codebuddy",
                "sessionId": codebuddy_ide_session_id(path),
                "timestamp": parse_datetime(obj.get("createdAt")),
                "calls": 1,
                "inputTokens": input_tokens,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "outputTokens": output_tokens,
                "reasoningOutputTokens": reasoning_output,
                "reasoningOutputAvailable": "thinkingTokens" in stats,
                "credit": credit,
                "notes": (),
            }
        )
    return records


def read_codebuddy_ide_logs(root: Path) -> list[dict]:
    records: list[dict] = []
    for path in sorted(root.rglob("*.log")):
        try:
            lines = path.read_text(errors="ignore").splitlines()
        except OSError:
            continue
        for line in lines:
            match = CODEBUDDY_IDE_LOG_USAGE_RE.search(line)
            if not match:
                continue
            try:
                usage = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            input_tokens = int_value(usage.get("inputTokens"))
            output_tokens = int_value(usage.get("outputTokens"))
            cache_read = int_value(usage.get("cacheTokens"))
            cache_write = int_value(usage.get("cachedWriteTokens"))
            records.append(
                {
                    "provider": "codebuddy",
                    "sessionId": codebuddy_log_session_id(line, path),
                    "timestamp": parse_codebuddy_log_datetime(line),
                    "calls": 1,
                    "inputTokens": input_tokens,
                    "cacheReadTokens": cache_read,
                    "cacheWriteTokens": cache_write,
                    "outputTokens": output_tokens,
                    "reasoningOutputTokens": None,
                    "reasoningOutputAvailable": False,
                    "credit": optional_float(usage.get("credit")),
                    "notes": ("reasoning output unavailable in CodeBuddy IDE logs",),
                }
            )
    return records


def codex_usage_values(usage: dict) -> dict[str, int]:
    return {
        "inputTokens": int_value(usage.get("input_tokens")),
        "cacheReadTokens": int_value(
            usage.get("cached_input_tokens", usage.get("cache_read_input_tokens"))
        ),
        "outputTokens": int_value(usage.get("output_tokens")),
        "reasoningOutputTokens": int_value(usage.get("reasoning_output_tokens")),
    }


def delta_usage(previous: dict[str, int] | None, current: dict[str, int]) -> dict[str, int]:
    if previous is None:
        return dict(current)
    return {key: max(0, current.get(key, 0) - previous.get(key, 0)) for key in current}


def aggregate(records: list[dict], start: datetime, end: datetime, provider: str) -> tuple[dict, set[str]]:
    totals = {
        "sessions": set(),
        "calls": 0,
        "inputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "outputTokens": 0,
        "reasoningOutputTokens": 0,
        "reasoningOutputAvailable": False,
        "totalTokens": 0,
        "credit": 0.0,
        "creditAvailable": False,
    }
    notes: set[str] = set()
    for record in records:
        timestamp = record["timestamp"]
        if timestamp is None:
            notes.add(f"{record['provider']}: skipped record without timestamp")
            continue
        if timestamp < start or timestamp > end:
            continue
        totals["sessions"].add(record["sessionId"])
        totals["calls"] += max(1, record["calls"])
        for key in ("inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"):
            totals[key] += record[key]
        totals["totalTokens"] += record["inputTokens"] + record["outputTokens"]
        if record["reasoningOutputAvailable"]:
            totals["reasoningOutputAvailable"] = True
            totals["reasoningOutputTokens"] += record["reasoningOutputTokens"] or 0
        if record["credit"] is not None:
            totals["creditAvailable"] = True
            totals["credit"] += record["credit"]
        notes.update(record["notes"])
    if not totals["sessions"]:
        notes.add(f"{provider}: no records in range")
    return totals, notes


def build_missing_window_diagnosis(ctx: dict, session_ids: tuple[str, ...], provider: str, error: str) -> dict:
    return {
        "schemaVersion": 1,
        "source": "token-usage-auditor",
        "scope": "feai-local-usage-diagnosis",
        "provider": provider,
        "projectScoped": bool(ctx["projectRoot"]),
        "changeName": ctx["changeName"],
        "sessionIds": bounded_strings(
            session_ids,
            max_items=LOCAL_USAGE_AUDIT_MAX_ITEMS,
            max_length=LOCAL_USAGE_AUDIT_MAX_SESSION_TEXT,
        ),
        "window": {
            "start": ctx["windowStart"].isoformat() if ctx["windowStart"] else None,
            "end": ctx["windowEnd"].isoformat() if ctx["windowEnd"] else None,
            "source": ctx["windowSource"],
        },
        "diagnosis": "missing_usage_window",
        "confidence": "low",
        "evidence": {
            "recordsTotal": 0,
            "recordsWithTimestamp": 0,
            "recordsInWindowAnySession": 0,
            "recordsMatchingSessionAnyTime": 0,
            "recordsMatchingSessionInWindow": 0,
            "sessionsSeenInWindow": [],
            "totalTokensInWindowAnySession": 0,
            "totalTokensMatchingSessionInWindow": 0,
        },
        "suggestions": [
            "Run feai workflow usage-context write during /feai-start, or provide a timeline.log / usage-context.window.start.",
        ],
        "notes": bounded_strings((*ctx["notes"], error)),
        "generatedAt": datetime.now().astimezone().isoformat(),
    }


def build_diagnosis(
    ctx: dict,
    session_ids: tuple[str, ...],
    records: list[dict],
    start: datetime,
    end: datetime,
    provider: str,
) -> dict:
    evidence = diagnosis_evidence(records, start, end, session_ids)
    diagnosis = classify_diagnosis(provider, ctx["projectRoot"], session_ids, evidence)
    return {
        "schemaVersion": 1,
        "source": "token-usage-auditor",
        "scope": "feai-local-usage-diagnosis",
        "provider": provider,
        "projectScoped": bool(ctx["projectRoot"] and provider == CODEBUDDYCODE_PROVIDER),
        "changeName": ctx["changeName"],
        "sessionIds": bounded_strings(
            session_ids,
            max_items=LOCAL_USAGE_AUDIT_MAX_ITEMS,
            max_length=LOCAL_USAGE_AUDIT_MAX_SESSION_TEXT,
        ),
        "window": {"start": start.isoformat(), "end": end.isoformat(), "source": ctx["windowSource"] or "cli-range"},
        "diagnosis": diagnosis,
        "confidence": diagnosis_confidence(provider, ctx["projectRoot"], ctx["windowSource"]),
        "evidence": evidence,
        "suggestions": diagnosis_suggestions(diagnosis, provider),
        "notes": bounded_strings(ctx["notes"]),
        "generatedAt": datetime.now().astimezone().isoformat(),
    }


def diagnosis_evidence(records: list[dict], start: datetime, end: datetime, session_ids: tuple[str, ...]) -> dict:
    wanted_sessions = set(session_ids)
    sessions_seen_in_window: list[str] = []
    records_total = 0
    records_with_timestamp = 0
    records_in_window = 0
    records_matching_session_any_time = 0
    records_matching_session_in_window = 0
    total_tokens_in_window = 0
    total_tokens_matching_session_in_window = 0

    for record in records:
        records_total += 1
        timestamp = record["timestamp"]
        session_match = not wanted_sessions or record["sessionId"] in wanted_sessions
        if session_match:
            records_matching_session_any_time += 1
        if timestamp is None:
            continue
        records_with_timestamp += 1
        in_window = start <= timestamp <= end
        if not in_window:
            continue
        records_in_window += 1
        total_tokens = record["inputTokens"] + record["outputTokens"]
        total_tokens_in_window += total_tokens
        if record["sessionId"] not in sessions_seen_in_window:
            sessions_seen_in_window.append(record["sessionId"])
        if session_match:
            records_matching_session_in_window += 1
            total_tokens_matching_session_in_window += total_tokens

    return {
        "recordsTotal": records_total,
        "recordsWithTimestamp": records_with_timestamp,
        "recordsInWindowAnySession": records_in_window,
        "recordsMatchingSessionAnyTime": records_matching_session_any_time,
        "recordsMatchingSessionInWindow": records_matching_session_in_window,
        "sessionsSeenInWindow": bounded_strings(
            sessions_seen_in_window,
            max_items=LOCAL_USAGE_AUDIT_MAX_ITEMS,
            max_length=LOCAL_USAGE_AUDIT_MAX_SESSION_TEXT,
        ),
        "totalTokensInWindowAnySession": total_tokens_in_window,
        "totalTokensMatchingSessionInWindow": total_tokens_matching_session_in_window,
    }


def classify_diagnosis(provider: str, project_root: str | None, session_ids: tuple[str, ...], evidence: dict) -> str:
    if evidence["recordsTotal"] == 0:
        return "no_provider_logs"
    if evidence["recordsWithTimestamp"] == 0:
        return "no_timestamped_records"
    if evidence["recordsInWindowAnySession"] == 0:
        return "no_records_in_window"
    if session_ids and evidence["recordsMatchingSessionInWindow"] == 0:
        return "session_mismatch" if provider == CODEBUDDYCODE_PROVIDER and project_root else "session_window_mismatch_suspected"
    return "ok"


def diagnosis_confidence(provider: str, project_root: str | None, window_source: str | None) -> str:
    if not has_feai_window(window_source):
        return "low"
    if provider == CODEBUDDYCODE_PROVIDER and project_root:
        return "high"
    return "low"


def diagnosis_suggestions(diagnosis: str, provider: str) -> list[str]:
    if diagnosis == "missing_usage_window":
        return ["Write usage-context.window.start or restore timeline.log before archive."]
    if diagnosis == "no_provider_logs":
        return ["Confirm usage-context.provider and verify the local tool has usage logs on this machine."]
    if diagnosis == "no_timestamped_records":
        return ["The provider logs were found, but no parseable timestamps were available."]
    if diagnosis == "no_records_in_window":
        return ["Check whether usage-context.window or timeline.log points at the actual work period."]
    if diagnosis == "session_mismatch":
        return ["The recorded sessionIds do not match records in this window; codebuddycode audit can fall back to projectRoot + window."]
    if diagnosis == "session_window_mismatch_suspected":
        return [f"The recorded sessionIds do not match records in this window; {provider} cannot be project-scoped reliably, so inspect provider/session manually."]
    return []


def aggregate_with_session_fallback(
    records: list[dict],
    start: datetime,
    end: datetime,
    provider: str,
    project_root: str | None,
    session_ids: tuple[str, ...],
    allow_session_fallback: bool,
) -> tuple[dict, set[str], tuple[str, ...]]:
    if not session_ids:
        totals, notes = aggregate(records, start, end, provider)
        return totals, notes, session_ids

    session_records = [record for record in records if record["sessionId"] in session_ids]
    session_totals, session_notes = aggregate(session_records, start, end, provider)
    if session_totals["sessions"] or not allow_session_fallback or provider != CODEBUDDYCODE_PROVIDER or not project_root:
        return session_totals, session_notes, session_ids

    project_totals, project_notes = aggregate(records, start, end, provider)
    if not project_totals["sessions"]:
        return session_totals, session_notes, session_ids

    project_notes.add("sessionIds did not match records in window; fell back to codebuddycode project window")
    return project_totals, project_notes, ()


def build_audit(ctx: dict, session_ids: tuple[str, ...], start: datetime, end: datetime, totals: dict, notes: set[str], provider: str) -> dict:
    input_tokens = totals["inputTokens"]
    cache_hit_rate = totals["cacheReadTokens"] / input_tokens if input_tokens > 0 else None
    credit = totals["credit"] if totals["creditAvailable"] else None
    return {
        "schemaVersion": 1,
        "source": "token-usage-auditor",
        "scope": "feai-requirement",
        "confidence": local_confidence(ctx["projectRoot"], session_ids, ctx["windowSource"], provider),
        "provider": provider,
        "projectScoped": bool(ctx["projectRoot"]),
        "changeName": ctx["changeName"],
        "sessionIds": bounded_strings(
            session_ids,
            max_items=LOCAL_USAGE_AUDIT_MAX_ITEMS,
            max_length=LOCAL_USAGE_AUDIT_MAX_SESSION_TEXT,
        ),
        "window": {"start": start.isoformat(), "end": end.isoformat(), "source": ctx["windowSource"] or "cli-range"},
        "totals": {
            "sessions": len(totals["sessions"]),
            "calls": totals["calls"],
            "inputTokens": input_tokens,
            "cacheReadTokens": totals["cacheReadTokens"],
            "cacheWriteTokens": totals["cacheWriteTokens"],
            "outputTokens": totals["outputTokens"],
            "reasoningOutputTokens": totals["reasoningOutputTokens"] if totals["reasoningOutputAvailable"] else None,
            "totalTokens": totals["totalTokens"],
            "cacheHitRate": cache_hit_rate,
            "cacheHitRatePercent": round(cache_hit_rate * 100, 2) if cache_hit_rate is not None else None,
            "credit": credit,
            "cnyCost": cny_cost(credit),
            "costRecognized": credit is not None,
        },
        "generatedAt": datetime.now().astimezone().isoformat(),
        "notes": bounded_strings(safe_note(note) for note in sorted(set(ctx["notes"]) | notes)),
    }


def local_confidence(project_root: str | None, session_ids: tuple[str, ...], window_source: str | None, provider: str) -> str:
    if not has_feai_window(window_source):
        return "low"
    if project_root and session_ids:
        return "high"
    if project_root and provider == CODEBUDDYCODE_PROVIDER:
        return "medium"
    return "low"


def has_feai_window(window_source: str | None) -> bool:
    if not window_source:
        return False
    return bool(set(window_source.split("+")) & {"feai.timeline", "usage-context", "cli-time"})


def read_timeline_window(path: Path | None, notes: list[str]) -> tuple[datetime | None, datetime | None]:
    if path is None or not path.exists():
        return None, None
    timestamps: list[datetime] = []
    try:
        for obj in read_jsonl(path):
            timestamp = parse_datetime(obj.get("ts") or obj.get("timestamp"))
            if timestamp is not None:
                timestamps.append(timestamp)
    except OSError:
        notes.append("failed to read feai timeline")
    if not timestamps:
        notes.append("feai timeline exists but has no parseable timestamps")
        return None, None
    return min(timestamps), max(timestamps)


def read_json_object(path: Path, notes: list[str]) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except OSError:
        notes.append("failed to read usage context")
        return {}
    except json.JSONDecodeError:
        notes.append("failed to parse usage context")
        return {}
    if not isinstance(data, dict):
        notes.append("usage context is not a JSON object")
        return {}
    return data


def read_jsonl(path: Path):
    try:
        with path.open() as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(value, dict):
                    yield value
    except OSError:
        return


def parse_datetime_arg(value: str, flag: str) -> datetime:
    parsed = parse_datetime(coerce_timestamp(value))
    if parsed is None:
        raise ValueError(f"Invalid datetime for {flag}: {value}")
    return parsed


def parse_datetime(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).astimezone()
        except (OSError, OverflowError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        return parsed.replace(tzinfo=timezone.utc).astimezone() if parsed.tzinfo is None else parsed.astimezone()
    return None


def coerce_timestamp(value: str):
    text = value.strip()
    if text.isdigit():
        return int(text)
    try:
        return float(text)
    except ValueError:
        return value


def resolve_session_ids(cli_values: tuple[str, ...], context_values: tuple[str, ...]) -> tuple[str, ...]:
    result: list[str] = []
    for raw in tuple(cli_values) or context_values:
        for item in raw.split(","):
            item = item.strip()
            if item and item not in result:
                result.append(item)
    return tuple(result)


def range_source(args, ctx: dict) -> str:
    if args.from_time:
        return "cli-time"
    if args.to_time and ctx["windowSource"]:
        return f"{ctx['windowSource']}+cli-time"
    if args.to_time:
        return "cli-time"
    return ctx["windowSource"] or "cli-range"


def merge_window_source(current: str | None, added: str) -> str:
    if not current:
        return added
    parts = current.split("+")
    if added not in parts:
        parts.append(added)
    return "+".join(parts)


def cny_cost(credit: float | None) -> float | None:
    if credit is None:
        return None
    return float((Decimal(str(credit)) * CNY_PER_CREDIT).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def string_or_none(value) -> str | None:
    return value if isinstance(value, str) and value else None


def string_tuple(value) -> tuple[str, ...]:
    if isinstance(value, str):
        values = [part.strip() for part in value.split(",")]
    elif isinstance(value, list):
        values = [str(part).strip() for part in value if isinstance(part, (str, int))]
    else:
        values = []
    return tuple(part for part in values if part)


def bounded_strings(
    values,
    max_items: int = LOCAL_USAGE_AUDIT_MAX_ITEMS,
    max_length: int = LOCAL_USAGE_AUDIT_MAX_TEXT,
) -> list[str]:
    result: list[str] = []
    for value in values:
        text = str(value)
        if len(text) > max_length:
            text = text[:max_length] + "..."
        result.append(text)
        if len(result) >= max_items:
            break
    return result


def safe_note(value) -> str:
    return ABSOLUTE_PATH_RE.sub("<local-path>", str(value))


def json_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def codebuddy_ide_session_id(path: Path) -> str:
    parts = path.parts
    if "history" in parts:
        index = parts.index("history")
        if len(parts) > index + 2:
            return parts[index + 2]
    if len(parts) >= 3:
        return path.parent.parent.name
    return path.stem


def codebuddy_log_session_id(line: str, path: Path) -> str:
    match = re.search(r"\[AgentReporter\]\s+\[([^\]]+)\]", line)
    if match:
        return match.group(1)
    return path.stem


def parse_codebuddy_log_datetime(line: str) -> datetime | None:
    match = CODEBUDDY_IDE_LOG_TIME_RE.match(line)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(item) for item in match.groups())
    return datetime(year, month, day, hour, minute, second).astimezone()


def int_value(value, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text and (text.isdigit() or (text[0] == "-" and text[1:].isdigit())):
            return int(text)
    return default


def optional_float(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip()) if value.strip() else None
        except ValueError:
            return None
    return None


def sum_detail_tokens(details, key: str) -> int:
    if not isinstance(details, list):
        return 0
    return sum(int_value(item.get(key)) for item in details if isinstance(item, dict))


if __name__ == "__main__":
    raise SystemExit(main())
