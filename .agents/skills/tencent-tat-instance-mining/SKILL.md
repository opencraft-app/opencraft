---
name: tencent-tat-instance-mining
description: Mine structured data from Tencent Cloud CVM user instances through TAT/自动化助手. Use when asked to batch collect, audit, summarize, enrich account tables, or export data from many user-owned Hermes/Agent instances, including token usage, session summaries, channel/model/title analysis, Hermes send channel configuration, or other read-only instance-side commands with filters such as region, instance name prefix, creation time, explicit instance IDs, actual CVM ids, and 50/100-instance batching.
---

# Tencent TAT Instance Mining

Use this skill to run compact, read-only collection commands on Tencent Cloud CVM instances through TAT 自动化助手, then parse and analyze the outputs locally.

## Safety Rules

- Never hardcode AK/SK in scripts, skill files, logs, or reports.
- Read credentials only from environment variables:
  - `TENCENTCLOUD_SECRET_ID`
  - `TENCENTCLOUD_SECRET_KEY`
  - `TENCENTCLOUD_TOKEN` optional
- If credentials are missing, ask the user to provide them for the current shell/session.
- Use `Username=agentuser` and `WorkingDirectory=/home/agentuser` unless the user explicitly gives a different execution user.
- Prefer compact stdout and local aggregation. Do not use COS, write remote files, or delete remote files unless the user explicitly approves.
- Treat empty output, missing `agentuser`, missing TAT Agent, `START_FAILED`, `DELIVER_FAILED`, and parse failures as terminal records to skip/report, not as reasons to repeatedly rerun the same instance.
- Batch at 50 instances by default for broad runs. Tencent TAT supports up to 100 per call, but 50 is safer for polling and output triage.

## Standard Workflow

1. Confirm scope:
   - Region, usually `ap-shanghai`.
   - Selector: `--name-prefix`, `--created-after`, explicit `--instance-id`, or `--instance-file`.
   - Batch size, usually `--batch-size 50`.
2. Run a one-instance test first when the command or parser is new.
3. Run batches once. Do not blindly rerun failed or empty instances.
4. Preserve generated raw task metadata, parsed CSV/JSON, skipped records, and summary stats.
5. For spreadsheets, build from generated CSV/JSON locally without rerunning TAT.

For Tencent API details and known TAT failure modes, read `references/tat-api-notes.md` only when patching scripts or investigating API/TAT errors.

## Case 1: Token Usage

Use `scripts/hermes_insights_tat.py` to collect `hermes insights --days N` with compact `Period + Overview` output.

Single-instance test:

```bash
python3 scripts/hermes_insights_tat.py \
  --instance-id ins-xxxx \
  --region ap-shanghai \
  --days 30 \
  --out-dir hermes_insights_results/test_ins_xxxx
```

Filtered batch run:

```bash
python3 scripts/hermes_insights_tat.py \
  --all-running \
  --region ap-shanghai \
  --name-prefix 'pool-pool-' \
  --created-after '' \
  --batch-size 50 \
  --days 30 \
  --out-dir hermes_insights_results/<run-name>
```

Generated files:

- `metrics.json`: summary plus per-instance metrics.
- `metrics.csv`: per-instance parsed metrics.
- `raw_tasks.json`: raw TAT task metadata and base64 outputs.

Accounting guidance:

- `total_tokens = 0`: valid zero usage.
- `total_tokens = null`: skipped/failed/unparsed.
- If `Period` is shorter than the configured days, compute realistic monthly projection from `period_daily = total_tokens / period_days`; do not rely only on `total_tokens / 30`.

## Case 2: Session Summaries

Use `scripts/hermes_sessions_tat.py` to collect compact session rows from:

```bash
hermes sessions export -
```

The remote parser prints one TSV line per session:

```text
started_at    source    model    message_count    title
```

Single-instance test:

```bash
python3 scripts/hermes_sessions_tat.py \
  --instance-id ins-xxxx \
  --region ap-shanghai \
  --batch-size 1 \
  --out-dir hermes_session_results/test_ins_xxxx
```

Filtered batch run:

```bash
python3 scripts/hermes_sessions_tat.py \
  --all-running \
  --region ap-shanghai \
  --name-prefix 'pool-pool-' \
  --created-after '' \
  --batch-size 50 \
  --timeout 300 \
  --out-dir hermes_session_results/<run-name>
```

Generated files:

