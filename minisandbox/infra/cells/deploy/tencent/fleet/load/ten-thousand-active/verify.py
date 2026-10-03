#!/usr/bin/env python3
"""Build an immutable low -> 10k active -> low qualification receipt."""

import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path


CELLS = ("actor-bj-a01", "actor-bj-b01")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def active(cell):
    values = cell.get("activeActors")
    if not isinstance(values, list) or len(values) != 1:
        return None
    try:
        value = float(values[0])
        return value if math.isfinite(value) and value >= 0 else None
    except (TypeError, ValueError):
        return None


def drain_phase(cell):
    raw = cell.get("hostConfig", {}).get("drainState")
    if not raw:
        return None
    try:
        return json.loads(raw).get("phase")
    except (TypeError, json.JSONDecodeError):
        return "Malformed"


def fdb_healthy(cell):
    fdb = cell.get("foundationDB", {})
    pods = cell.get("foundationDBPods", {})
    health = fdb.get("health", {})
    return (
        fdb.get("configured") is True
        and fdb.get("generation") is not None
        and fdb.get("generation") == fdb.get("reconciledGeneration")
        and all(health.get(name) is True for name in ("available", "fullReplication", "healthy"))
        and isinstance(pods.get("total"), int)
        and pods.get("total") >= 3
        and pods.get("ready") == pods.get("total")
    )


def capacity_identity(cell):
    host = cell.get("hostConfig", {})
    identity = {
        name: cell.get(name, {}).get("uid")
        for name in ("foundationDB", "hostConfig", "machineSet")
    }
    revision = host.get("currentRevision")
    if (not all(isinstance(uid, str) and uid for uid in identity.values())
            or not isinstance(revision, str) or not revision
            or revision != host.get("updateRevision")):
        return None
    return {**identity, "runtimeRevision": revision}


def ready_admitted_nodes(cell):
    # Machine Ready is provider evidence, not runtime admission. Count distinct
    # usable Kubernetes identities and exclude pending or controller-drained nodes.
    identities = set()
    for node in cell.get("nodes", []):
        uid = node.get("uid")
        if (isinstance(uid, str) and uid and node.get("ready") is True
                and node.get("admitted") is True
                and not any(taint.get("key") in {
                    "fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"
                } for taint in node.get("taints", []))):
            identities.add(uid)
    return len(identities)


def active_cell_capacity_ready(cell, hard_active_per_host):
    count = active(cell)
    ready_hosts = cell.get("hostConfig", {}).get("ready")
    ready_machines = cell.get("machineSet", {}).get("ready")
    return (
        count is not None
        and type(ready_hosts) is int and ready_hosts >= 0
        and type(ready_machines) is int and ready_machines >= ready_hosts
        and ready_admitted_nodes(cell) >= ready_hosts
        and count <= ready_hosts * hard_active_per_host
    )


def cell_low(cell, floor):
    host = cell.get("hostConfig", {})
    machine = cell.get("machineSet", {})
    legacy = cell.get("legacyMachineSet", {})
    nodes = cell.get("nodes", [])
    return (
        not cell.get("errors")
        and fdb_healthy(cell)
        and active(cell) == 0
        and host.get("replicas") == floor
        and host.get("ready") == floor
        and host.get("currentRevision") == host.get("updateRevision")
        and not host.get("releaseHold")
        and drain_phase(cell) == "Idle"
        and machine.get("desired") == floor
        and machine.get("current") == floor
        and machine.get("ready") == floor
        and not machine.get("downscaleIntent")
        and legacy.get("desired") == 0
        and (legacy.get("current") or 0) == 0
        and len(nodes) == floor
        and ready_admitted_nodes(cell) == floor
        and all(node.get("ready") and node.get("admitted") for node in nodes)
        and all(not any(taint.get("key") in {
            "fleet.actor.dev/runtime-admission", "fleet.actor.dev/runtime-capacity-drain"
        } for taint in node.get("taints", [])) for node in nodes)
    )


