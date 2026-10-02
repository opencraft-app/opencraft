#!/usr/bin/env python3
"""Prove FDB range splitting and storage-server load distribution on a real Cell.

Run this on the Beijing load driver while the cardinality/churn workload is
active. The script uses only read-only fdbcli commands: repeated `status json`
samples and hidden diagnostic `getlocation` over the application keyspace.
It fails closed when no measurable load is present; an idle cluster cannot be
used as hotspot evidence.
"""

import argparse
import collections
import hashlib
import json
import math
import os
import pathlib
import re
import statistics
import subprocess
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple


ADDRESS_PATTERN = re.compile(r"^\s+([^\s]+:\d+)(?::tls)?\s*$")


def run_fdbcli(fdbcli: str, cluster_file: pathlib.Path, command: str, timeout: float) -> str:
    result = subprocess.run(
        [fdbcli, "-C", str(cluster_file), "--exec", command],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        universal_newlines=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "fdbcli command {!r} exited {}: {}".format(
                command, result.returncode, result.stdout[-4000:]
            )
        )
    return result.stdout


def parse_status_json(output: str) -> Dict[str, Any]:
    start = output.find("{")
    end = output.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("fdbcli status json returned no JSON object")
    try:
        return json.loads(output[start : end + 1])
    except json.JSONDecodeError as error:
        raise RuntimeError("fdbcli status json returned malformed JSON") from error


def nested_number(value: Dict[str, Any], path: Tuple[str, ...]) -> Optional[float]:
    current = value  # type: Any
    for component in path:
        if not isinstance(current, dict) or component not in current:
            return None
        current = current[component]
    if isinstance(current, (int, float)) and math.isfinite(float(current)):
        return float(current)
    return None


METRICS = {
    "input_bytes_hz": ("input_bytes", "hz"),
    "bytes_queried_hz": ("bytes_queried", "hz"),
    "read_requests_hz": ("total_queries", "hz"),
    "mutation_bytes_hz": ("mutation_bytes", "hz"),
}

DEFAULT_REQUIRED_METRICS = (
    "input_bytes_hz",
    "bytes_queried_hz",
    "mutation_bytes_hz",
)


