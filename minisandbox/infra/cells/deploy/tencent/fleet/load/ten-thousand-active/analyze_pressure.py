#!/usr/bin/env python3
"""Offline diagnostics, not a capacity qualification or a causal verdict."""

import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import stat

from verify import capacity_identity


CELLS = ("actor-bj-a01", "actor-bj-b01")
SCALARS = ("activeActors", "hostRssBytes", "udbPending", "gasolineWorkflows",
           "depotManagerRefreshInflight", "depotManagerRefreshWaiters",
           "depotCompactionInflight", "depotCompactionWaiters")
ACTIVITIES = ("refresh_manager", "observe_active_manager", "stage_hot_job", "install_hot_job",
              "upload_cold_job", "publish_cold_job", "reclaim_fdb_job",
              "retire_cold_objects", "delete_retired_cold_objects")
TRANSACTIONS = ("depot_manager_refresh", "depot_manager_observe_active", "depot_hot_compact_stage")
OPERATIONS = ("cold_upload", "cold_publish", "reclaim_fdb")
OUTPUT_UNITS = {
    "cold_upload": ("planned_hot_shard_bytes", "cold_object_reference"),
    "cold_publish": ("planned_hot_shard_bytes", "cold_object_reference"),
    "reclaim_fdb": ("deleted_fdb_value_bytes", "deleted_fdb_key"),
}
LEDGER_CLASSES = ("live", "retired", "delete_issued", "orphan", "deleted_total",
                  "fdb_authoritative", "fdb_cache", "fdb_metadata")
MAX_LINE_BYTES = 4 * 1024 * 1024


def number(value):
    if type(value) not in (str, int, float):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, OverflowError):
        return None


def ratio(numerator, denominator):
    if numerator is None or denominator is None or denominator <= 0:
        return None
    value = numerator / denominator
    return value if math.isfinite(value) else None


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("missing observation time")
    result = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("observation time needs a timezone")
    return result.timestamp()


def schema(trace):
    if trace in SCALARS:
        return {}
    if trace in ("coldStorageBytesMin", "coldStorageBytesMax"):
        return {"class": LEDGER_CLASSES}
    if trace in ("compactionBytesPerSecond", "compactionObjectsPerSecond"):
        return {"operation": OPERATIONS}
    if trace.startswith("depotPlanning") and trace in (
            "depotPlanningReadBytesPerSecond", "depotPlanningTransactionAttemptsPerSecond",
            "depotPlanningTransactionCompletionsPerSecond"):
        return {"name": TRANSACTIONS}
    if trace in ("depotAdmissionSecondsPerSecond", "depotAdmissionOutcomesPerSecond"):
        return {"activity_name": ACTIVITIES,
                "result": ("ready", "complete", "deferred", "error", "evicted")}
    if trace in ("depotExecutionSecondsPerSecond", "depotExecutionOutcomesPerSecond"):
        return {"activity_name": ACTIVITIES, "result": ("succeeded", "error", "timeout")}
    return None  # Unused families do not create dynamically named result fields.


def snapshot(cell):
    raw = cell.get("metricsSnapshot")
    if raw is None:
        return {"metrics": {}, "requestedAtEpochSeconds": None, "rateWindowSeconds": None}
    if not isinstance(raw, dict) or not isinstance(raw.get("samples"), list):
        raise ValueError("invalid metric snapshot")
    requested = number(raw.get("requestedAtEpochSeconds"))
    if requested is None or type(raw.get("rateWindowSeconds")) is not int or raw["rateWindowSeconds"] != 300:
        raise ValueError("invalid snapshot time or rate window")
    if len(raw["samples"]) > 256:
        raise ValueError("too many metric samples")
    metrics = {}
    for row in raw["samples"]:
        if not isinstance(row, dict):
            raise ValueError("invalid metric sample")
        labels = row.get("labels")
        if not isinstance(labels, dict) or not isinstance(labels.get("trace"), str):
            raise ValueError("invalid metric labels")
        trace = labels["trace"]
        dimensions = schema(trace)
        if dimensions is None:
            continue
        if set(labels) != {"trace", *dimensions} or any(
                labels[name] not in allowed for name, allowed in dimensions.items()):
            raise ValueError("unexpected metric dimensions")
        key = (trace, *(labels[name] for name in dimensions))
        if key in metrics:
            raise ValueError("duplicate aggregated metric")
        sample_time = number(row.get("timestamp"))
        if sample_time is None or abs(sample_time - requested) > 1:
            raise ValueError("metric time does not match instant query")
        metrics[key] = number(row.get("value")) if row.get("finite") is True else None
    return {"metrics": metrics, "requestedAtEpochSeconds": requested, "rateWindowSeconds": 300}


