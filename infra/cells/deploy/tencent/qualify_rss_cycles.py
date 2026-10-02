#!/usr/bin/env python3
"""Repeated active -> cold -> wake -> delete RSS convergence qualification.

Run this on a Beijing runtime/load host. Each cycle delegates exact Actor
lifecycle and cleanup to qualify_workerd_density.py, writes a gzipped immutable
cycle receipt, waits for a post-cleanup settle window, and captures Linux
/proc plus cgroup-v2 memory attribution. The verdict ignores configured warmup
cycles, then bounds both retained-RSS slope and plateau span.
"""

import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import pathlib
import time
from typing import Any, Dict, List, Optional, Tuple


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_workerd_density.py")
SPEC = importlib.util.spec_from_file_location("qualify_workerd_density_for_cycles", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
density = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(density)


def parse_kib_file(path: pathlib.Path) -> Dict[str, int]:
    values = {}
    for line in path.read_text().splitlines():
        if ":" not in line:
            continue
        name, raw = line.split(":", 1)
        fields = raw.split()
        if not fields:
            continue
        try:
            value = int(fields[0])
        except ValueError:
            continue
        multiplier = 1024 if len(fields) > 1 and fields[1] == "kB" else 1
        values[name] = value * multiplier
    return values


def cgroup_memory(pid: int, proc_root: pathlib.Path, cgroup_root: pathlib.Path) -> Dict[str, Any]:
    try:
        lines = (proc_root / str(pid) / "cgroup").read_text().splitlines()
        relative = next(line.split("::", 1)[1] for line in lines if line.startswith("0::"))
        root = cgroup_root / relative.lstrip("/")
        current = int((root / "memory.current").read_text().strip())
        peak_path = root / "memory.peak"
        peak = int(peak_path.read_text().strip()) if peak_path.exists() else None
        stats = {}
        for line in (root / "memory.stat").read_text().splitlines():
            name, value = line.split()
            if name in ("anon", "file", "kernel", "slab", "sock"):
                stats[name + "_bytes"] = int(value)
        return {"path": str(root), "current_bytes": current, "peak_bytes": peak, **stats}
    except (FileNotFoundError, PermissionError, StopIteration, ValueError):
        return {"unavailable": True}


def process_memory(
    pid: int,
    proc_root: pathlib.Path = pathlib.Path("/proc"),
    cgroup_root: pathlib.Path = pathlib.Path("/sys/fs/cgroup"),
) -> Dict[str, Any]:
    process_root = proc_root / str(pid)
    try:
        status = parse_kib_file(process_root / "status")
    except FileNotFoundError as error:
        raise RuntimeError("process {} disappeared during RSS qualification".format(pid)) from error
    rollup = {}
    try:
        rollup = parse_kib_file(process_root / "smaps_rollup")
    except (FileNotFoundError, PermissionError):
        pass
    return {
        "pid": pid,
        "vm_rss_bytes": status.get("VmRSS"),
        "rss_anon_bytes": status.get("RssAnon"),
        "rss_file_bytes": status.get("RssFile"),
        "rss_shmem_bytes": status.get("RssShmem"),
        "vm_size_bytes": status.get("VmSize"),
        "pss_bytes": rollup.get("Pss"),
        "private_clean_bytes": rollup.get("Private_Clean"),
        "private_dirty_bytes": rollup.get("Private_Dirty"),
        "anonymous_bytes": rollup.get("Anonymous"),
        "swap_bytes": rollup.get("Swap"),
        "cgroup": cgroup_memory(pid, proc_root, cgroup_root),
    }


def linear_slope(values: List[int]) -> float:
    if len(values) < 2:
        return 0.0
    mean_x = (len(values) - 1) / 2.0
    mean_y = sum(values) / len(values)
    denominator = sum((index - mean_x) ** 2 for index in range(len(values)))
    if denominator == 0:
        return 0.0
    return sum(
        (index - mean_x) * (value - mean_y)
        for index, value in enumerate(values)
    ) / denominator


def assess_convergence(
    cycles: List[Dict[str, Any]],
    warmup_cycles: int,
    max_slope_bytes: int,
    max_plateau_span_bytes: int,
) -> Dict[str, Any]:
    labels = sorted(cycles[0]["post_settle_memory"])
    result = {}
    for label in labels:
        values = [
            cycle["post_settle_memory"][label]["vm_rss_bytes"]
            for cycle in cycles[warmup_cycles:]
        ]
        if len(values) < 3 or any(value is None for value in values):
            raise RuntimeError(
                "RSS convergence requires at least three post-warmup samples for {}".format(
                    label
                )
            )
        slope = linear_slope(values)
        span = max(values) - min(values)
        passed = slope <= max_slope_bytes and span <= max_plateau_span_bytes
        result[label] = {
            "samples_bytes": values,
            "slope_bytes_per_cycle": slope,
            "plateau_span_bytes": span,
            "max_slope_bytes_per_cycle": max_slope_bytes,
            "max_plateau_span_bytes": max_plateau_span_bytes,
            "passed": passed,
        }
    return result


def settle_memory(
    processes: Dict[str, int], settle_seconds: float, interval_seconds: float
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Any]]:
    deadline = time.monotonic() + settle_seconds
    series = {label: [] for label in processes}
    while True:
        for label, pid in processes.items():
            series[label].append(process_memory(pid))
        if time.monotonic() >= deadline:
            break
        time.sleep(min(interval_seconds, max(0.0, deadline - time.monotonic())))
    final = {label: values[-1] for label, values in series.items()}
    summary = {
        label: {
            "samples": len(values),
            "min_vm_rss_bytes": min(value["vm_rss_bytes"] for value in values),
            "max_vm_rss_bytes": max(value["vm_rss_bytes"] for value in values),
        }
        for label, values in series.items()
    }
    return final, summary


