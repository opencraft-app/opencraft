#!/usr/bin/env python3
"""Prove Router load -> custom metric -> HPA scale up -> safe scale down."""

import argparse
import concurrent.futures
import copy
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.request
import uuid


HERE = pathlib.Path(__file__).resolve().parent
BASE_RUNNER = HERE.parent / "workerd-persistent-code-e2e" / "run.py"
NAMESPACE = "workers-api-system"
DEPLOYMENT = "workers-api"
HPA = "workers-api"
SELECTOR = "app.kubernetes.io/name=workers-api"
CUSTOM_METRIC = "workers_api_routing_requests_in_flight"


def load_base_runner():
	spec = importlib.util.spec_from_file_location("workerd_persistent_code_e2e", BASE_RUNNER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {BASE_RUNNER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_base_runner()


WORKER_SOURCE = r'''
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const delayMs = Number(url.searchParams.get("delay_ms") ?? "0");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 90000) {
      return new Response("invalid delay", { status: 400 });
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return Response.json({ marker: "workers-api-autoscaling-e2e", delayMs });
  }
};
'''.strip()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", type=pathlib.Path, default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--load-requests", type=int, default=12, help="requests per wave")
	parser.add_argument("--load-waves", type=int, default=4)
	parser.add_argument("--wave-interval-seconds", type=float, default=8)
	parser.add_argument("--delay-seconds", type=int, default=20)
	parser.add_argument("--metric-target", type=int, default=2)
	parser.add_argument("--timeout", type=float, default=240)
	parser.add_argument("--receipt", type=pathlib.Path)
	return parser.parse_args()


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=120):
	encoded = None if body is None else json.dumps(body).encode()
	value = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		value.add_header("content-type", "application/json")
	for name, header_value in (headers or {}).items():
		value.add_header(name, header_value)
	try:
		with urllib.request.urlopen(value, timeout=timeout) as response:
			status, payload = response.status, response.read()
	except urllib.error.HTTPError as error:
		status, payload = error.code, error.read()
	if status not in expected:
		raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}")
	if not payload:
		return status, None
	try:
		return status, json.loads(payload)
	except json.JSONDecodeError:
		return status, payload.decode(errors="replace")


def publish_new(path, value):
	path = path.resolve()
	if not path.is_absolute() or path.exists():
		raise ValueError("--receipt must be a new absolute path")
	path.parent.mkdir(parents=True, exist_ok=True)
	descriptor, staged = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
	try:
		os.fchmod(descriptor, 0o644)
		with os.fdopen(descriptor, "w") as stream:
			json.dump(value, stream, indent=2, sort_keys=True)
			stream.write("\n")
			stream.flush()
			os.fsync(stream.fileno())
		os.link(staged, path)
	finally:
		pathlib.Path(staged).unlink(missing_ok=True)


def quantity(value):
	if value.endswith("m"):
		return float(value[:-1]) / 1000
	return float(value)


