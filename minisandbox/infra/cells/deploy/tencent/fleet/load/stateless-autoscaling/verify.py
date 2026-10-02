#!/usr/bin/env python3
"""Verify one low -> expanded -> low stateless TKE capacity trace."""

import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path


STARTUP_TAINT = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def sha256(path):
	digest = hashlib.sha256()
	with path.open("rb") as stream:
		for chunk in iter(lambda: stream.read(1024 * 1024), b""):
			digest.update(chunk)
	return digest.hexdigest()


def cells(sample, expected):
	if sample.get("schema") != "actor-stateless-autoscaling-sample/v1":
		return None
	values = {item.get("cell"): item for item in sample.get("cells", [])}
	return values if set(values) == set(expected) else None


def healthy(cell):
	return not cell.get("errors")


def node_matches_runtime(node, deployment):
	image, digest = deployment.get("runtimeImage"), deployment.get("runtimeDigest")
	return (
		isinstance(image, str) and isinstance(digest, str) and DIGEST.fullmatch(digest) is not None
		and image.endswith("@" + digest) and node.get("runtimeImage") == image
		and node.get("admissionPhase") == "Admitted" and bool(node.get("profileDigest"))
	)


def low(cell, floor):
	hpa, deployment, machine = cell.get("hpa", {}), cell.get("deployment", {}), cell.get("machineSet", {})
	nodes = cell.get("nodes", [])
	return (
		healthy(cell) and hpa.get("current") == floor and hpa.get("desired") == floor
		and deployment.get("desired") == floor and deployment.get("ready") == floor
		and deployment.get("available") == floor and machine.get("desired") == floor
		and machine.get("current") == floor and machine.get("ready") == floor
		and len(nodes) == floor and all(node.get("ready") and node.get("admitted")
			and node_matches_runtime(node, deployment)
			and STARTUP_TAINT not in node.get("taints", []) for node in nodes)
	)


def expanded(cell, floor, baseline_nodes):
	machine, deployment = cell.get("machineSet", {}), cell.get("deployment", {})
	nodes = cell.get("nodes", [])
	new_nodes = [node for node in nodes if node.get("uid") not in baseline_nodes]
	new_names = {node.get("name") for node in new_nodes}
	new_ready_pods = [pod for pod in cell.get("pods", []) if pod.get("ready") and pod.get("node") in new_names]
	return (
		healthy(cell) and machine.get("desired", 0) > floor and machine.get("ready", 0) > floor
		and deployment.get("ready", 0) > floor and bool(new_nodes) and bool(new_ready_pods)
		and all(node.get("ready") and node.get("admitted") and node_matches_runtime(node, deployment)
			and STARTUP_TAINT not in node.get("taints", []) for node in new_nodes)
	)