def write_cycle_receipt(output_dir: pathlib.Path, index: int, result: Dict[str, Any]) -> Dict[str, Any]:
    encoded = json.dumps(result, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    path = output_dir / "cycle-{:03d}.json.gz".format(index)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(str(temporary), "wb", compresslevel=6) as output:
        output.write(encoded)
        output.write(b"\n")
    os.replace(str(temporary), str(path))
    return {"path": str(path.resolve()), "content_sha256": digest}


def run_qualification(args: argparse.Namespace) -> Dict[str, Any]:
    if args.cycles < args.warmup_cycles + 3:
        raise ValueError("cycles must leave at least three post-warmup samples")
    if args.settle_seconds < 0 or args.settle_interval_seconds <= 0:
        raise ValueError("invalid settle interval")
    actual_cell = args.execution_site_file.read_text().strip()
    if actual_cell != args.cell_id or not args.cell_id.startswith("actor-bj-"):
        raise ValueError("RSS cycles must run on the matching Beijing Cell")
    processes = dict(args.process)
    if not processes:
        raise ValueError("at least one process LABEL=PID is required")
    if len(processes) != len(args.process):
        raise ValueError("process labels must be unique")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    cycles = []
    for index in range(args.cycles):
        density_output = args.output_dir / "cycle-{:03d}.density.json".format(index)
        density_args = argparse.Namespace(
            engine_url=args.engine_url,
            namespace=args.namespace,
            runner_name=args.runner_name,
            actor_name=args.actor_name,
            actors=args.actors,
            concurrency=args.concurrency,
            increments_per_actor=args.increments_per_actor,
            cold_settle_seconds=args.cold_settle_seconds,
            ready_timeout_seconds=args.ready_timeout_seconds,
            ready_poll_seconds=args.ready_poll_seconds,
            request_timeout_seconds=args.request_timeout_seconds,
            run_id="{}-cycle-{:03d}".format(args.run_id, index),
            process=args.process,
            keep_actors=False,
            skip_final_verify=False,
            host_stats_url=None,
            host_registry_url=None,
            host_stats=args.host_stats,
            min_active_hosts=args.min_active_hosts,
            prove_sleep=True,
            wake_after_sleep=True,
            quiescence_timeout_seconds=args.quiescence_timeout_seconds,
            quiescence_poll_seconds=args.quiescence_poll_seconds,
            output=density_output,
        )
        density_result = density.run_qualification(density_args)
        if density_result["verdict"] != "passed":
            raise RuntimeError(
                "cycle {} did not complete exact cleanup: {}".format(
                    index, density_result["verdict"]
                )
            )
        receipt = write_cycle_receipt(args.output_dir, index, density_result)
        inflight = density_output.with_suffix(density_output.suffix + ".inflight")
        if inflight.exists():
            inflight.unlink()
        final, settle = settle_memory(
            processes, args.settle_seconds, args.settle_interval_seconds
        )
        cycles.append(
            {
                "index": index,
                "density_receipt": receipt,
                "latency": density_result["latency"],
                "density_rss": density_result["rss"],
                "host_stats": density_result["host_stats"],
                "post_settle_memory": final,
                "post_settle_window": settle,
            }
        )

    convergence = assess_convergence(
        cycles,
        args.warmup_cycles,
        args.max_slope_bytes_per_cycle,
        args.max_plateau_span_bytes,
    )
    failed = [label for label, value in convergence.items() if not value["passed"]]
    if failed:
        raise RuntimeError(
            "retained RSS did not converge for: {}".format(", ".join(failed))
        )
    return {
        "verdict": "passed",
        "cell_id": args.cell_id,
        "run_id": args.run_id,
        "cycles": cycles,
        "warmup_cycles": args.warmup_cycles,
        "convergence": convergence,
        "memory_attribution": (
            "VmRSS/RssAnon/RssFile/smaps_rollup plus cgroup-v2 memory where available"
        ),
    }


def byte_count(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected an integer byte count") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("byte count must not be negative")
    return parsed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cell-id", required=True)
    parser.add_argument("--execution-site-file", type=pathlib.Path, required=True)
    parser.add_argument("--engine-url", default="http://127.0.0.1:6420")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--runner-name", action="append", required=True)
    parser.add_argument("--actor-name", default="workerd-counter")
    parser.add_argument("--actors", type=int, choices=(2_000, 4_000), required=True)
    parser.add_argument("--concurrency", type=int, default=64)
    parser.add_argument("--increments-per-actor", type=int, default=4)
    parser.add_argument("--cycles", type=int, default=8)
    parser.add_argument("--warmup-cycles", type=int, default=2)
    parser.add_argument("--cold-settle-seconds", type=float, default=0)
    parser.add_argument("--settle-seconds", type=float, default=60)
    parser.add_argument("--settle-interval-seconds", type=float, default=5)
    parser.add_argument("--max-slope-bytes-per-cycle", type=byte_count, default=8 * 1024 * 1024)
    parser.add_argument("--max-plateau-span-bytes", type=byte_count, default=128 * 1024 * 1024)
    parser.add_argument("--ready-timeout-seconds", type=float, default=300)
    parser.add_argument("--ready-poll-seconds", type=float, default=0.25)
    parser.add_argument("--request-timeout-seconds", type=float, default=60)
    parser.add_argument("--quiescence-timeout-seconds", type=float, default=300)
    parser.add_argument("--quiescence-poll-seconds", type=float, default=0.25)
    parser.add_argument("--process", action="append", type=density.process_argument, required=True)
    parser.add_argument("--host-stats", action="append", type=density.host_stats_argument, required=True)
    parser.add_argument("--min-active-hosts", type=int, default=3)
    parser.add_argument("--run-id", default="rss-cycles")
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
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