def normalized(sample):
    if not isinstance(sample, dict):
        return None
    cells = sample.get("cells", [])
    if not isinstance(cells, list) or len(cells) != len(CELLS) or not all(
            isinstance(cell, dict) for cell in cells):
        return None
    by_name = {cell.get("cell"): cell for cell in cells}
    if set(by_name) != set(CELLS):
        return None
    active_values = [active(by_name[name]) for name in CELLS]
    if any(value is None for value in active_values):
        active_total = None
    else:
        active_total = sum(active_values)
    return {
        "observedAt": sample.get("observedAt"),
        "cells": by_name,
        "active": active_total,
        "hosts": sum(by_name[name].get("hostConfig", {}).get("replicas") or 0 for name in CELLS),
        "readyHosts": sum(by_name[name].get("hostConfig", {}).get("ready") or 0 for name in CELLS),
        "machines": sum(by_name[name].get("machineSet", {}).get("desired") or 0 for name in CELLS),
        "readyMachines": sum(by_name[name].get("machineSet", {}).get("ready") or 0 for name in CELLS),
        "phases": {name: drain_phase(by_name[name]) for name in CELLS},
        "complete": all(not by_name[name].get("errors") and fdb_healthy(by_name[name])
                        for name in CELLS),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--load-receipt", type=Path, required=True)
    parser.add_argument("--cleanup-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-active", type=int, default=10000)
    parser.add_argument("--expected-objects", type=int, default=11000)
    parser.add_argument("--floor-per-cell", type=int, default=4)
    parser.add_argument("--hard-active-per-host", type=int, default=32)
    parser.add_argument("--load-exit-status", type=int, required=True)
    parser.add_argument("--cleanup-exit-status", type=int, required=True)
    parser.add_argument("--final-capacity-exit-status", type=int, required=True)
    args = parser.parse_args()
    if (args.expected_active < 1 or args.expected_objects < args.expected_active
            or args.floor_per_cell < 1 or args.hard_active_per_host < 1):
        parser.error("invalid qualification bounds")
    exit_statuses = {"load": args.load_exit_status, "cleanup": args.cleanup_exit_status,
                     "finalCapacity": args.final_capacity_exit_status}
    if any(status < 0 or status > 255 for status in exit_statuses.values()):
        parser.error("exit statuses must be integers from 0 through 255")
    if args.output.exists():
        raise SystemExit("receipt output already exists")

    load = json.loads(args.load_receipt.read_text())
    cleanup = json.loads(args.cleanup_receipt.read_text())
    samples = []
    trace_valid = True
    previous_time = None
    with args.trace.open() as stream:
        for line_number, line in enumerate(stream, 1):
            try:
                value = normalized(json.loads(line))
            except json.JSONDecodeError as error:
                raise SystemExit(f"invalid trace line {line_number}: {error}") from error
            if value is not None:
                try:
                    observed = datetime.datetime.fromisoformat(value["observedAt"].replace("Z", "+00:00"))
                    if observed.tzinfo is None or (
                            previous_time is not None and observed <= previous_time):
                        trace_valid = False
                    if observed.tzinfo is not None:
                        previous_time = observed
                except (AttributeError, TypeError, ValueError):
                    trace_valid = False
                samples.append(value)
            else:
                trace_valid = False
    if not samples:
        raise SystemExit("capacity trace is empty")

    baseline = next((index for index, sample in enumerate(samples)
                     if all(cell_low(sample["cells"][name], args.floor_per_cell) for name in CELLS)), None)
    baseline_identities = {
        name: capacity_identity(samples[baseline]["cells"][name]) for name in CELLS
    } if baseline is not None else {}
    identity_stable = (
        bool(baseline_identities)
        and all(baseline_identities.values())
        and all(capacity_identity(sample["cells"][name]) == baseline_identities[name]
                for sample in samples if sample["complete"] for name in CELLS)
    )
    active_indices = [index for index, sample in enumerate(samples)
                      if sample["complete"] and sample["active"] is not None
                      and sample["active"] >= args.expected_active]
    sustained = any(active_indices[offset + 2] == active_indices[offset] + 2
                    and active_indices[offset + 1] == active_indices[offset] + 1
                    for offset in range(max(0, len(active_indices) - 2)))
    peak_index = max(range(len(samples)), key=lambda index: samples[index]["active"] or -1)
    final = next((index for index in range(len(samples) - 1, -1, -1)
                  if index > peak_index and all(
                      cell_low(samples[index]["cells"][name], args.floor_per_cell) for name in CELLS
                  )), None)
    drain_observed = any(
        index > peak_index and any(phase not in (None, "Idle") for phase in sample["phases"].values())
        for index, sample in enumerate(samples)
    )
    max_hosts = max(sample["hosts"] for sample in samples)
    max_ready_hosts = max(sample["readyHosts"] for sample in samples)
    max_machines = max(sample["machines"] for sample in samples)
    max_ready_machines = max(sample["readyMachines"] for sample in samples)
    active_capacity_ready = any(
        sample["complete"] and sample["active"] is not None
        and sample["active"] >= args.expected_active
        and all(active_cell_capacity_ready(sample["cells"][name], args.hard_active_per_host)
                for name in CELLS)
        for sample in samples
    )
    counters = load.get("counters", {})
    warmup_backpressure = load.get("warmupBackpressure", {})
    cleanup_runs = cleanup.get("runs", [])
    cleanup_objects = cleanup.get("objects", {})
    cleanup_passed = (
        cleanup.get("schema") == "actor-shared-agent-cleanup/v1"
        and cleanup.get("verdict") == "passed"
        and len(cleanup_runs) == 1
        and cleanup_runs[0].get("runId") == load.get("runId")
        and cleanup_runs[0].get("scheduled") == counters.get("scheduled")
        and cleanup_objects.get("total") == counters.get("scheduled")
        and cleanup_objects.get("deleted") == counters.get("scheduled")
        and cleanup_objects.get("pending") == 0
    )
    load_passed = (
        load.get("verdict") == "passed"
        and load.get("target") == args.expected_objects
        and load.get("activeTarget") == args.expected_active
        and load.get("activeReady") == args.expected_active
        and load.get("activeProven") == args.expected_active
        and counters.get("objectsCreated") == args.expected_objects
        and counters.get("objectsFailed") == 0
        and counters.get("readySloBreaches") == 0
        and counters.get("requestRetries") == 0
        and counters.get("warmupBackpressureTimeouts", 0) == 0
        and warmup_backpressure.get("timeouts", 0) == 0
        and counters.get("activeFailed") == 0
        and counters.get("activeIdentityMismatches") == 0
    )
    checks = {
        "executionSucceeded": all(status == 0 for status in exit_statuses.values()),
        "capacityTraceValid": trace_valid,
        "capacityIdentityStable": bool(identity_stable),
        "loadReceiptPassed": load_passed,
        "exactObjectCleanupPassed": cleanup_passed,
        "initialLowCapacity": baseline is not None and baseline < peak_index,
        "tenThousandActiveSustained": sustained,
        "automaticScaleUpObserved": max_hosts > args.floor_per_cell * len(CELLS)
            and max_ready_hosts > args.floor_per_cell * len(CELLS)
            and max_machines > args.floor_per_cell * len(CELLS)
            and max_ready_machines > args.floor_per_cell * len(CELLS),
        "activeCapacityReady": active_capacity_ready,
        "safeDrainObserved": drain_observed,
        "finalLowCapacity": final is not None and args.final_capacity_exit_status == 0,
    }
    receipt = {
        "schema": "actor-ten-thousand-active-qualification/v1",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "verdict": "passed" if all(checks.values()) else "failed",
        "checks": checks,
        "executionExitStatuses": exit_statuses,
        "inputs": {
            "capacityTrace": {"path": str(args.trace), "sha256": sha256(args.trace)},
            "loadReceipt": {"path": str(args.load_receipt), "sha256": sha256(args.load_receipt)},
            "cleanupReceipt": {"path": str(args.cleanup_receipt), "sha256": sha256(args.cleanup_receipt)},
        },
        "expected": {"active": args.expected_active, "objects": args.expected_objects,
                     "floorPerCell": args.floor_per_cell,
                     "hardActivePerHost": args.hard_active_per_host},
        "evidence": {
            "capacityIdentities": baseline_identities,
            "samples": len(samples), "completeSamples": sum(sample["complete"] for sample in samples),
            "baselineSample": baseline, "peakSample": peak_index, "finalSample": final,
            "peakActive": samples[peak_index]["active"], "maxHosts": max_hosts,
            "maxReadyHosts": max_ready_hosts, "maxMachines": max_machines,
            "maxReadyMachines": max_ready_machines,
            "baselineObservedAt": samples[baseline]["observedAt"] if baseline is not None else None,
            "peakObservedAt": samples[peak_index]["observedAt"],
            "finalObservedAt": samples[final]["observedAt"] if final is not None else None,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(args.output, flags, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(receipt, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"verdict": receipt["verdict"], **receipt["evidence"]}, sort_keys=True))
    return 0 if receipt["verdict"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
