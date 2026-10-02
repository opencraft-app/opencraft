#!/usr/bin/env python3
"""Record the production Workers API HPA loop without mutating it."""

from __future__ import annotations

import argparse
import datetime
import json
import os
import pathlib
import subprocess
import time


NAMESPACE = "workers-api-system"
METRICS = (
	"workers_api_routing_requests_per_second",
	"workers_api_routing_requests_in_flight",
)


def kubectl(kubeconfig: pathlib.Path, *args: str) -> dict:
	value = subprocess.run(
		("kubectl", "--kubeconfig", str(kubeconfig), *args, "-o", "json"),
		check=True, capture_output=True, text=True,
	)
	return json.loads(value.stdout)


def kubectl_raw(kubeconfig: pathlib.Path, path: str) -> dict:
	value = subprocess.run(
		("kubectl", "--kubeconfig", str(kubeconfig), "get", "--raw", path),
		check=True, capture_output=True, text=True,
	)
	return json.loads(value.stdout)


def sample(kubeconfig: pathlib.Path) -> dict:
	hpa = kubectl(kubeconfig, "-n", NAMESPACE, "get", "hpa", "workers-api")
	deployment = kubectl(kubeconfig, "-n", NAMESPACE, "get", "deployment", "workers-api")
	pods = kubectl(
		kubeconfig, "-n", NAMESPACE, "get", "pods", "-l", "app.kubernetes.io/name=workers-api",
	)
	metrics = {}
	for name in METRICS:
		value = kubectl_raw(
			kubeconfig,
			f"/apis/custom.metrics.k8s.io/v1beta1/namespaces/{NAMESPACE}/pods/*/{name}",
		)
		metrics[name] = {
			item["describedObject"]["name"]: item["value"] for item in value.get("items", [])
		}
	return {
		"observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
		"hpa": {"spec": hpa["spec"], "status": hpa.get("status", {})},
		"deployment": {
			"specReplicas": deployment["spec"].get("replicas", 0),
			"status": deployment.get("status", {}),
		},
		"pods": sorted((
			{
				"name": pod["metadata"]["name"], "uid": pod["metadata"]["uid"],
				"node": pod.get("spec", {}).get("nodeName"),
				"ready": any(
					condition.get("type") == "Ready" and condition.get("status") == "True"
					for condition in pod.get("status", {}).get("conditions", [])
				),
			} for pod in pods.get("items", [])
		), key=lambda item: item["name"]),
		"customMetrics": metrics,
	}


def parse_args() -> argparse.Namespace:
	parser = argparse.ArgumentParser()
	parser.add_argument("--kubeconfig", required=True, type=pathlib.Path)
	parser.add_argument("--output", required=True, type=pathlib.Path)
	parser.add_argument("--seconds", type=int, default=3600)
	parser.add_argument("--interval", type=float, default=5)
	return parser.parse_args()


def main() -> None:
	args = parse_args()
	if not args.kubeconfig.is_file() or args.kubeconfig.is_symlink():
		raise ValueError("kubeconfig must be a regular non-symlink file")
	if not args.output.is_absolute() or args.output.exists() or not args.output.parent.is_dir():
		raise ValueError("output must be a new absolute path with an existing parent")
	if args.seconds < 1 or args.interval <= 0:
		raise ValueError("observation duration and interval must be positive")
	descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
	deadline = time.monotonic() + args.seconds
	with os.fdopen(descriptor, "w") as output:
		while time.monotonic() < deadline:
			began = time.monotonic()
			output.write(json.dumps(sample(args.kubeconfig), sort_keys=True) + "\n")
			output.flush()
			os.fsync(output.fileno())
			time.sleep(max(0, args.interval - (time.monotonic() - began)))


if __name__ == "__main__":
	main()
