#!/usr/bin/env python3
"""Prove real Kubernetes stateless drain, peer continuity, and forced timeout."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.request


HERE = pathlib.Path(__file__).resolve().parent
BASE_RUNNER = HERE.parent / "workerd-persistent-code-e2e" / "run.py"
API_NAMESPACE = "workers-api-system"
STATELESS_NAMESPACE = "actor-stateless-system"
CELL = "local-runtime-a"
DEPLOYMENT = f"{CELL}-stateless-executor"
SELECTOR = f"fleet.actor.dev/cell-name={CELL},fleet.actor.dev/component=stateless-executor"
TOKEN_HEADER = "X-Rivet-Stateless-Executor-Token"


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
    return Response.json({ marker: "stateless-termination-e2e", delayMs });
  }
};
'''.strip()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-a-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--timeout", type=float, default=180)
	parser.add_argument("--receipt", type=pathlib.Path)
	return parser.parse_args()


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=120):
	encoded = None if body is None else json.dumps(body).encode()
	req = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		req.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		req.add_header(name, value)
	try:
		with urllib.request.urlopen(req, timeout=timeout) as response:
			status, payload, response_headers = response.status, response.read(), response.headers
	except urllib.error.HTTPError as error:
		status, payload, response_headers = error.code, error.read(), error.headers
	if status not in expected:
		raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}")
	if not payload:
		return status, None, response_headers
	try:
		return status, json.loads(payload), response_headers
	except json.JSONDecodeError:
		return status, payload.decode(errors="replace"), response_headers


def ready_pods(kubectl):
	return [
		item for item in kubectl.json("get", "pods", "-l", SELECTOR).get("items", [])
		if base.ready(item) and item.get("metadata", {}).get("deletionTimestamp") is None
	]


def wait_ready_pods(kubectl, count, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		pods = ready_pods(kubectl)
		last = [(item["metadata"]["name"], item["metadata"]["uid"]) for item in pods]
		if len(pods) == count:
			return pods
		time.sleep(0.25)
	raise TimeoutError(f"expected {count} ready executor Pods: {last}")


def wait_settled_pods(kubectl, count, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		items = kubectl.json("get", "pods", "-l", SELECTOR).get("items", [])
		last = [
			{
				"name": item["metadata"]["name"],
				"uid": item["metadata"]["uid"],
				"ready": base.ready(item),
				"deleting": item["metadata"].get("deletionTimestamp") is not None,
			}
			for item in items
		]
		if len(items) == count and all(item["ready"] and not item["deleting"] for item in last):
			return items
		time.sleep(0.25)
	raise TimeoutError(f"executor Deployment did not restore a clean Pod set: {last}")


def wait_metric(endpoint, name, predicate, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			with urllib.request.urlopen(endpoint + "/metrics", timeout=2) as response:
				for line in response.read().decode().splitlines():
					if line.startswith(name + " "):
						last = float(line.split()[1])
						if predicate(last):
							return last
		except Exception:
			pass
		time.sleep(0.1)
	raise TimeoutError(f"metric {name} did not converge, last={last}")


def wait_not_ready(endpoint, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			last, _, _ = request("GET", endpoint + "/readyz", expected=(204, 503), timeout=2)
			if last == 503:
				return
		except Exception:
			# The exact Pod endpoint disappearing is also a valid end state, but
			# readiness must normally flip before the grace period expires.
			last = "unreachable"
		time.sleep(0.1)
	raise TimeoutError(f"terminating executor did not leave readiness: {last}")


def wait_uid_gone(kubectl, uid, timeout):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		items = kubectl.json("get", "pods", "-l", SELECTOR).get("items", [])
		if all(item["metadata"]["uid"] != uid for item in items):
			return
		time.sleep(0.25)
	raise TimeoutError(f"terminating executor UID remained past its grace period: {uid}")


def executor_path(worker, version):
	return f"/internal/v1/workers/{worker}/versions/{version}/dispatch"


def direct_dispatch(endpoint, token, worker, version, delay_ms, timeout, expected=(200,)):
	return request(
		"GET", endpoint + executor_path(worker, version),
		headers={
			TOKEN_HEADER: token,
			"X-Rivet-Original-URL": f"https://termination.example/test?delay_ms={delay_ms}",
		},
		timeout=timeout,
		expected=expected,
	)


def publish_new(path, value):
	path = path.resolve()
	if not path.is_absolute() or path.exists():
		raise ValueError("--receipt must be a new absolute path")
	path.parent.mkdir(parents=True, exist_ok=True)
	descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
	try:
		os.fchmod(descriptor, 0o644)
		with os.fdopen(descriptor, "w") as stream:
			json.dump(value, stream, indent=2, sort_keys=True)
			stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
		os.link(temporary, path)
	finally:
		try: os.unlink(temporary)
		except FileNotFoundError: pass


def main():
	args = parse_args()
	hub = base.Kubectl(args.hub_kubeconfig, API_NAMESPACE)
	runtime = base.Kubectl(args.runtime_a_kubeconfig, STATELESS_NAMESPACE)
	api_forward = base.PortForward(hub, "service/workers-api", 8080)
	service_forward = base.PortForward(runtime, f"service/{DEPLOYMENT}", 19084)
	api_forward.start("/readyz")
	service_forward.start("/readyz")
	worker = f"stateless-termination-{time.time_ns():x}"[-63:]
	api = api_forward.base_url + "/v1"
	original_replicas = runtime.json("get", "deployment", DEPLOYMENT)["spec"]["replicas"]
	secret = runtime.json("get", "secret", f"{CELL}-stateless-auth")
	token = base64.b64decode(secret["data"]["executor-token"]).decode()
	forwards = []
	result = None
	try:
		_, version, _ = request("POST", f"{api}/workers/{worker}/versions", {
			"main_module": "main.js",
			"modules": {"main.js": WORKER_SOURCE},
			"compatibility_date": "2026-08-14",
		})
		request("POST", f"{api}/workers/{worker}/deployments", {"version_id": version["id"]})
		_, probe, _ = request(
			"GET", f"{api}/workers/{worker}/dispatch",
			headers={"X-Workers-Original-URL": "https://termination.example/test?delay_ms=0"},
		)
		if probe != {"marker": "stateless-termination-e2e", "delayMs": 0}:
			raise RuntimeError(f"delay Worker probe failed: {probe}")

		runtime.run("scale", "deployment", DEPLOYMENT, "--replicas=2")
		pods = wait_ready_pods(runtime, 2, args.timeout)

		# Graceful case: the old Pod leaves readiness, its response completes,
		# and the Service can concurrently route new work to the healthy peer.
		graceful_pod = pods[0]
		graceful_forward = base.PortForward(runtime, f"pod/{graceful_pod['metadata']['name']}", 19084)
		forwards.append(graceful_forward); graceful_forward.start("/readyz")
		with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
			future = pool.submit(
				direct_dispatch, graceful_forward.base_url, token, worker, version["id"], 4000, 30,
			)
			wait_metric(graceful_forward.base_url, "rivet_stateless_in_flight", lambda value: value == 1, 10)
			started = time.monotonic()
			runtime.run("delete", "pod", graceful_pod["metadata"]["name"], "--wait=false")
			wait_not_ready(graceful_forward.base_url, 10)
			status, draining, headers = direct_dispatch(
				graceful_forward.base_url, token, worker, version["id"], 0, 5, (503,),
			)
			if status != 503 or draining.get("code") != "executor_draining" or headers.get("Retry-After") != "1":
				raise RuntimeError(f"terminating executor accepted new work: {status} {draining}")
			# kubectl port-forward against a Service selects one endpoint for the
			# lifetime of the forwarding process. A real new client connection is
			# re-resolved after readiness removal, so reconnect before asserting
			# peer continuity.
			service_forward.stop(); service_forward.start("/readyz")
			_, peer, _ = direct_dispatch(
				service_forward.base_url, token, worker, version["id"], 0, 15,
			)
			if peer != {"marker": "stateless-termination-e2e", "delayMs": 0}:
				raise RuntimeError(f"healthy peer did not serve during drain: {peer}")
			_, completed, _ = future.result(timeout=30)
			if completed != {"marker": "stateless-termination-e2e", "delayMs": 4000}:
				raise RuntimeError(f"graceful response changed: {completed}")
			graceful_elapsed = time.monotonic() - started
		wait_uid_gone(runtime, graceful_pod["metadata"]["uid"], args.timeout)
		pods = wait_ready_pods(runtime, 2, args.timeout)

		# Forced case: the request exceeds the production 45 second drain
		# budget. The timeout is observable before Kubernetes terminates the
		# executor, and the client receives an indeterminate transport failure.
		forced_pod = pods[0]
		forced_forward = base.PortForward(runtime, f"pod/{forced_pod['metadata']['name']}", 19084)
		forwards.append(forced_forward); forced_forward.start("/readyz")
		before_timeout = wait_metric(
			forced_forward.base_url, "rivet_stateless_drain_timeouts_total", lambda value: value >= 0, 5,
		)
		with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
			future = pool.submit(
				direct_dispatch, forced_forward.base_url, token, worker, version["id"], 75000, 100,
				(200, 502),
			)
			wait_metric(forced_forward.base_url, "rivet_stateless_in_flight", lambda value: value == 1, 10)
			forced_started = time.monotonic()
			runtime.run("delete", "pod", forced_pod["metadata"]["name"], "--wait=false")
			wait_not_ready(forced_forward.base_url, 10)
			observed_timeout = wait_metric(
				forced_forward.base_url,
				"rivet_stateless_drain_timeouts_total",
				lambda value: value >= before_timeout + 1,
				55,
			)
			try:
				forced_status, forced_body, _ = future.result(timeout=25)
			except concurrent.futures.TimeoutError as error:
				if not future.done():
					raise RuntimeError("terminating Pod did not interrupt the request within its grace budget") from error
				forced_result = {"kind": "transport_error", "error": type(error).__name__}
			except Exception as error:
				forced_result = {"kind": "transport_error", "error": type(error).__name__}
			else:
				if forced_status != 502 or forced_body.get("code") != "indeterminate_result":
					raise RuntimeError(
					f"request longer than the Pod grace budget returned an unsafe result: "
					f"{forced_status} {forced_body}"
				)
				forced_result = {"kind": "indeterminate_result", "status": forced_status}
			forced_elapsed = time.monotonic() - forced_started
		wait_uid_gone(runtime, forced_pod["metadata"]["uid"], args.timeout)
		new_pods = wait_ready_pods(runtime, 2, args.timeout)

		result = {
			"schema": "stateless-termination-e2e/v1",
			"verdict": "passed",
			"worker": worker,
			"version": version["id"],
			"graceful": {
				"podUid": graceful_pod["metadata"]["uid"],
				"readinessRemoved": True,
				"newWorkReachedPeer": True,
				"inFlightResponseCompleted": True,
				"elapsedSeconds": round(graceful_elapsed, 3),
			},
			"forcedTimeout": {
				"podUid": forced_pod["metadata"]["uid"],
				"drainTimeoutDelta": observed_timeout - before_timeout,
				"inFlightResponseInterrupted": True,
				"result": forced_result,
				"elapsedSeconds": round(forced_elapsed, 3),
			},
			"replacementUids": sorted(item["metadata"]["uid"] for item in new_pods),
		}
	finally:
		for forward in forwards:
			forward.stop()
		try:
			runtime.run("scale", "deployment", DEPLOYMENT, f"--replicas={original_replicas}")
			wait_settled_pods(runtime, original_replicas, args.timeout)
		finally:
			try: request("DELETE", f"{api}/workers/{worker}", expected=(204, 404, 409))
			except Exception: pass
			service_forward.stop(); api_forward.stop()
	if result is None:
		raise RuntimeError("stateless termination qualification produced no result")
	if args.receipt:
		publish_new(args.receipt, result)
	print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
	main()