def storage_samples(status: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    cluster = status.get("cluster")
    processes = cluster.get("processes") if isinstance(cluster, dict) else None
    if not isinstance(processes, dict):
        raise RuntimeError("status json has no cluster.processes map")
    storage = {}  # type: Dict[str, Dict[str, float]]
    for process_key, process in processes.items():
        if not isinstance(process, dict):
            continue
        address = str(process.get("address") or process_key)
        roles = process.get("roles")
        if not isinstance(roles, list):
            continue
        for role in roles:
            if not isinstance(role, dict) or role.get("role") != "storage":
                continue
            server_id = str(role.get("id") or address)
            metrics = {}  # type: Dict[str, float]
            for name, path in METRICS.items():
                value = nested_number(role, path)
                if value is not None:
                    metrics[name] = max(0.0, value)
            storage[server_id] = metrics
    if not storage:
        raise RuntimeError("status json reported no storage roles")
    return storage


def distribution(values: Iterable[float]) -> Optional[Dict[str, float]]:
    samples = list(values)
    total = sum(samples)
    if not samples or total <= 0:
        return None
    mean = total / len(samples)
    return {
        "servers": len(samples),
        "total_hz": total,
        "max_hz": max(samples),
        "max_share": max(samples) / total,
        "max_to_mean": max(samples) / mean,
        "coefficient_of_variation": statistics.pstdev(samples) / mean,
    }


def parse_locations(output: str) -> List[Dict[str, Any]]:
    ranges = []  # type: List[Dict[str, Any]]
    current = None  # type: Optional[Dict[str, Any]]
    for line in output.splitlines():
        if line.startswith("Key range:"):
            current = {"range": line[len("Key range:") :].strip(), "servers": []}
            ranges.append(current)
            continue
        match = ADDRESS_PATTERN.match(line)
        if match and current is not None:
            current["servers"].append(match.group(1))
    if not ranges:
        raise RuntimeError("fdbcli getlocation returned no key ranges")
    if any(not item["servers"] for item in ranges):
        raise RuntimeError("one or more FDB key ranges has no storage locations")
    return ranges


def location_summary(ranges: List[Dict[str, Any]]) -> Dict[str, Any]:
    owners = collections.Counter()  # type: ignore
    teams = collections.Counter()  # type: ignore
    for item in ranges:
        team = tuple(sorted(set(item["servers"])))
        teams[team] += 1
        owners.update(team)
    total_ownerships = sum(owners.values())
    return {
        "ranges": len(ranges),
        "storage_servers": len(owners),
        "replica_counts": dict(collections.Counter(len(set(item["servers"])) for item in ranges)),
        "unique_teams": len(teams),
        "range_ownership": dict(sorted(owners.items())),
        "max_ownership_share": (
            max(owners.values()) / total_ownerships if total_ownerships else None
        ),
        "range_transcript_sha256": hashlib.sha256(
            json.dumps(ranges, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }


def validate_cloud_site(cell_id: str, site_file: pathlib.Path) -> None:
    actual = site_file.read_text().strip()
    if actual != cell_id or not cell_id.startswith("actor-bj-"):
        raise ValueError("FDB distribution qualification must run on the matching Beijing Cell")


def load_location_baseline(path: pathlib.Path, cell_id: str) -> Dict[str, Any]:
    document = json.loads(path.read_text())
    location = document.get("location")
    if document.get("verdict") != "baseline" or document.get("cell_id") != cell_id:
        raise ValueError("FDB location baseline does not belong to this Cell")
    if not isinstance(location, dict):
        raise ValueError("FDB location baseline has no location summary")
    if not isinstance(location.get("ranges"), int) or location["ranges"] <= 0:
        raise ValueError("FDB location baseline has an invalid range count")
    transcript = location.get("range_transcript_sha256")
    if not isinstance(transcript, str) or len(transcript) != 64:
        raise ValueError("FDB location baseline has an invalid transcript hash")
    return location


def run_qualification(args: argparse.Namespace) -> Dict[str, Any]:
    validate_cloud_site(args.cell_id, args.execution_site_file)
    if args.samples < 2:
        raise ValueError("samples must be at least 2")
    if args.interval_seconds < 0:
        raise ValueError("interval-seconds must not be negative")
    if args.command_timeout_seconds <= 0:
        raise ValueError("command-timeout-seconds must be positive")
    if args.min_ranges <= 0:
        raise ValueError("min-ranges must be positive")
    if args.min_storage_servers <= 0:
        raise ValueError("min-storage-servers must be positive")
    if args.min_unique_teams <= 0:
        raise ValueError("min-unique-teams must be positive")
    if not (0 < args.max_storage_share < 1):
        raise ValueError("max-storage-share must be between 0 and 1")
    if not (0 < args.max_range_ownership_share < 1):
        raise ValueError("max-range-ownership-share must be between 0 and 1")
    required_metrics = args.required_metric or list(DEFAULT_REQUIRED_METRICS)
    if len(set(required_metrics)) != len(required_metrics):
        raise ValueError("required-metric values must be unique")
    location_output = run_fdbcli(
        args.fdbcli,
        args.cluster_file,
        'getlocation "" \\xff',
        args.command_timeout_seconds,
    )
    ranges = parse_locations(location_output)
    locations = location_summary(ranges)
    if getattr(args, "location_only", False):
        return {
            "verdict": "baseline",
            "cell_id": args.cell_id,
            "cluster_file": str(args.cluster_file),
            "location": locations,
            "interpretation": "pre-load FDB application range baseline; not a scale pass",
        }
    baseline_path = getattr(args, "baseline_location", None)
    if baseline_path is None:
        raise ValueError("full FDB distribution qualification requires --baseline-location")
    min_range_growth = int(getattr(args, "min_range_growth", 16))
    if min_range_growth <= 0:
        raise ValueError("min-range-growth must be positive")
    baseline = load_location_baseline(baseline_path, args.cell_id)
    range_growth = locations["ranges"] - baseline["ranges"]
    if range_growth < min_range_growth:
        raise RuntimeError(
            "FDB application keyspace added only {} ranges over baseline; expected at least {}".format(
                range_growth, min_range_growth
            )
        )
    if (
        locations["range_transcript_sha256"]
        == baseline["range_transcript_sha256"]
    ):
        raise RuntimeError("FDB range transcript did not change from the pre-load baseline")
    if locations["ranges"] < args.min_ranges:
        raise RuntimeError(
            "FDB application keyspace has only {} ranges; expected at least {}".format(
                locations["ranges"], args.min_ranges
            )
        )
    if locations["storage_servers"] < args.min_storage_servers:
        raise RuntimeError(
            "range ownership reaches only {} storage servers; expected at least {}".format(
                locations["storage_servers"], args.min_storage_servers
            )
        )
    if locations["unique_teams"] < args.min_unique_teams:
        raise RuntimeError(
            "range placement uses only {} unique storage teams; expected at least {}".format(
                locations["unique_teams"], args.min_unique_teams
            )
        )
    if locations["max_ownership_share"] > args.max_range_ownership_share:
        raise RuntimeError(
            "one storage server owns {:.3f} of range replicas; maximum is {:.3f}".format(
                locations["max_ownership_share"], args.max_range_ownership_share
            )
        )

    samples = []  # type: List[Dict[str, Any]]
    metric_worst = {}  # type: Dict[str, Dict[str, float]]
    for index in range(args.samples):
        status = parse_status_json(
            run_fdbcli(
                args.fdbcli,
                args.cluster_file,
                "status json",
                args.command_timeout_seconds,
            )
        )
        storage = storage_samples(status)
        if len(storage) < args.min_storage_servers:
            raise RuntimeError(
                "status sample has only {} storage roles; expected at least {}".format(
                    len(storage), args.min_storage_servers
                )
            )
        metrics = {}
        for metric in METRICS:
            present = [values.get(metric, 0.0) for values in storage.values()]
            summary = distribution(present)
            if summary is not None:
                metrics[metric] = summary
                prior = metric_worst.get(metric)
                if prior is None or summary["max_share"] > prior["max_share"]:
                    metric_worst[metric] = summary
        samples.append({"index": index, "storage_servers": len(storage), "metrics": metrics})
        if index + 1 < args.samples and args.interval_seconds:
            time.sleep(args.interval_seconds)

    missing_metrics = [metric for metric in required_metrics if metric not in metric_worst]
    if missing_metrics:
        raise RuntimeError(
            "required storage-server load stayed zero or was absent: {}".format(
                ", ".join(sorted(missing_metrics))
            )
        )
    violations = {
        metric: summary
        for metric, summary in metric_worst.items()
        if summary["max_share"] > args.max_storage_share
    }
    if violations:
        raise RuntimeError(
            "storage-server hotspot threshold exceeded for: {}".format(
                ", ".join(sorted(violations))
            )
        )

    return {
        "verdict": "passed",
        "cell_id": args.cell_id,
        "cluster_file": str(args.cluster_file),
        "location": locations,
        "range_split_proof": {
            "baseline": str(baseline_path.resolve()),
            "baseline_sha256": hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
            "baseline_ranges": baseline["ranges"],
            "final_ranges": locations["ranges"],
            "range_growth": range_growth,
            "min_range_growth": min_range_growth,
            "transcript_changed": True,
        },
        "samples": samples,
        "worst_distribution": metric_worst,
        "thresholds": {
            "min_ranges": args.min_ranges,
            "min_storage_servers": args.min_storage_servers,
            "min_unique_teams": args.min_unique_teams,
            "max_storage_share": args.max_storage_share,
            "max_range_ownership_share": args.max_range_ownership_share,
            "required_metrics": required_metrics,
        },
        "interpretation": (
            "range ownership plus storage-role load distribution; does not infer physical bytes "
            "from logical footprint bytes"
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell-id", required=True)
    parser.add_argument("--execution-site-file", type=pathlib.Path, required=True)
    parser.add_argument("--cluster-file", type=pathlib.Path, required=True)
    parser.add_argument("--location-only", action="store_true")
    parser.add_argument("--baseline-location", type=pathlib.Path)
    parser.add_argument("--min-range-growth", type=int, default=16)
    parser.add_argument("--fdbcli", default="fdbcli")
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--interval-seconds", type=float, default=5)
    parser.add_argument("--command-timeout-seconds", type=float, default=30)
    parser.add_argument("--min-ranges", type=int, default=32)
    parser.add_argument("--min-storage-servers", type=int, default=6)
    parser.add_argument("--min-unique-teams", type=int, default=3)
    parser.add_argument("--max-storage-share", type=float, default=0.35)
    parser.add_argument("--max-range-ownership-share", type=float, default=0.35)
    parser.add_argument("--required-metric", action="append", choices=tuple(METRICS))
    parser.add_argument("--output", type=pathlib.Path)
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