def verify(trace_path, load_path, expected_cells, floor):
	load = json.loads(load_path.read_text())
	samples = []
	with trace_path.open() as stream:
		for line_number, line in enumerate(stream, 1):
			try:
				value = json.loads(line)
			except json.JSONDecodeError as error:
				raise ValueError(f"invalid trace line {line_number}: {error}") from error
			mapped = cells(value, expected_cells)
			if mapped is not None:
				samples.append((value.get("observedAt"), mapped))
	if not samples:
		raise ValueError("capacity trace has no complete two-Cell samples")
	baseline_index = next((index for index, (_, value) in enumerate(samples)
		if all(low(value[name], floor) for name in expected_cells)), None)
	baseline_nodes = {}
	if baseline_index is not None:
		baseline_nodes = {
			name: {node.get("uid") for node in samples[baseline_index][1][name].get("nodes", [])}
			for name in expected_cells
		}
	hpa_indices = {name: next((index for index, (_, value) in enumerate(samples)
		if baseline_index is not None and index > baseline_index
		and value[name].get("hpa", {}).get("desired", 0) > floor), None) for name in expected_cells}
	pending_indices = {name: next((index for index, (_, value) in enumerate(samples)
		if hpa_indices[name] is not None and index >= hpa_indices[name] and any(
			pod.get("phase") == "Pending" and not pod.get("node") for pod in value[name].get("pods", [])
		)), None) for name in expected_cells}
	expanded_indices = {name: next((index for index, (_, value) in enumerate(samples)
		if baseline_index is not None and index > baseline_index
		and expanded(value[name], floor, baseline_nodes[name])), None) for name in expected_cells}
	expanded_index = max(expanded_indices.values()) if all(index is not None for index in expanded_indices.values()) else None
	final_index = next((index for index in range(len(samples) - 1, -1, -1)
		if expanded_index is not None and index > expanded_index
		and all(low(samples[index][1][name], floor) for name in expected_cells)), None)
	load_ok = (
		load.get("schema") == "actor-stateless-autoscaling-load/v1" and load.get("verdict") == "passed"
		and load.get("config", {}).get("durationMs", 0) >= 900_000
		and load.get("config", {}).get("holdMs", 0) >= 450_000
		and load.get("config", {}).get("rate") == 2.5
		and load.get("config", {}).get("maxInFlight", 0) <= 1_500
		and load.get("config", {}).get("responsePaddingBytes") == 65_536
		and load.get("counters", {}).get("started", 0) >= 2_000
		and load.get("counters", {}).get("completed") == load.get("counters", {}).get("started")
		and load.get("counters", {}).get("failed") == 0 and load.get("workerDeleted") is True
	)
	identities_stable = all(
		len({value[name].get("machineSet", {}).get("uid") for _, value in samples if healthy(value[name])}) == 1
		and len({value[name].get("hpa", {}).get("uid") for _, value in samples if healthy(value[name])}) == 1
		for name in expected_cells
	)
	checks = {
		"loadPassed": load_ok,
		"initialLowCapacity": baseline_index is not None,
		"hpaScaleUpObserved": all(index is not None for index in hpa_indices.values()),
		"pendingPodObservedInBothCells": all(index is not None for index in pending_indices.values()),
		"tkeMachineAndAdmissionScaleUpObserved": expanded_index is not None,
		"identityStable": identities_stable,
		"finalLowCapacity": final_index is not None,
	}
	return {
		"schema": "actor-stateless-autoscaling-qualification/v1",
		"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
		"verdict": "passed" if all(checks.values()) else "failed", "checks": checks,
		"expected": {
			"cells": list(expected_cells), "floorPerCell": floor,
			"load": {"minimumDurationMs": 900_000, "minimumHoldMs": 450_000, "rate": 2.5,
				"maximumInFlight": 1_500, "responsePaddingBytes": 65_536, "minimumRequests": 2_000},
		},
		"inputs": {
			"capacityTrace": {"path": str(trace_path), "sha256": sha256(trace_path)},
			"loadReceipt": {"path": str(load_path), "sha256": sha256(load_path)},
		},
		"evidence": {
			"samples": len(samples), "baselineSample": baseline_index, "hpaScaleSamples": hpa_indices,
			"pendingSamples": pending_indices, "expandedSamples": expanded_indices, "finalSample": final_index,
		},
	}


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--trace", type=Path, required=True)
	parser.add_argument("--load-receipt", type=Path, required=True)
	parser.add_argument("--output", type=Path, required=True)
	parser.add_argument("--cell", action="append", required=True)
	parser.add_argument("--floor", type=int, default=3)
	args = parser.parse_args()
	if len(args.cell) != 2 or len(set(args.cell)) != 2 or args.floor < 1:
		parser.error("exactly two distinct Cells and a positive floor are required")
	if not args.output.is_absolute() or args.output.exists():
		parser.error("output must be a new absolute path")
	receipt = verify(args.trace, args.load_receipt, tuple(args.cell), args.floor)
	args.output.parent.mkdir(parents=True, exist_ok=True)
	descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
	with os.fdopen(descriptor, "w") as stream:
		json.dump(receipt, stream, indent=2, sort_keys=True)
		stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
	print(json.dumps({"verdict": receipt["verdict"], **receipt["evidence"]}, sort_keys=True))
	return 0 if receipt["verdict"] == "passed" else 1


if __name__ == "__main__":
	raise SystemExit(main())
