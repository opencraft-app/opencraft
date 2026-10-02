#!/usr/bin/env python3
"""Verify production-config Workers API scale-out and return to floor."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import tempfile


SCHEMA = "actor-workers-api-cloud-autoscaling-qualification/v1"
EXPECTED_METRICS = {
	("Pods", "workers_api_routing_requests_per_second", "200"),
	("Pods", "workers_api_routing_requests_in_flight", "64"),
	("Resource", "cpu", "65"),
	("Resource", "memory", "75"),
}


def digest(value: object) -> str:
	encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
	return "sha256:" + hashlib.sha256(encoded).hexdigest()


def low(sample: dict, floor: int) -> bool:
	status = sample["hpa"]["status"]
	deployment = sample["deployment"]
	return (
		status.get("currentReplicas") == floor
		and status.get("desiredReplicas") == floor
		and deployment.get("specReplicas") == floor
		and deployment.get("status", {}).get("readyReplicas") == floor
	)


def metrics_complete(sample: dict) -> bool:
	ready = {pod["name"] for pod in sample["pods"] if pod.get("ready")}
	metrics = sample.get("customMetrics", {})
	return bool(ready) and set(metrics) == {
		"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight",
	} and all(
		ready.issubset(set(values)) for values in metrics.values()
	)


def metric_contract(spec: dict) -> set[tuple[str, str, str]]:
	result = set()
	for item in spec.get("metrics", []):
		kind = item.get("type")
		if kind == "Pods":
			value = item.get("pods", {})
			result.add((kind, value.get("metric", {}).get("name"), value.get("target", {}).get("averageValue")))
		elif kind == "Resource":
			value = item.get("resource", {})
			result.add((kind, value.get("name"), str(value.get("target", {}).get("averageUtilization"))))
	return result


def verify(trace: list[dict], load: dict, dependent: list[dict], floor: int, minimum_requests: int) -> dict:
	if len(trace) < 3:
		raise ValueError("capacity trace is too short")
	if load.get("schema") != "actor-stateless-autoscaling-load/v1" or load.get("verdict") != "passed":
		raise ValueError("load receipt did not pass")
	if [item.get("phase") for item in dependent] != ["initial", "final"]:
		raise ValueError("dependent stateless capacity phases are incomplete")
	for phase in dependent:
		if set(phase.get("cells", {})) != {"actor-bj-a01", "actor-bj-b01"} or any(
			state != {"pods": floor, "nodes": floor} for state in phase["cells"].values()
		):
			raise ValueError("dependent stateless capacity did not converge to floor")
	counters = load.get("counters", {})
	if (
		counters.get("started", 0) < minimum_requests
		or counters.get("completed") != counters.get("started")
		or counters.get("failed") != 0
		or counters.get("peakInFlight", 0) <= floor * 64
		or not load.get("workerDeleted")
	):
		raise ValueError("load did not provide bounded successful pressure")
	spec_digests = {digest(item["hpa"]["spec"]) for item in trace}
	if len(spec_digests) != 1:
		raise ValueError("HPA spec changed during qualification")
	spec = trace[0]["hpa"]["spec"]
	if spec.get("minReplicas") != floor or spec.get("maxReplicas") != 30:
		raise ValueError("production HPA bounds drifted")
	scale_down = spec.get("behavior", {}).get("scaleDown", {})
	if (
		scale_down.get("stabilizationWindowSeconds") != 300
		or scale_down.get("selectPolicy") != "Min"
		or {
			(item.get("type"), item.get("value"), item.get("periodSeconds"))
			for item in scale_down.get("policies", [])
		} != {("Percent", 25, 60), ("Pods", 1, 60)}
	):
		raise ValueError("production HPA scale-down stabilization drifted")
	if metric_contract(spec) != EXPECTED_METRICS:
		raise ValueError("production HPA metric targets drifted")
	if not low(trace[0], floor) or not metrics_complete(trace[0]):
		raise ValueError("qualification did not start from a healthy floor")
	scaled = [item for item in trace if item["hpa"]["status"].get("desiredReplicas", 0) > floor]
	ready_scaled = [item for item in trace if item["deployment"]["status"].get("readyReplicas", 0) > floor]
	if not scaled or not ready_scaled or not any(metrics_complete(item) for item in ready_scaled):
		raise ValueError("load did not produce observable Router scale-out")
	if not low(trace[-1], floor) or not metrics_complete(trace[-1]):
		raise ValueError("Router did not return to a healthy floor")
	return {
		"schema": SCHEMA,
		"verdict": "passed",
		"runId": load.get("runId"),
		"hpaSpecSha256": next(iter(spec_digests)),
		"samples": len(trace),
		"load": {
			"requests": counters["started"],
			"peakInFlight": counters["peakInFlight"],
		},
		"replicas": {
			"floor": floor,
			"peakDesired": max(item["hpa"]["status"].get("desiredReplicas", 0) for item in trace),
			"peakReady": max(item["deployment"]["status"].get("readyReplicas", 0) for item in trace),
			"final": trace[-1]["deployment"]["status"].get("readyReplicas", 0),
		},
		"gates": {
			"hpaSpecUnchanged": True,
			"customMetricsComplete": True,
			"scaledFromFloor": True,
			"returnedToFloor": True,
			"allRequestsSucceeded": True,
			"temporaryWorkerDeleted": True,
			"dependentStatelessCapacityReturnedToFloor": True,
		},
		"dependentStatelessCapacity": dependent,
	}


def publish(path: pathlib.Path, value: dict) -> None:
	if not path.is_absolute() or path.exists() or not path.parent.is_dir():
		raise ValueError("output must be a new absolute path with an existing parent")
	descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
	try:
		os.fchmod(descriptor, 0o644)
		with os.fdopen(descriptor, "w") as output:
			json.dump(value, output, indent=2, sort_keys=True)
			output.write("\n")
			output.flush()
			os.fsync(output.fileno())
		os.link(staged, path)
	finally:
		pathlib.Path(staged).unlink(missing_ok=True)


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--trace", required=True, type=pathlib.Path)
	parser.add_argument("--load-receipt", required=True, type=pathlib.Path)
	parser.add_argument("--dependent-capacity", required=True, type=pathlib.Path)
	parser.add_argument("--output", required=True, type=pathlib.Path)
	parser.add_argument("--floor", type=int, default=3)
	parser.add_argument("--minimum-requests", type=int, default=200)
	args = parser.parse_args()
	trace = [json.loads(line) for line in args.trace.read_text().splitlines() if line.strip()]
	load = json.loads(args.load_receipt.read_text())
	dependent = [json.loads(line) for line in args.dependent_capacity.read_text().splitlines() if line.strip()]
	value = verify(trace, load, dependent, args.floor, args.minimum_requests)
	value["load"]["loadReceiptSha256"] = "sha256:" + hashlib.sha256(args.load_receipt.read_bytes()).hexdigest()
	publish(args.output, value)
	print(json.dumps(value, sort_keys=True))


if __name__ == "__main__":
	main()
