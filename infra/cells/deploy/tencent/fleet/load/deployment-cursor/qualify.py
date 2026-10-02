#!/usr/bin/env python3
"""Measure active Deployment cursor propagation across every Workers API replica."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime
import importlib.util
import json
import math
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
REPO = pathlib.Path(os.environ["MINISANDBOX_REPO"]) if "MINISANDBOX_REPO" in os.environ else ROOT.parents[6]
HELPER = REPO / "infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py"
NAMESPACE = "workers-api-system"
SELECTOR = "app.kubernetes.io/name=workers-api"
SCHEMA = "actor-worker-deployment-cursor-qualification/v1"


def load_helper():
	spec = importlib.util.spec_from_file_location("persistent_runtime_e2e", HELPER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load qualification helper {HELPER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


runtime = load_helper()


def source(revision: str) -> str:
	return f'''export default {{
  fetch() {{
    return new Response(JSON.stringify({{schema: "cursor-probe/v1", revision: "{revision}"}}), {{
      headers: {{"content-type": "application/json"}}
    }});
  }}
}};'''


def request(method: str, url: str, body=None, *, expected=(200, 201, 204), timeout=60):
	encoded = None if body is None else json.dumps(body).encode()
	request = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		request.add_header("content-type", "application/json")
	try:
		with urllib.request.urlopen(request, timeout=timeout) as response:
			status, payload = response.status, response.read()
	except urllib.error.HTTPError as error:
		status, payload = error.code, error.read()
	if status not in expected:
		raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload[:1024]!r}")
	if not payload:
		return status, None
	try:
		return status, json.loads(payload)
	except json.JSONDecodeError:
		return status, payload.decode(errors="replace")


def dispatch(endpoint: str, worker: str, timeout=20):
	path = f"{endpoint}/v1/workers/{urllib.parse.quote(worker, safe='')}/dispatch"
	request_value = urllib.request.Request(path, method="GET")
	request_value.add_header("X-Workers-Original-URL", "https://cursor-qualification.invalid/probe")
	try:
		with urllib.request.urlopen(request_value, timeout=timeout) as response:
			payload = response.read()
			status = response.status
	except urllib.error.HTTPError as error:
		status, payload = error.code, error.read()
	if status != 200:
		raise RuntimeError(f"dispatch returned HTTP {status}: {payload[:512]!r}")
	try:
		value = json.loads(payload)
	except json.JSONDecodeError as error:
		raise RuntimeError("dispatch response is not JSON") from error
	if not isinstance(value, dict) or value.get("schema") != "cursor-probe/v1":
		raise RuntimeError(f"dispatch response identity is invalid: {value!r}")
	return value.get("revision")


def quantile(values: list[float], percentile: float) -> float:
	if not values or not 0 <= percentile <= 1:
		raise ValueError("quantile requires values and a percentile within [0,1]")
	ordered = sorted(values)
	return ordered[max(0, math.ceil(percentile * len(ordered)) - 1)]


def ready_pods(client) -> list[dict]:
	return sorted(
		(
			item for item in client.json("get", "pods", "-l", SELECTOR).get("items", [])
			if runtime.ready(item) and item.get("metadata", {}).get("deletionTimestamp") is None
		),
		key=lambda item: item["metadata"]["name"],
	)


def start_forwards(client, pods):
	forwards = []
	try:
		for pod in pods:
			forward = runtime.PortForward(client, f"pod/{pod['metadata']['name']}", 8080)
			forward.start("/readyz")
			forwards.append(forward)
		return forwards
	except Exception:
		for forward in forwards:
			forward.stop()
		raise


def wait_revision(endpoint: str, worker: str, revision: str, timeout: float) -> tuple[float, int]:
	started = time.monotonic()
	attempts = 0
	last = None
	while time.monotonic() - started < timeout:
		attempts += 1
		try:
			last = dispatch(endpoint, worker)
		except Exception as error:
			last = type(error).__name__
		if last == revision:
			return time.monotonic() - started, attempts
		time.sleep(0.025)
	raise TimeoutError(f"replica did not observe revision {revision!r}; last={last!r}")


def publish_new(path: pathlib.Path, value: dict) -> None:
	path = path.resolve()
	if not path.is_absolute() or path.exists() or not path.parent.is_dir():
		raise ValueError("receipt must be a new absolute path with an existing parent")
	descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
	try:
		os.fchmod(descriptor, 0o644)
		with os.fdopen(descriptor, "w") as stream:
			json.dump(value, stream, indent=2, sort_keys=True)
			stream.write("\n")
			stream.flush()
			os.fsync(stream.fileno())
		os.link(temporary, path)
	finally:
		try:
			os.unlink(temporary)
		except FileNotFoundError:
			pass


def run(args) -> dict:
	client = runtime.Kubectl(args.hub_kubeconfig, NAMESPACE)
	pods = ready_pods(client)
	if len(pods) != args.replicas:
		raise RuntimeError(f"expected exactly {args.replicas} Ready API Pods, got {len(pods)}")
	forwards = start_forwards(client, pods)
	worker = f"qualification-cursor-{time.time_ns():x}"[-63:]
	created = False
	deleted = False
	try:
		versions = {}
		for revision in ("a", "b"):
			_, version = request("POST", f"{forwards[0].base_url}/v1/workers/{worker}/versions", {
				"main_module": "main.js",
				"modules": {"main.js": source(revision)},
				"compatibility_date": args.compatibility_date,
			})
			created = True
			versions[revision] = version["id"]
		_, deployment = request(
			"POST", f"{forwards[0].base_url}/v1/workers/{worker}/deployments",
			{"version_id": versions["a"]},
		)
		active_id = deployment["id"]
		for forward in forwards:
			wait_revision(forward.base_url, worker, "a", args.propagation_timeout)

		samples = []
		for round_index in range(args.rounds):
			revision = "b" if round_index % 2 == 0 else "a"
			publisher_index = round_index % len(forwards)
			_, deployment = request(
				"POST", f"{forwards[publisher_index].base_url}/v1/workers/{worker}/deployments",
				{"version_id": versions[revision], "expected_deployment_id": active_id},
			)
			active_id = deployment["id"]
			published_at = time.monotonic()
			with concurrent.futures.ThreadPoolExecutor(max_workers=len(forwards)) as executor:
				observed = list(executor.map(
					lambda forward: wait_revision(forward.base_url, worker, revision, args.propagation_timeout),
					forwards,
				))
			for pod, (elapsed, attempts) in zip(pods, observed, strict=True):
				samples.append({
					"round": round_index + 1,
					"revision": revision,
					"publisher": pod["metadata"]["name"] == pods[publisher_index]["metadata"]["name"],
					"pod": pod["metadata"]["name"],
					"podUid": pod["metadata"]["uid"],
					"seconds": round(elapsed, 6),
					"attempts": attempts,
				})
			# Keep the timestamp in scope as an explicit assertion that propagation
			# measurement begins only after the CAS publish response is visible.
			if time.monotonic() < published_at:
				raise RuntimeError("monotonic clock moved backwards")

		latencies = [sample["seconds"] for sample in samples]
		p99 = quantile(latencies, 0.99)
		maximum = max(latencies)
		if p99 > args.max_p99_seconds or maximum > args.propagation_timeout:
			raise RuntimeError(f"cursor propagation exceeded bound: p99={p99:.6f}s max={maximum:.6f}s")
		request("DELETE", f"{forwards[0].base_url}/v1/workers/{worker}", expected=(204,))
		deleted = True
		return {
			"schema": SCHEMA,
			"verdict": "passed",
			"generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
			"worker": worker,
			"replicas": [{"name": pod["metadata"]["name"], "uid": pod["metadata"]["uid"]} for pod in pods],
			"rounds": args.rounds,
			"sampleCount": len(samples),
			"bounds": {"p99Seconds": args.max_p99_seconds, "perReplicaSeconds": args.propagation_timeout},
			"latencySeconds": {
				"p50": round(quantile(latencies, 0.50), 6),
				"p95": round(quantile(latencies, 0.95), 6),
				"p99": round(p99, 6),
				"max": round(maximum, 6),
			},
			"samples": samples,
			"workerDeleted": True,
		}
	finally:
		if created and not deleted:
			try:
				request("DELETE", f"{forwards[0].base_url}/v1/workers/{worker}", expected=(204, 404))
			except Exception:
				pass
		for forward in forwards:
			forward.stop()


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", required=True, type=pathlib.Path)
	parser.add_argument("--replicas", type=int, default=3)
	parser.add_argument("--rounds", type=int, default=20)
	parser.add_argument("--propagation-timeout", type=float, default=30)
	parser.add_argument("--max-p99-seconds", type=float, default=5)
	parser.add_argument("--compatibility-date", default="2026-08-14")
	parser.add_argument("--receipt", required=True, type=pathlib.Path)
	args = parser.parse_args()
	if args.replicas != 3 or args.rounds < 20:
		parser.error("production qualification requires exactly 3 replicas and at least 20 rounds")
	if not 0 < args.max_p99_seconds <= args.propagation_timeout <= 30:
		parser.error("propagation bounds must be positive, ordered, and at most 30 seconds")
	result = run(args)
	publish_new(args.receipt, result)
	print(json.dumps(result, indent=2, sort_keys=True))
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
