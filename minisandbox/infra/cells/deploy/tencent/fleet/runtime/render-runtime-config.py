#!/usr/bin/env python3
"""Render the Engine config embedded in runtime.yaml without a YAML dependency."""

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def extract_config(document: str) -> str:
    marker = "  config.jsonc: |\n"
    if document.count(marker) != 1:
        raise SystemExit("runtime manifest must contain exactly one config.jsonc block")
    block = document.split(marker, 1)[1].split("\n---\n", 1)[0]
    lines = block.splitlines()
    if not lines or any(line and not line.startswith("    ") for line in lines):
        raise SystemExit("config.jsonc block has unexpected indentation")
    return "\n".join(line[4:] if line else "" for line in lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--cell-name", required=True)
    parser.add_argument("--cold-bucket", required=True)
    parser.add_argument("--cold-endpoint", required=True)
    parser.add_argument("--cold-region", required=True)
    parser.add_argument("--write-debt-target", required=True, type=int)
    parser.add_argument("--write-debt-limit", required=True, type=int)
    parser.add_argument("--cold-max-concurrent-requests", required=True, type=int)
    parser.add_argument("--gasoline-worker-poll-interval-ms", required=True, type=int)
    parser.add_argument("--gasoline-worker-pull-batch-size", required=True, type=int)
    parser.add_argument("--gasoline-worker-max-active-workflows", required=True, type=int)
    parser.add_argument("--depot-manager-refresh-max-concurrency", required=True, type=int)
    parser.add_argument("--depot-compaction-max-concurrency", required=True, type=int)
    parser.add_argument("--gasoline-worker-secondary-grace-ms", required=True, type=int)
    parser.add_argument(
        "--gasoline-history-prune-eligibility-seconds", required=True, type=int
    )
    parser.add_argument(
        "--gasoline-terminal-prune-eligibility-seconds", required=True, type=int
    )
    parser.add_argument("--gasoline-prune-interval-seconds", required=True, type=int)
    parser.add_argument("--envoy-slot-jitter", required=True, type=int)
    parser.add_argument(
        "--envoy-allocation-max-in-flight-per-pool", required=True, type=int
    )
    args = parser.parse_args()
    if not 0 <= args.envoy_slot_jitter <= 64:
        parser.error("envoy-slot-jitter must be between 0 and 64")
    if not 1 <= args.envoy_allocation_max_in_flight_per_pool <= 256:
        parser.error("envoy-allocation-max-in-flight-per-pool must be between 1 and 256")
    if not 1 <= args.gasoline_worker_pull_batch_size <= 1000:
        parser.error("gasoline-worker-pull-batch-size must be between 1 and 1000")
    if not 1 <= args.gasoline_worker_max_active_workflows <= 10000:
        parser.error("gasoline-worker-max-active-workflows must be between 1 and 10000")
    if not 1 <= args.depot_manager_refresh_max_concurrency <= 4096:
        parser.error("depot-manager-refresh-max-concurrency must be between 1 and 4096")
    if not 1 <= args.depot_compaction_max_concurrency <= 4096:
        parser.error("depot-compaction-max-concurrency must be between 1 and 4096")
    if args.gasoline_prune_interval_seconds < 1:
        parser.error("gasoline-prune-interval-seconds must be positive")
    if (
        args.gasoline_history_prune_eligibility_seconds
        and args.gasoline_terminal_prune_eligibility_seconds
        and args.gasoline_history_prune_eligibility_seconds
        > args.gasoline_terminal_prune_eligibility_seconds
    ):
        parser.error(
            "gasoline-history-prune-eligibility-seconds must not exceed terminal retention"
        )
    if not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", args.cell_name):
        parser.error("cell-name must be a DNS label")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", args.cold_bucket):
        parser.error("cold-bucket must be an exact COS bucket name")
    endpoint = urlsplit(args.cold_endpoint)
    if (
        endpoint.scheme != "https"
        or not endpoint.hostname
        or endpoint.username
        or endpoint.password
        or endpoint.path not in ("", "/")
        or endpoint.query
        or endpoint.fragment
    ):
        parser.error("cold-endpoint must be an HTTPS origin without credentials, path, query, or fragment")
    if not re.fullmatch(r"ap-[a-z]+(?:-[a-z]+)*", args.cold_region):
        parser.error("cold-region must be a Tencent Cloud region")

    rendered = extract_config(args.manifest.read_text()).replace(
        "__RIVET_COLD_BUCKET__", args.cold_bucket
    ).replace(
        "__RIVET_COLD_ENDPOINT__", args.cold_endpoint.rstrip("/")
    ).replace(
        "__RIVET_COLD_REGION__", args.cold_region
    ).replace(
        "__RIVET_FDB_WRITE_DEBT_TARGET_BYTES__", str(args.write_debt_target)
    ).replace("__RIVET_FDB_WRITE_DEBT_LIMIT_BYTES__", str(args.write_debt_limit)).replace(
        "__RIVET_COLD_MAX_CONCURRENT_REQUESTS__", str(args.cold_max_concurrent_requests)
    ).replace(
        "__RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS__",
        str(args.gasoline_worker_poll_interval_ms),
    ).replace(
        "__RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE__",
        str(args.gasoline_worker_pull_batch_size),
    ).replace(
        "__RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS__",
        str(args.gasoline_worker_max_active_workflows),
    ).replace(
        "__RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY__",
        str(args.depot_manager_refresh_max_concurrency),
    ).replace(
        "__RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY__",
        str(args.depot_compaction_max_concurrency),
    ).replace(
        "__RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS__",
        str(args.gasoline_worker_secondary_grace_ms),
    ).replace(
        "__RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS__",
        str(args.gasoline_history_prune_eligibility_seconds),
    ).replace(
        "__RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS__",
        str(args.gasoline_terminal_prune_eligibility_seconds),
    ).replace(
        "__RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS__",
        str(args.gasoline_prune_interval_seconds),
    ).replace(
        "__RIVET_ENVOY_SLOT_JITTER__",
        str(args.envoy_slot_jitter),
    ).replace(
        "__RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL__",
        str(args.envoy_allocation_max_in_flight_per_pool),
    )
    rendered = rendered.replace("actor-bj-k01", args.cell_name)
    if "__RIVET_" in rendered:
        raise SystemExit("unrendered runtime token remains in config")
    json.loads(rendered)
    args.output.write_text(rendered)


if __name__ == "__main__":
    main()
