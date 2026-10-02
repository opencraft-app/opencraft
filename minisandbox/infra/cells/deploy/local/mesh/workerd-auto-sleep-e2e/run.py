#!/usr/bin/env python3
"""Prove natural idle sleep releases Host capacity and preserves Durable Object state."""

import argparse
import importlib.util
import json
import os
import pathlib
import time
import urllib.parse


E2E_DIR = pathlib.Path(__file__).resolve().parent
MESH_DIR = E2E_DIR.parent
REPO_ROOT = E2E_DIR.parents[5]
BASE_RUNNER = MESH_DIR / "workerd-persistent-code-e2e" / "run.py"
MINIFLARE_RUNNER = MESH_DIR / "workerd-miniflare-counter-e2e" / "run.py"
ACTOR_NAMESPACE = "default"
KUBE_NAMESPACE = "actor-fdb-cell-system"
WORKERS_API_NAMESPACE = "workers-api-system"


def load_module(name, path):
	spec = importlib.util.spec_from_file_location(name, path)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {path}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_module("workerd_persistent_code_e2e", BASE_RUNNER)
miniflare = load_module("workerd_miniflare_counter_e2e", MINIFLARE_RUNNER)


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--api-endpoint", help="complete public Workers API /v1 URL")
	parser.add_argument("--timeout", type=float, default=90)
	return parser.parse_args()


def host_pod(runtime, cell):
	pods = runtime.json(
		"get",
		"pods",
		"-l",
		f"fleet.actor.dev/cell-name={cell},fleet.actor.dev/component=workerd-host",
	).get("items", [])
	ready = [item for item in pods if base.ready(item)]
	if len(ready) != 1:
		raise RuntimeError(f"expected one Ready workerd Host, got {len(ready)}")
	return ready[0]["metadata"]["name"]


def host_stats(runtime, pod):
	output = runtime.run(
		"exec",
		pod,
		"-c",
		"workerd-host",
		"--",
		"bash",
		"-c",
		'curl --fail --silent -H "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN" '
		"http://127.0.0.1:19083/v1/sqlite/stats",
	)
	return json.loads(output)


def wait_for_stats(runtime, pod, expected, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		last = host_stats(runtime, pod)
		if (
			last.get("host_active_actors") == expected.get("host_active_actors")
			and last.get("bridge_active_actors") == expected.get("bridge_active_actors")
		):
			return last
		time.sleep(0.25)
	raise TimeoutError(f"Host registries did not return to baseline {expected}: {last}")


def main():
	args = parse_args()
	module_path = REPO_ROOT / "runtimes/workerd/miniflare/dist/index.js"
	if not module_path.is_file():
		raise RuntimeError(f"Miniflare build is missing: {module_path}")
	runtime = base.Kubectl(args.runtime_kubeconfig, KUBE_NAMESPACE)
	api_forward = None
	if args.api_endpoint:
		api_endpoint = args.api_endpoint.rstrip("/")
		if not api_endpoint.endswith("/v1"):
			raise RuntimeError("--api-endpoint must be the complete public /v1 URL")
	else:
		hub = base.Kubectl(args.hub_kubeconfig, WORKERS_API_NAMESPACE)
		api_forward = base.PortForward(hub, "service/workers-api", 8080)
		api_endpoint = None
	engine_forward = base.PortForward(runtime, f"service/{args.cell}-engine", 6420)
	worker = miniflare.worker_for_cell(args.cell)
	object_name = f"auto-sleep-{time.time_ns():x}"
	actor_id = None
	object_deleted = False
	try:
		if api_forward is not None:
			api_forward.start("/readyz")
			api_endpoint = f"{api_forward.base_url}/v1"
		engine_forward.start("/health")
		pod = host_pod(runtime, args.cell)
		baseline = host_stats(runtime, pod)

		first = miniflare.phase(module_path, api_endpoint, worker, object_name, 1)
		query = urllib.parse.urlencode(
			{
				"namespace": ACTOR_NAMESPACE,
				"name": first["actor_name"],
				"key": first["object_id"],
			}
		)
		actors = base.request_json("GET", f"{engine_forward.base_url}/actors?{query}")["actors"]
		if len(actors) != 1:
			raise RuntimeError(f"expected one Counter Actor, got {actors}")
		actor_id = actors[0]["actor_id"]
		first_generation = int(first["generation"])

		first_sleep = base.wait_for_sleep(engine_forward.base_url, actor_id, args.timeout)
		first_quiescent = wait_for_stats(runtime, pod, baseline, args.timeout)

		second = miniflare.phase(module_path, api_endpoint, worker, object_name, 2)
		second_generation = int(second["generation"])
		if second_generation <= first_generation:
			raise RuntimeError(
				f"wake did not advance generation: {first_generation} -> {second_generation}"
			)
		second_sleep = base.wait_for_sleep(engine_forward.base_url, actor_id, args.timeout)
		second_quiescent = wait_for_stats(runtime, pod, baseline, args.timeout)

		deleted = miniflare.delete_phase(module_path, api_endpoint, worker, object_name)
		object_deleted = deleted["object_deleted"]
		if not object_deleted:
			raise RuntimeError(f"object deletion failed: {deleted}")
		print(
			json.dumps(
				{
					"schema": "rivet-workerd-auto-sleep-e2e/v1",
					"cell": args.cell,
					"actor_id": actor_id,
					"object_id": first["object_id"],
					"counter_values": [first["value"], second["value"]],
					"generations": [first_generation, second_generation],
					"sleep_ts": [first_sleep["sleep_ts"], second_sleep["sleep_ts"]],
					"baseline": baseline,
					"quiescent": [first_quiescent, second_quiescent],
				},
				indent=2,
				sort_keys=True,
			)
		)
	finally:
		if actor_id is not None and engine_forward.process is not None and not object_deleted:
			try:
				base.request_json(
					"DELETE",
					f"{engine_forward.base_url}/actors/"
					f"{urllib.parse.quote(actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
				)
			except Exception:
				pass
		engine_forward.stop()
		if api_forward is not None:
			api_forward.stop()


if __name__ == "__main__":
	main()
