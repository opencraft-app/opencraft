#!/usr/bin/env python3
"""Prove the Miniflare v3 facade and native Durable Object survive Host replacement."""

import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.parse


E2E_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = E2E_DIR.parents[5]
BASE_RUNNER = E2E_DIR.parent / "workerd-persistent-code-e2e" / "run.py"
ACTOR_NAMESPACE = "default"
WORKERS_API_NAMESPACE = "workers-api-system"


def load_base_runner():
	spec = importlib.util.spec_from_file_location("workerd_persistent_code_e2e", BASE_RUNNER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {BASE_RUNNER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_base_runner()


def phase(module_path, endpoint, worker, object_name, expected, verify_rejected=False):
	result = subprocess.run(
		[
			"node",
			str(E2E_DIR / "counter.mjs"),
			str(module_path),
			endpoint,
			worker,
			object_name,
			str(expected),
			str(verify_rejected).lower(),
		],
		text=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		timeout=90,
	)
	if result.returncode:
		raise RuntimeError(f"Miniflare phase {expected} failed: {result.stderr.strip()}")
	return json.loads(result.stdout)


def delete_phase(module_path, endpoint, worker, object_name):
	result = subprocess.run(
		["node", str(E2E_DIR / "delete.mjs"), str(module_path), endpoint, worker, object_name],
		text=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		timeout=90,
	)
	if result.returncode:
		raise RuntimeError(f"Miniflare delete phase failed: {result.stderr.strip()}")
	return json.loads(result.stdout)


def worker_for_cell(cell):
	target = {"local-runtime-a": 0, "local-runtime-b": 1}.get(cell)
	if target is None:
		raise RuntimeError(f"unsupported local Workers API Cell {cell}")
	for index in range(1024):
		worker = f"mf-real-{cell.removeprefix('local-runtime-')}-{index}"
		object_id = digest(worker, "Counter", "alice")
		cache_key = f"{worker}\0Counter\0{object_id}".encode()
		if hashlib.sha256(cache_key).digest()[0] % 2 == target:
			return worker
	raise RuntimeError(f"could not select a deterministic Worker identity for {cell}")


def digest(*parts):
	hash_value = hashlib.sha256()
	for part in parts:
		hash_value.update(part.encode())
		hash_value.update(b"\0")
	return hash_value.hexdigest()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--api-endpoint", help="complete public Workers API /v1 URL")
	parser.add_argument("--timeout", type=float, default=180)
	return parser.parse_args()


def main():
	args = parse_args()
	module_path = REPO_ROOT / "runtimes/workerd/miniflare/dist/index.js"
	if not module_path.is_file():
		raise RuntimeError(
			f"Miniflare build is missing: {module_path}; run npm run build in its package first"
		)
	runtime = base.Kubectl(args.runtime_kubeconfig, base.KUBE_NAMESPACE)
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
	worker = worker_for_cell(args.cell)
	object_name = f"e2e-{time.time_ns():x}"
	actor_id = None
	object_deleted = False
	cleanup_errors = []
	try:
		if api_forward is not None:
			api_forward.start("/readyz")
			api_endpoint = f"{api_forward.base_url}/v1"
		else:
			# Qualify the public contract itself. The ingress health endpoint is an
			# implementation detail and is intentionally not part of the /v1 API.
			base.request_json("GET", f"{api_endpoint}/workers")
		engine_forward.start("/health")
		first = phase(
			module_path,
			api_endpoint,
			worker,
			object_name,
			1,
			True,
		)
		if not first["rejected_update_preserved_deployment"]:
			raise RuntimeError("rejected Worker update did not preserve the active Deployment")
		query = urllib.parse.urlencode(
			{
				"namespace": ACTOR_NAMESPACE,
				"name": first["actor_name"],
				"key": first["object_id"],
			}
		)
		actors = base.request_json("GET", f"{engine_forward.base_url}/actors?{query}")["actors"]
		if len(actors) != 1:
			raise RuntimeError(f"expected one Miniflare Counter actor, got {actors}")
		actor_id = actors[0]["actor_id"]
		base.request_json(
			"POST",
			f"{engine_forward.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}/sleep?namespace={ACTOR_NAMESPACE}",
			{},
		)
		sleep_state = base.wait_for_sleep(engine_forward.base_url, actor_id, args.timeout)
		pods = runtime.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={args.cell},fleet.actor.dev/component=workerd-host",
		).get("items", [])
		if len(pods) != 1 or not base.ready(pods[0]):
			raise RuntimeError(f"qualification requires exactly one Ready Host, got {len(pods)}")
		pod_name = pods[0]["metadata"]["name"]
		old_uid = pods[0]["metadata"]["uid"]
		runtime.run("delete", "pod", pod_name, "--wait=false")
		new_uid = base.wait_for_host_replacement(runtime, pod_name, old_uid, args.timeout)
		second = phase(
			module_path,
			api_endpoint,
			worker,
			object_name,
			2,
		)
		third = phase(
			module_path,
			api_endpoint,
			worker,
			object_name,
			3,
		)
		if not first["object_id"] == second["object_id"] == third["object_id"]:
			raise RuntimeError("Durable Object identity changed across Miniflare processes")
		deleted = delete_phase(module_path, api_endpoint, worker, object_name)
		object_deleted = deleted["object_deleted"]
		if not object_deleted or deleted["object_id"] != first["object_id"]:
			raise RuntimeError(f"Durable Object deletion did not preserve identity: {deleted}")
		print(
			json.dumps(
				{
					"actor_id": actor_id,
					"cell": args.cell,
					"counter_values": [first["value"], second["value"], third["value"]],
					"host_pod": pod_name,
					"miniflare_v3_facade": True,
					"native_durable_object_class": "Counter",
					"new_pod_uid": new_uid,
					"object_id": first["object_id"],
					"object_deleted": deleted["object_deleted"],
					"old_pod_uid": old_uid,
					"original_origin": third["origin"],
					"rejected_update_preserved_deployment": first[
						"rejected_update_preserved_deployment"
					],
					"sleep_ts": sleep_state["sleep_ts"],
					"worker": worker,
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
					f"{engine_forward.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
				)
			except Exception as error:
				cleanup_errors.append(f"Actor cleanup: {error}")
		if api_endpoint is not None:
			try:
				base.request_json("DELETE", f"{api_endpoint}/workers/{worker}")
				cleanup_errors.append("Durable Worker deletion unexpectedly succeeded")
			except Exception as error:
				message = str(error)
				if "HTTP 409" not in message or "worker_has_durable_objects" not in message:
					cleanup_errors.append(f"Worker delete gate: {error}")
		engine_forward.stop()
		if api_forward is not None:
			api_forward.stop()
		if cleanup_errors:
			print("; ".join(cleanup_errors), file=sys.stderr)


if __name__ == "__main__":
	main()