class Harness:
	def __init__(self, args):
		self.args = args
		self.hub = base.Kubectl(args.hub_kubeconfig, NAMESPACE)
		self.forward = None
		self.worker = f"router-scale-{uuid.uuid4().hex[:10]}"
		self.original_hpa_spec = None
		self.hpa_patched = False
		self.worker_created = False
		self.evidence = {
			"schema": "actor-workers-api-autoscaling-e2e/v1",
			"verdict": "running",
			"loadRequests": args.load_requests * args.load_waves,
			"loadRequestsPerWave": args.load_requests,
			"loadWaves": args.load_waves,
			"waveIntervalSeconds": args.wave_interval_seconds,
			"delaySeconds": args.delay_seconds,
			"metricTargetPerPod": args.metric_target,
			"phases": {},
		}

	def ready_pods(self):
		return [
			item for item in self.hub.json("get", "pods", "-l", SELECTOR).get("items", [])
			if base.ready(item) and item.get("metadata", {}).get("deletionTimestamp") is None
		]

	def pod_evidence(self):
		return sorted(({
			"name": item["metadata"]["name"],
			"uid": item["metadata"]["uid"],
			"node": item["spec"]["nodeName"],
		} for item in self.ready_pods()), key=lambda item: item["name"])

	def custom_metrics(self):
		path = (
			"/apis/custom.metrics.k8s.io/v1beta1/namespaces/"
			f"{NAMESPACE}/pods/*/{CUSTOM_METRIC}"
		)
		value = json.loads(self.hub.run("get", "--raw", path))
		if value.get("kind") != "MetricValueList":
			raise RuntimeError(f"custom metric response is invalid: {value}")
		return {
			item["describedObject"]["name"]: quantity(item["value"])
			for item in value.get("items", [])
		}

	def wait_state(self, replicas):
		deadline = time.monotonic() + self.args.timeout
		last = None
		while time.monotonic() < deadline:
			hpa = self.hub.json("get", "horizontalpodautoscaler", HPA)
			deployment = self.hub.json("get", "deployment", DEPLOYMENT)
			metrics = self.custom_metrics()
			last = {"hpa": hpa.get("status", {}), "deployment": deployment.get("status", {}), "metrics": metrics}
			status = deployment.get("status", {})
			if (
				deployment.get("spec", {}).get("replicas") == replicas
				and status.get("readyReplicas", 0) == replicas
				and status.get("updatedReplicas", 0) == replicas
				and hpa.get("status", {}).get("currentReplicas") == replicas
				and hpa.get("status", {}).get("desiredReplicas") == replicas
			):
				return hpa, metrics
			time.sleep(2)
		raise TimeoutError(f"Workers API did not converge to {replicas} replicas: {last}")

	def wait_scale_up(self):
		deadline = time.monotonic() + self.args.timeout
		intent = None
		last = None
		while time.monotonic() < deadline:
			hpa = self.hub.json("get", "horizontalpodautoscaler", HPA)
			deployment = self.hub.json("get", "deployment", DEPLOYMENT)
			metrics = self.custom_metrics()
			last = {"hpa": hpa.get("status", {}), "deployment": deployment.get("status", {}), "metrics": metrics}
			if (
				hpa.get("status", {}).get("desiredReplicas") == 4
				and deployment.get("spec", {}).get("replicas") == 4
				and sum(metrics.values()) >= self.args.metric_target * 3
			):
				intent = {"hpa": copy.deepcopy(hpa.get("status", {})), "metrics": metrics}
			status = deployment.get("status", {})
			if (
				intent is not None
				and status.get("readyReplicas", 0) == 4
				and status.get("updatedReplicas", 0) == 4
				and status.get("availableReplicas", 0) == 4
			):
				return intent["hpa"], intent["metrics"]
			time.sleep(1)
		raise TimeoutError(f"Workers API did not complete its scale-up intent: {last}")

	def preflight(self):
		if not self.args.hub_kubeconfig.is_file() or self.args.hub_kubeconfig.is_symlink():
			raise ValueError("Hub kubeconfig must be a non-symlink regular file")
		if (
			self.args.load_requests < 8
			or not 2 <= self.args.load_waves <= 8
			or not 1 <= self.args.metric_target <= 16
			or self.args.delay_seconds >= 25
		):
			raise ValueError("load and metric target are outside the bounded qualification range")
		api_service = self.hub.json("get", "apiservice", "v1beta1.custom.metrics.k8s.io")
		if not any(
			item.get("type") == "Available" and item.get("status") == "True"
			for item in api_service.get("status", {}).get("conditions", [])
		):
			raise RuntimeError("custom.metrics.k8s.io is unavailable")
		hpa, metrics = self.wait_state(3)
		self.original_hpa_spec = copy.deepcopy(
			self.hub.json("get", "horizontalpodautoscaler", HPA)["spec"]
		)
		self.evidence["phases"]["baseline"] = {
			"pods": self.pod_evidence(), "metrics": metrics, "hpa": hpa.get("status", {}),
		}

	def patch_hpa(self):
		test_spec = copy.deepcopy(self.original_hpa_spec)
		test_spec.update({
			"minReplicas": 3,
			"maxReplicas": 4,
			"behavior": {
				"scaleUp": {
					"stabilizationWindowSeconds": 0,
					"selectPolicy": "Max",
					"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
				},
				"scaleDown": {
					"stabilizationWindowSeconds": 15,
					"selectPolicy": "Max",
					"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
				},
			},
			"metrics": [{
				"type": "Pods",
				"pods": {
					"metric": {"name": CUSTOM_METRIC},
					"target": {"type": "AverageValue", "averageValue": str(self.args.metric_target)},
				},
			}],
		})
		self.hub.run(
			"patch", "horizontalpodautoscaler", HPA, "--type=merge",
			"-p", json.dumps({"spec": test_spec}),
		)
		self.hpa_patched = True

	def deploy_worker(self):
		self.forward = base.PortForward(self.hub, "service/workers-api", 8080)
		self.forward.start("/readyz")
		_, version = request(
			"POST", f"{self.forward.base_url}/v1/workers/{self.worker}/versions",
			{
				"main_module": "main.js", "modules": {"main.js": WORKER_SOURCE},
				"compatibility_date": "2026-08-14", "durable_objects": {},
			},
		)
		request(
			"POST", f"{self.forward.base_url}/v1/workers/{self.worker}/deployments",
			{"version_id": version["id"]},
		)
		self.worker_created = True

	def one_fetch(self):
		original = f"https://autoscaling.test/hold?delay_ms={self.args.delay_seconds * 1000}"
		_, payload = request(
			"GET", f"{self.forward.base_url}/v1/workers/{self.worker}/dispatch",
			headers={"X-Workers-Original-URL": original},
			timeout=self.args.delay_seconds + 60,
		)
		if payload != {"marker": "workers-api-autoscaling-e2e", "delayMs": self.args.delay_seconds * 1000}:
			raise RuntimeError(f"streamed Worker response differs: {payload}")
		return payload

	def run(self):
		self.preflight()
		self.patch_hpa()
		self.deploy_worker()
		total_requests = self.args.load_requests * self.args.load_waves
		with concurrent.futures.ThreadPoolExecutor(max_workers=total_requests) as executor:
			futures = []
			for wave in range(self.args.load_waves):
				futures.extend(executor.submit(self.one_fetch) for _ in range(self.args.load_requests))
				if wave + 1 < self.args.load_waves:
					time.sleep(self.args.wave_interval_seconds)
			hpa, metrics = self.wait_scale_up()
			self.evidence["phases"]["scaleUp"] = {
				"pods": self.pod_evidence(), "metrics": metrics, "hpa": hpa,
			}
			results = [future.result() for future in futures]
		if len(results) != total_requests:
			raise RuntimeError("not every held request completed")
		hpa, metrics = self.wait_state(3)
		self.evidence["phases"]["scaleDown"] = {
			"pods": self.pod_evidence(), "metrics": metrics, "hpa": hpa.get("status", {}),
			"successfulRequests": len(results),
		}
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		errors = []
		if self.hpa_patched and self.original_hpa_spec is not None:
			try:
				cleanup_spec = copy.deepcopy(self.original_hpa_spec)
				cleanup_spec["minReplicas"] = 3
				cleanup_spec["maxReplicas"] = 3
				cleanup_spec["behavior"]["scaleDown"] = {
					"stabilizationWindowSeconds": 0,
					"selectPolicy": "Max",
					"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
				}
				self.hub.run(
					"patch", "horizontalpodautoscaler", HPA, "--type=merge",
					"-p", json.dumps({"spec": cleanup_spec}),
				)
				deadline = time.monotonic() + 120
				while time.monotonic() < deadline:
					deployment = self.hub.json("get", "deployment", DEPLOYMENT)
					status = deployment.get("status", {})
					if deployment.get("spec", {}).get("replicas") == 3 and status.get("readyReplicas") == 3:
						break
					time.sleep(2)
				else:
					raise TimeoutError("cleanup HPA did not restore the three-replica baseline")
				self.hub.run(
					"patch", "horizontalpodautoscaler", HPA, "--type=merge",
					"-p", json.dumps({"spec": self.original_hpa_spec}),
				)
			except Exception as error:
				errors.append(f"restore HPA: {error}")
		if self.worker_created and self.forward is not None:
			try:
				request("DELETE", f"{self.forward.base_url}/v1/workers/{self.worker}", expected=(204,))
			except Exception as error:
				errors.append(f"delete Worker: {error}")
		if self.forward is not None:
			self.forward.stop()
		if errors:
			raise RuntimeError("; ".join(errors))


def main():
	args = parse_args()
	harness = Harness(args)
	error = None
	try:
		harness.run()
	except Exception as caught:
		error = caught
	finally:
		try:
			harness.cleanup()
		except Exception as cleanup_error:
			if error is None:
				error = cleanup_error
	if error is not None:
		raise error
	if args.receipt:
		publish_new(args.receipt, harness.evidence)
	print(json.dumps(harness.evidence, indent=2, sort_keys=True))


if __name__ == "__main__":
	main()