def derived(frame):
    values = frame["metrics"]
    get = lambda *key: values.get(tuple(key))
    result = {"requestedAtEpochSeconds": frame["requestedAtEpochSeconds"],
              "rateWindowSeconds": frame["rateWindowSeconds"],
              "gauges": {name: get(name) for name in SCALARS}}
    result["planning"] = {name: {
        "completedTransactionsPerSecond": get("depotPlanningTransactionCompletionsPerSecond", name),
        "readBytesPerCompletedTransaction": ratio(get("depotPlanningReadBytesPerSecond", name),
            get("depotPlanningTransactionCompletionsPerSecond", name)),
        "attemptsPerCompletedTransaction": ratio(get("depotPlanningTransactionAttemptsPerSecond", name),
            get("depotPlanningTransactionCompletionsPerSecond", name)),
    } for name in TRANSACTIONS}
    result["activities"] = {name: {
        "completedAdmissionMeanSeconds": ratio(get("depotAdmissionSecondsPerSecond", name, "ready"),
            get("depotAdmissionOutcomesPerSecond", name, "ready")),
        "deferredPerSecond": get("depotAdmissionOutcomesPerSecond", name, "deferred"),
        "execution": {outcome: {
            "outcomesPerSecond": get("depotExecutionOutcomesPerSecond", name, outcome),
            "meanSeconds": ratio(get("depotExecutionSecondsPerSecond", name, outcome),
                get("depotExecutionOutcomesPerSecond", name, outcome)),
        } for outcome in ("succeeded", "error", "timeout")},
    } for name in ACTIVITIES}
    result["successfulCompaction"] = {operation: {
        "byteSemantics": OUTPUT_UNITS[operation][0],
        "itemSemantics": OUTPUT_UNITS[operation][1],
        "bytesPerSecond": get("compactionBytesPerSecond", operation),
        "itemsPerSecond": get("compactionObjectsPerSecond", operation),
        "bytesPerItem": ratio(get("compactionBytesPerSecond", operation),
            get("compactionObjectsPerSecond", operation)),
    } for operation in OPERATIONS}
    result["ledgerBounds"] = {name: {
        "min": get("coldStorageBytesMin", name), "max": get("coldStorageBytesMax", name),
    } for name in LEDGER_CLASSES}
    for bound in result["ledgerBounds"].values():
        if bound["min"] is not None and bound["max"] is not None and bound["min"] > bound["max"]:
            raise ValueError("ledger minimum exceeds maximum")
    return result


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON field")
        result[key] = value
    return result


