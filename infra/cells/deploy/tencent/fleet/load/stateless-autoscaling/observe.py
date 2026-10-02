#!/usr/bin/env python3
"""Capture bounded TKE stateless capacity state without mutating the cluster."""

import argparse
import datetime
import json
import os
import pathlib
import re
import subprocess
import time


NAMESPACE = "actor-stateless-system"
CELL = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
MACHINE_SET = re.compile(r"^np-[a-z0-9]{8}$")
STATE_ANNOTATION = "fleet.actor.dev/stateless-admission-state"


def ready(value):
	return any(item.get("type") == "Ready" and item.get("status") == "True" for item in value.get("status", {}).get("conditions", []))


def admission_state(node):
	raw = node.get("metadata", {}).get("annotations", {}).get(STATE_ANNOTATION, "")
	try:
		state = json.loads(raw)
	except (TypeError, json.JSONDecodeError):
		return {}
	return state if isinstance(state, dict) else {}


def container_image(deployment, name):
	for container in deployment.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
		if container.get("name") == name:
			return container.get("image")
	return None


def selected_machine_set(deployment):
	value = deployment.get("metadata", {}).get("annotations", {}).get(
		"fleet.actor.dev/stateless-machine-set"
	)
	if not isinstance(value, str) or not MACHINE_SET.fullmatch(value):
		raise ValueError("stateless Deployment must record one official Native NodePool")
	return value


def kubectl(kubeconfig, *arguments):
	result = subprocess.run(
		["kubectl", "--kubeconfig", str(kubeconfig), "--request-timeout=10s", *arguments, "-o", "json"],
		check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15,
	)
	if result.returncode:
		raise RuntimeError(result.stderr.strip()[:512] or f"kubectl exited {result.returncode}")
	return json.loads(result.stdout)


def collect(cell, kubeconfig):
	name = f"{cell}-stateless-executor"
	selector = f"fleet.actor.dev/cell-name={cell},fleet.actor.dev/component=stateless-executor"
	try:
		hpa = kubectl(kubeconfig, "-n", NAMESPACE, "get", "hpa", name)
		deployment = kubectl(kubeconfig, "-n", NAMESPACE, "get", "deployment", name)
		machine_set = selected_machine_set(deployment)
		pods = kubectl(kubeconfig, "-n", NAMESPACE, "get", "pods", "-l", selector)
		machine = kubectl(kubeconfig, "get", "machineset", machine_set)
		nodes = kubectl(kubeconfig, "get", "nodes", "-l", f"node.tke.cloud.tencent.com/machineset={machine_set}")
		runtime_image = container_image(deployment, "workerd")
		runtime_digest = deployment.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {}).get("fleet.actor.dev/runtime-digest")
		observed_nodes = []
		for item in nodes.get("items", []):
			state = admission_state(item)
			identity = state.get("identity", {}) if isinstance(state.get("identity"), dict) else {}
			observed_nodes.append({
				"name": item["metadata"]["name"], "uid": item["metadata"].get("uid"),
				"ready": ready(item),
				"admitted": item["metadata"].get("labels", {}).get("fleet.actor.dev/stateless-admitted") == "true",
				"admissionPhase": state.get("phase"), "runtimeImage": identity.get("runtime_image"),
				"profileDigest": identity.get("profile_digest"),
				"taints": [taint.get("key") for taint in item["spec"].get("taints", [])],
			})
		return {
			"cell": cell, "errors": [],
			"hpa": {
				"uid": hpa["metadata"].get("uid"), "generation": hpa["metadata"].get("generation"),
				"min": hpa["spec"].get("minReplicas"), "max": hpa["spec"].get("maxReplicas"),
				"current": hpa.get("status", {}).get("currentReplicas", 0),
				"desired": hpa.get("status", {}).get("desiredReplicas", 0),
			},
			"deployment": {
				"uid": deployment["metadata"].get("uid"), "generation": deployment["metadata"].get("generation"),
				"runtimeImage": runtime_image, "runtimeDigest": runtime_digest,
				"desired": deployment["spec"].get("replicas", 0),
				"ready": deployment.get("status", {}).get("readyReplicas", 0),
				"available": deployment.get("status", {}).get("availableReplicas", 0),
				"observedGeneration": deployment.get("status", {}).get("observedGeneration", 0),
			},
			"machineSet": {
				"name": machine_set, "uid": machine["metadata"].get("uid"),
				"desired": machine["spec"].get("replicas", 0),
				"min": machine["spec"].get("scaling", {}).get("minReplicas"),
				"max": machine["spec"].get("scaling", {}).get("maxReplicas"),
				"current": machine.get("status", {}).get("replicas", 0),
				"ready": machine.get("status", {}).get("readyReplicas", 0),
			},
			"pods": [{
				"name": item["metadata"]["name"], "uid": item["metadata"].get("uid"),
				"node": item["spec"].get("nodeName"), "phase": item.get("status", {}).get("phase"),
				"ready": ready(item), "deleting": bool(item["metadata"].get("deletionTimestamp")),
			} for item in pods.get("items", [])],
			"nodes": observed_nodes,
		}
	except Exception as error:  # evidence must preserve transient observation failures
		return {"cell": cell, "errors": [str(error)[:512]]}


def parse_cell(value):
	name, separator, raw_path = value.partition("=")
	path = pathlib.Path(raw_path)
	if not separator or not CELL.fullmatch(name) or not path.is_absolute() or not path.is_file():
		raise argparse.ArgumentTypeError("cell must be NAME=/absolute/existing/kubeconfig")
	return name, path


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--cell", action="append", type=parse_cell, required=True)
	parser.add_argument("--output", type=pathlib.Path, required=True)
	parser.add_argument("--seconds", type=int, default=10_800)
	parser.add_argument("--interval", type=int, default=15)
	args = parser.parse_args()
	if len(args.cell) != 2 or len({name for name, _ in args.cell}) != 2:
		parser.error("exactly two distinct Cells are required")
	if not args.output.is_absolute() or args.output.exists() or args.seconds < 1 or args.interval < 5:
		parser.error("output must be a new absolute path; seconds/interval are invalid")
	args.output.parent.mkdir(parents=True, exist_ok=True)
	descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
	deadline = time.monotonic() + args.seconds
	with os.fdopen(descriptor, "w", buffering=1) as stream:
		while True:
			began = time.monotonic()
			sample = {
				"schema": "actor-stateless-autoscaling-sample/v1",
				"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
				"cells": [collect(name, path) for name, path in args.cell],
			}
			stream.write(json.dumps(sample, separators=(",", ":")) + "\n")
			stream.flush()
			os.fsync(stream.fileno())
			if time.monotonic() >= deadline:
				break
			time.sleep(max(0, min(args.interval, deadline - time.monotonic()) - (time.monotonic() - began)))


if __name__ == "__main__":
	main()
