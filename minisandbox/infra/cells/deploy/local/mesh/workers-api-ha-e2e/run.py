#!/usr/bin/env python3
"""Qualify the HPA-managed Workers API replica set without treating caches as truth."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


E2E_DIR = pathlib.Path(__file__).resolve().parent
BASE_RUNNER = E2E_DIR.parent / "workerd-persistent-code-e2e" / "run.py"
API_NAMESPACE = "workers-api-system"
REGISTRY_NAMESPACE = "worker-registry-system"
ACTOR_NAMESPACE = "default"


def load_base_runner():
	spec = importlib.util.spec_from_file_location("workerd_persistent_code_e2e", BASE_RUNNER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {BASE_RUNNER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_base_runner()


DO_SOURCE = """
import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  fetch() { return new Response("counter"); }
}
export default { fetch() { return new Response("ready"); } };
""".strip()

STATELESS_SOURCE = """
export default { fetch() { return new Response("ready"); } };
""".strip()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--timeout", type=float, default=180)
	parser.add_argument("--receipt", type=pathlib.Path)
	return parser.parse_args()


def digest(*parts):
	value = hashlib.sha256()
	for part in parts:
		value.update(part.encode())
		value.update(b"\0")
	return value.hexdigest()


def request(method, url, body=None, headers=None, expected=(200, 201, 204)):
	encoded = None if body is None else json.dumps(body).encode()
	req = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		req.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		req.add_header(name, value)
	try:
		with urllib.request.urlopen(req, timeout=60) as response:
			status = response.status
			payload = response.read()
	except urllib.error.HTTPError as error:
		status = error.code
		payload = error.read()
	if status not in expected:
		raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}")
	if not payload:
		return status, None
	try:
		return status, json.loads(payload)
	except json.JSONDecodeError:
		return status, payload.decode()


def list_ready_api_pods(hub):
	items = hub.json("get", "pods", "-l", "app.kubernetes.io/name=workers-api").get("items", [])
	return [pod for pod in items if base.ready(pod)]


def wait_for_api_replica_baseline(hub, old_uid, baseline_replicas, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		pods = list_ready_api_pods(hub)
		last = [(pod["metadata"]["name"], pod["metadata"]["uid"]) for pod in pods]
		if len(pods) >= baseline_replicas and all(
			pod["metadata"]["uid"] != old_uid for pod in pods
		):
			return pods
		time.sleep(0.25)
	raise TimeoutError(f"Workers API did not restore its Ready replica baseline: {last}")


def start_forwards(hub, pods):
	forwards = []
	try:
		for pod in pods:
			forward = base.PortForward(hub, f"pod/{pod['metadata']['name']}", 8080)
			forward.start("/readyz")
			forwards.append(forward)
		return forwards
	except Exception:
		for forward in forwards:
			forward.stop()
		raise


def upload_and_deploy(endpoint, worker, source, durable_objects=None):
	_, version = request(
		"POST",
		f"{endpoint}/v1/workers/{worker}/versions",
		{
			"main_module": "main.js",
			"modules": {"main.js": source},
			"compatibility_date": "2026-08-14",
			"durable_objects": durable_objects or {},
		},
	)
	_, deployment = request(
		"POST",
		f"{endpoint}/v1/workers/{worker}/deployments",
		{"version_id": version["id"]},
	)
	return version, deployment


def actor_lookup(engine_url, name, key):
	query = urllib.parse.urlencode({"namespace": ACTOR_NAMESPACE, "name": name, "key": key})
	return base.request_json("GET", f"{engine_url}/actors?{query}")["actors"]


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
			stream.write("\n")
			stream.flush()
			os.fsync(stream.fileno())
		os.link(temporary, path)
	finally:
		try:
			os.unlink(temporary)
		except FileNotFoundError:
			pass


def main():
	args = parse_args()
	hub = base.Kubectl(args.hub_kubeconfig, API_NAMESPACE)
	registry = base.Kubectl(args.hub_kubeconfig, REGISTRY_NAMESPACE)
	runtime = base.Kubectl(args.runtime_kubeconfig, base.KUBE_NAMESPACE)
	pods = list_ready_api_pods(hub)
	if len(pods) < 3:
		raise RuntimeError(f"qualification requires at least three Ready Workers API Pods, got {len(pods)}")
	baseline_replicas = len(pods)
	forwards = start_forwards(hub, pods)
	engine_forward = base.PortForward(runtime, f"service/{args.cell}-engine", 6420)
	engine_forward.start("/health")
	registry_forward = base.PortForward(registry, "service/worker-registry", 8080)
	registry_forward.start("/readyz")
	registry_scaled_down = False
	run_suffix = f"{time.time_ns():x}"[-12:]
	do_worker = "api-ha-do"
	stateless_worker = f"api-ha-web-{run_suffix}"
	do_actor_id = None
	do_object_deleted = False
	stateless_actor_id = None
	try:
		upload_and_deploy(forwards[0].base_url, do_worker, DO_SOURCE, {"COUNTER": "Counter"})
		object_id = digest(do_worker, "Counter", f"race-{time.time_ns()}")
		object_path = f"/v1/workers/{do_worker}/objects/Counter/{object_id}"
		with concurrent.futures.ThreadPoolExecutor(max_workers=baseline_replicas) as executor:
			results = list(
				executor.map(
					lambda forward: request("PUT", forward.base_url + object_path)[1],
					forwards,
				)
			)
		if len({json.dumps(result, sort_keys=True) for result in results}) != 1:
			raise RuntimeError(f"API replicas returned different ObjectRefs: {results}")
		actors = actor_lookup(
			engine_forward.base_url,
			"mf-" + digest(do_worker, "Counter")[:24],
			object_id,
		)
		if len(actors) != 1:
			raise RuntimeError(f"API replicas created {len(actors)} logical Actors: {actors}")
		do_actor_id = actors[0]["actor_id"]
		_, object_record = request(
			"GET",
			f"{registry_forward.base_url}/internal/v1/namespaces/{ACTOR_NAMESPACE}/workers/{do_worker}/objects/Counter/{object_id}",
		)
		placement = object_record.get("placement") or {}
		if object_record.get("schema") != "rivet-worker-object/v2" or object_record.get("state") != "active":
			raise RuntimeError(f"Registry returned an invalid placement record: {object_record}")
		if object_record.get("actor_id") != do_actor_id:
			raise RuntimeError("Registry Actor binding differs from the one live Actor")
		pool = base.Kubectl(args.hub_kubeconfig, "actor-fleet-system").json("get", "shardpool", "local-mesh")
		cell = base.Kubectl(args.hub_kubeconfig, "actor-fleet-system").json("get", "rivetcell", placement.get("cell_name", "missing"))
		route = hub.json("get", "configmap", "actor-cell-route-" + placement.get("cell_name", "missing"))
		if (
			placement.get("pool_uid") != pool["metadata"]["uid"]
			or placement.get("cell_uid") != cell.get("status", {}).get("spokeCellRef", {}).get("uid")
			or placement.get("cell_uid") != route.get("data", {}).get("cell-uid")
			or placement.get("datacenter") != route.get("data", {}).get("datacenter")
			or placement.get("snapshot_digest", "")[:7] != "sha256:"
		):
			raise RuntimeError("FDB placement does not match the live admission route")

		# Remove every Registry endpoint, rather than merely restarting one Pod, so
		# all API replicas lose both their deployment watch and their claim path.
		# A warm Durable Object placement is allowed to continue from the bounded
		# Router cache; a fresh Object must fail closed and must not create an Actor.
		outage_object_id = digest(do_worker, "Counter", f"registry-outage-{time.time_ns()}")
		outage_path = f"/v1/workers/{do_worker}/objects/Counter/{outage_object_id}"
		registry_forward.stop()
		registry.run("scale", "deployment/worker-registry", "--replicas=0")
		registry_scaled_down = True
		registry.run(
			"wait", "--for=delete", "pod", "-l", "app.kubernetes.io/name=worker-registry",
			f"--timeout={int(args.timeout)}s",
		)
		try:
			for forward in forwards:
				_, payload = request(
					"GET",
					forward.base_url + object_path + "/fetch",
					headers={"x-workers-original-url": "https://worker.test/counter"},
				)
				if payload != "counter":
					raise RuntimeError(f"cached Object fetch changed during Registry outage: {payload!r}")
			status, failure = request(
				"PUT", forwards[0].base_url + outage_path, expected=(503, 504),
			)
			if status not in (503, 504) or failure.get("error", {}).get("retryable") is not True:
				raise RuntimeError(f"Registry outage did not fail a placement miss closed: {failure}")
			if actor_lookup(
				engine_forward.base_url,
				"mf-" + digest(do_worker, "Counter")[:24],
				outage_object_id,
			):
				raise RuntimeError("Registry outage created an Actor without a durable placement")
		finally:
			registry.run("scale", "deployment/worker-registry", "--replicas=3")
			registry.run(
				"rollout", "status", "deployment/worker-registry",
				f"--timeout={int(args.timeout)}s",
			)
			registry_scaled_down = False
		registry_forward = base.PortForward(registry, "service/worker-registry", 8080)
		registry_forward.start("/readyz")
		request("PUT", forwards[0].base_url + outage_path)
		request("DELETE", forwards[0].base_url + outage_path, expected=(204,))

		victim = pods[0]
		old_uid = victim["metadata"]["uid"]
		forwards[0].stop()
		hub.run("delete", "pod", victim["metadata"]["name"], "--wait=false")
		failures = []
		for index in range(30):
			try:
				request("GET", f"{forwards[1 + index % 2].base_url}/v1/workers/{do_worker}")
			except Exception as error:
				failures.append(str(error))
		new_pods = wait_for_api_replica_baseline(hub, old_uid, baseline_replicas, args.timeout)
		if failures:
			raise RuntimeError(f"API replacement interrupted control traffic: {failures[:3]}")
		new_pod = next(pod for pod in new_pods if pod["metadata"]["uid"] not in {p["metadata"]["uid"] for p in pods})
		new_forward = start_forwards(hub, [new_pod])[0]
		forwards[0] = new_forward
		request("PUT", new_forward.base_url + object_path)
		after = actor_lookup(
			engine_forward.base_url,
			"mf-" + digest(do_worker, "Counter")[:24],
			object_id,
		)
		if len(after) != 1 or after[0]["actor_id"] != do_actor_id:
			raise RuntimeError(f"API restart changed logical Actor: before={actors} after={after}")

		status, failure = request(
			"DELETE",
			f"{forwards[1].base_url}/v1/workers/{do_worker}",
			expected=(409,),
		)
		if status != 409 or failure.get("error", {}).get("code") != "worker_has_durable_objects":
			raise RuntimeError(f"Durable Worker delete did not fail closed: {failure}")

		with concurrent.futures.ThreadPoolExecutor(max_workers=baseline_replicas) as executor:
			delete_results = list(
				executor.map(
					lambda forward: request("DELETE", forward.base_url + object_path, expected=(204,))[0],
					forwards,
				)
			)
		if delete_results != [204] * baseline_replicas:
			raise RuntimeError(f"concurrent Durable Object deletes diverged: {delete_results}")
		do_object_deleted = True
		registry.run("rollout", "restart", "deployment/worker-registry")
		registry.run("rollout", "status", "deployment/worker-registry", f"--timeout={int(args.timeout)}s")
		for forward in forwards:
			status, failure = request("PUT", forward.base_url + object_path, expected=(410,))
			if status != 410 or failure.get("error", {}).get("code") != "object_deleted":
				raise RuntimeError(f"deleted object was not fenced on every API replica: {failure}")
		if actor_lookup(engine_forward.base_url, "mf-" + digest(do_worker, "Counter")[:24], object_id):
			raise RuntimeError("deleted Durable Object still has an active Actor")

		upload_and_deploy(forwards[1].base_url, stateless_worker, STATELESS_SOURCE)
		dispatch_path = f"/v1/workers/{stateless_worker}/dispatch"
		dispatch_headers = {"x-workers-original-url": "https://worker.test/ready"}
		for forward in (forwards[1], forwards[2]):
			_, payload = request("GET", forward.base_url + dispatch_path, headers=dispatch_headers)
			if payload != "ready":
				raise RuntimeError(f"stateless dispatch returned an unexpected response: {payload!r}")
		stateless_key = digest(stateless_worker, "default")
		stateless_actors = actor_lookup(
			engine_forward.base_url,
			"mf-" + digest(stateless_worker, "default")[:24],
			stateless_key,
		)
		if stateless_actors:
			raise RuntimeError(f"stateless dispatch created a persistent Actor: {stateless_actors}")
		request("DELETE", f"{forwards[0].base_url}/v1/workers/{stateless_worker}", expected=(204,))
		status, failure = request(
			"GET",
			forwards[1].base_url + dispatch_path,
			headers=dispatch_headers,
			expected=(404,),
		)
		if status != 404 or failure.get("error", {}).get("code") != "not_found":
			raise RuntimeError(f"stale API cache bypassed Worker deletion: {failure}")

		result = {
					"schema": "actor-first-placement/v1",
					"verdict": "passed",
					"api_replicas": baseline_replicas,
					"api_replacement_zero_failures": True,
					"deleted_pod_uid": old_uid,
					"durable_delete_fail_closed": True,
					"durable_object_delete_idempotent": True,
					"durable_object_tombstone_all_replicas": True,
					"durable_object_tombstone_survived_registry_restart": True,
					"registry_outage_cached_object_survived": True,
					"registry_outage_new_object_failed_closed": True,
					"registry_outage_recovery_converged": True,
					"logical_actor_id": do_actor_id,
					"first_placement": {
						"object_id": object_id,
						"object_ref": results[0],
						"registry_record": object_record,
						"route_configmap_uid": route["metadata"]["uid"],
					},
					"replacement_pod_uid": new_pod["metadata"]["uid"],
					"stateless_dispatch_created_actor": False,
					"stale_cache_delete_blocked": True,
					"replica_set_first_request_converged": True,
				}
		if args.receipt:
			publish_new(args.receipt, result)
		print(json.dumps(result, indent=2, sort_keys=True))
	finally:
		if registry_scaled_down:
			try:
				registry.run("scale", "deployment/worker-registry", "--replicas=3")
				registry.run(
					"rollout", "status", "deployment/worker-registry",
					f"--timeout={int(args.timeout)}s",
				)
			except Exception:
				pass
		for actor_id in ((None if do_object_deleted else do_actor_id), stateless_actor_id):
			if actor_id:
				try:
					base.request_json(
						"DELETE",
						f"{engine_forward.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
					)
				except Exception:
					pass
		for forward in forwards:
			forward.stop()
		engine_forward.stop()
		registry_forward.stop()


if __name__ == "__main__":
	main()