def analyze(path, start_at=None, end_at=None):
    if ((start_at is None) != (end_at is None)
            or (start_at is not None and end_at <= start_at)):
        raise ValueError("observation window needs ordered start and end")
    digest = hashlib.sha256()
    states = {cell: {"samples": 0, "firstLedger": None, "lastSnapshot": None,
                     "capacityIdentity": None, "unboundIdentitySamples": 0,
                     "observedIdentity": {},
                     "lastQueryTime": None,
                     "gaugePeaks": {name: None for name in SCALARS}} for cell in CELLS}
    previous = None
    first_time = None
    last_time = None
    # Reject FIFOs before reading, and do not follow a replaced symlink.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("trace must be a regular file")
        while True:
            line = stream.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                raise ValueError("trace row oversized or incomplete")
            digest.update(line)
            sample = json.loads(line, object_pairs_hook=unique_object)
            if not isinstance(sample, dict):
                raise ValueError("invalid trace row")
            now = timestamp(sample.get("observedAt"))
            if previous is not None and now <= previous:
                raise ValueError("trace times must be strictly increasing")
            previous = now
            cells = sample.get("cells")
            if not isinstance(cells, list) or len(cells) != 2 or not all(isinstance(c, dict) for c in cells):
                raise ValueError("trace requires two exact Cells")
            by_name = {cell.get("cell"): cell for cell in cells}
            if set(by_name) != set(CELLS):
                raise ValueError("duplicate or unexpected Cell")
            if start_at is not None and not start_at <= now <= end_at:
                continue
            first_time = now if first_time is None else first_time
            last_time = now
            for name, cell in by_name.items():
                state = states[name]
                for resource in ("foundationDB", "hostConfig", "machineSet"):
                    if not isinstance(cell.get(resource, {}), dict):
                        raise ValueError("invalid capacity identity")
                    present = cell.get(resource, {}).get("uid")
                    if present is not None:
                        if not isinstance(present, str) or not present or len(present) > 512:
                            raise ValueError("invalid capacity identity")
                        known = state["observedIdentity"].setdefault(resource, present)
                        if present != known:
                            raise ValueError("capacity identity changed")
                for key in ("currentRevision", "updateRevision"):
                    revision = cell.get("hostConfig", {}).get(key)
                    if revision is not None:
                        if not isinstance(revision, str) or not revision or len(revision) > 512:
                            raise ValueError("invalid runtime revision")
                        known = state["observedIdentity"].setdefault("runtimeRevision", revision)
                        if revision != known:
                            raise ValueError("capacity identity changed")
                identity = capacity_identity(cell)
                if identity is None:
                    state["unboundIdentitySamples"] += 1
                elif state["capacityIdentity"] is None:
                    state["capacityIdentity"] = identity
                elif identity != state["capacityIdentity"]:
                    raise ValueError("capacity identity changed")
                frame = snapshot(cell)
                query_time = frame["requestedAtEpochSeconds"]
                if query_time is not None:
                    if state["lastQueryTime"] is not None and query_time <= state["lastQueryTime"]:
                        raise ValueError("metric query times must be strictly increasing")
                    state["lastQueryTime"] = query_time
                current = derived(frame)
                state["samples"] += 1
                state["lastSnapshot"] = current  # Never substitute an older complete snapshot.
                state["lastObservationErrors"] = len(cell.get("errors", []))
                state["lastMetricWarnings"] = len((cell.get("metricsSnapshot") or {}).get("warnings", []))
                for key, value in current["gauges"].items():
                    if value is not None:
                        old = state["gaugePeaks"][key]
                        state["gaugePeaks"][key] = value if old is None else max(old, value)
                bounds = current["ledgerBounds"]["fdb_authoritative"]
                if state["firstLedger"] is None and None not in bounds.values():
                    state["firstLedger"] = {"observedAt": now, "requestedAtEpochSeconds": query_time, **bounds}
        after = os.fstat(stream.fileno())
    if first_time is None:
        raise ValueError("empty trace or observation window")
    if fingerprint(before) != fingerprint(after) or fingerprint(after) != fingerprint(path.stat()):
        raise ValueError("trace changed during analysis; use an immutable snapshot")
    for state in states.values():
        start = state["firstLedger"]
        end = state["lastSnapshot"]["ledgerBounds"]["fdb_authoritative"]
        end_time = state["lastSnapshot"]["requestedAtEpochSeconds"]
        state["observedAuthoritySlopeBoundsBytesPerSecond"] = None
        if (state["unboundIdentitySamples"] == 0 and start is not None
                and None not in end.values() and end_time is not None
                and end_time > start["requestedAtEpochSeconds"]):
            elapsed = end_time - start["requestedAtEpochSeconds"]
            state["observedAuthoritySlopeBoundsBytesPerSecond"] = {
                "min": (end["min"] - start["max"]) / elapsed,
                "max": (end["max"] - start["min"]) / elapsed,
            }
            if not all(math.isfinite(value) for value in state["observedAuthoritySlopeBoundsBytesPerSecond"].values()):
                state["observedAuthoritySlopeBoundsBytesPerSecond"] = None
        state["capacityIdentityComplete"] = state["unboundIdentitySamples"] == 0
    return {"schema": "actor-pressure-analysis/v2", "qualificationEvidence": False,
            "input": {"sha256": digest.hexdigest(), "bytes": before.st_size},
            "observationWindow": {"requestedStartEpochSeconds": start_at, "requestedEndEpochSeconds": end_at,
                                  "firstEpochSeconds": first_time, "lastEpochSeconds": last_time},
            "limitations": ["rolling_5m_rates_not_exact_interval_totals", "completed_outcomes_not_offered_demand",
                "succeeded_activity_not_successful_fold", "ledger_bounds_are_observations_not_provider_billing",
                "successful_activity_counters_not_unique_provider_operations",
                "planned_shard_bytes_not_cos_object_fill_or_wire_bytes",
                "oldest_pending_wait_and_history_replay_bytes_unknown"], "cells": states}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--from-observed-at", type=timestamp)
    parser.add_argument("--until-observed-at", type=timestamp)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("analysis output already exists")
    result = analyze(args.trace, args.from_observed_at, args.until_observed_at)
    # Evidence is exclusive, bounded, and never replaces qualification receipts.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(result, stream, sort_keys=True, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({"schema": result["schema"], "qualificationEvidence": False,
                      "input": result["input"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