- `sessions.csv`: per-session rows with instance id/name, started time, source, model, message count, and title.
- `instances.csv`: per-instance execution status, session count, output bytes, dropped bytes, error, invocation id, and batch index.
- `skipped.csv`: failed/skipped/partial-output instances.
- `stats_sources.csv`, `stats_models.csv`, `stats_source_models.csv`, `stats_instances.csv`, `stats_titles.csv`: local aggregate views.
- `summary.json`: machine-readable summary.
- `raw_tasks.json`: raw TAT task metadata.

Interpretation guidance:

- Empty output from a successful task means zero exported sessions for that instance.
- `dropped > 0` means TAT stdout was truncated; keep captured rows but mark the instance as partial output. Without COS or another approved transfer path, the per-session table is a lower bound for those instances.
- For scenario mining, report the untitled ratio first. Do not force `(无标题)` sessions into inferred user scenarios.

## Case 3: Channel Configuration Mining

Use `scripts/hermes_channels_tat.py` to collect compact, redacted channel configuration summaries from:

```bash
hermes send --list --json
```

The remote parser removes empty platform lists and redacts sensitive-looking keys such as tokens, secrets, passwords, webhooks, URLs, and credentials before sending stdout back through TAT.

Single-instance test:

```bash
python3 scripts/hermes_channels_tat.py \
  --instance-id ins-xxxx \
  --region ap-shanghai \
  --batch-size 1 \
  --out-dir hermes_channel_results/test_ins_xxxx
```

Explicit CVM list batch run:

```bash
python3 scripts/hermes_channels_tat.py \
  --instance-file cvm_ids.txt \
  --region ap-shanghai \
  --batch-size 50 \
  --timeout 300 \
  --out-dir hermes_channel_results/<run-name>
```

Generated files:

- `cvm_channel_summary.csv`: per-CVM execution status, channel counts, channel types, redacted compact JSON, errors, invocation id, and batch index.
- `channel_detail.csv`: one row per channel with CVM id, type, name/id, status, and redacted raw channel JSON.
- `channels_by_cvm_redacted.json`: CVM-keyed redacted summary.
- `skipped_channels.csv`: failed, skipped, or partial-output CVM rows.
- `stats_channel_types.csv`: channel-type distribution.
- `summary.json`: machine-readable summary.

Interpretation guidance:

- Successful output with `channel_count = 0` means the instance has no configured send channel.
- `dropped > 0` or `output_dropped` means TAT stdout was truncated; keep the row but mark it partial.
- When enriching an account table, join through actual CVM ids, not business instance ids, and keep a separate one-row-per-channel detail table for multi-channel accounts.

Account TSV enrichment:

Use `scripts/merge_account_channels.py` after channel collection when the user provides an account table with columns such as `account_id`, `instance_ids`, `actual_cvm_ids`, and `bound_email`.

```bash
python3 scripts/merge_account_channels.py \
  --account-tsv lightvela_account_instance_cvm_email.tsv \
  --channel-dir hermes_channel_results/<run-name> \
  --out-dir outputs/<merge-run-name>
```

Generated local files:

- `<prefix>_channels.tsv`: original account rows plus `channel_fetch_status`, channel counts, channel types, redacted channel JSON, and `has_<channel_type>` flags.
- `<prefix>_channel_detail.csv`: one row per account/CVM/channel.
- `<prefix>_summary.json` and `<prefix>_summary.csv`: account-level counts and deduped user metrics.

Deduped user-count guidance:

- Deduplicate by `account_id` after merging all rows.
- For "valid reachable users" style counts, use `deduped_user_rule_email_or_non_lightclawbot.qualified_user_ids`, which counts users with at least one non-empty `bound_email` or at least one channel type other than `lightclawbot`.
- Report the overlap breakdown too: email users, non-`lightclawbot` channel users, both, email-only, channel-only, and not-qualified. This prevents double-counting users who satisfy both sides of the rule.

## Extending to New Instance Mining Tasks

When adding another data-mining case:

1. Keep the remote command read-only.
2. Make remote stdout compact and structured, preferably one TSV/JSON line per record or one sentinel JSON blob.
3. Avoid remote temp files. If a temp file is unavoidable, ask first and document cleanup.
4. Decode and aggregate locally.
5. Preserve per-instance status and errors.
6. Add a dedicated script under `scripts/` when the parser or summarizer would otherwise be rewritten repeatedly.

Prefer the existing scripts as patterns for Tencent API signing, instance selection, batching, TAT polling, stdout decoding, and terminal failure handling.
