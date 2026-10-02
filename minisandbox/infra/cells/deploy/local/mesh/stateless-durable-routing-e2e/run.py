#!/usr/bin/env python3
"""Qualify real stateless fetch and same/cross-Cell Durable Object routing."""

import argparse
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


HERE = pathlib.Path(__file__).resolve().parent
BASE_RUNNER = HERE.parent / "workerd-persistent-code-e2e" / "run.py"
API_NAMESPACE = "workers-api-system"
REGISTRY_NAMESPACE = "worker-registry-system"
RUNTIME_NAMESPACE = "actor-fdb-cell-system"
STATELESS_NAMESPACE = "actor-stateless-system"
ACTOR_NAMESPACE = "default"
CLASS_NAME = "Counter"


def load_base_runner():
	spec = importlib.util.spec_from_file_location("workerd_persistent_code_e2e", BASE_RUNNER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {BASE_RUNNER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_base_runner()


WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch(request) {
    const current = (await this.ctx.storage.get("value")) ?? 0;
    const value = current + 1;
    await this.ctx.storage.put("value", value);
    return Response.json({ value });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/plain") {
      return Response.json({ plane: "stateless", host: url.hostname, path: url.pathname });
    }
    const name = url.searchParams.get("name");
    if (!name) return new Response("name is required", { status: 400 });
    const id = env.COUNTER.idFromName(name);
    return env.COUNTER.get(id).fetch(new Request("https://counter.internal/increment", {
      method: "POST"
    }));
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
	parser.add_argument("--runtime-b-kubeconfig", default=state / "runtime-b.kubeconfig")
	parser.add_argument("--timeout", type=float, default=180)
	parser.add_argument("--receipt", type=pathlib.Path)
	return parser.parse_args()


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=60):
	encoded = None if body is None else json.dumps(body).encode()
	req = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		req.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		req.add_header(name, value)
	try:
		with urllib.request.urlopen(req, timeout=timeout) as response:
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


def sha256(value):
	return hashlib.sha256(value).hexdigest()


def namespace_key(worker):
	return "do_" + sha256(f"{ACTOR_NAMESPACE}\0{worker}\0{CLASS_NAME}".encode())


def object_id(worker, name):
	domain = f"rivet-do-id/v1\0default\0{ACTOR_NAMESPACE}\0{namespace_key(worker)}\0{name}"
	return sha256(domain.encode())


def selected_cell(worker, object_value, cell_uids):
	key = f"{worker}\0{CLASS_NAME}\0{object_value}"
	return max(
		cell_uids,
		key=lambda cell: int.from_bytes(
			hashlib.sha256(f"{key}\0{cell_uids[cell]}".encode()).digest()[:8], "big"
		),
	)


def names_for_cells(worker, cell_uids):
	result = {}
	for index in range(10_000):
		name = f"route-{time.time_ns():x}-{index}"
		value = object_id(worker, name)
		cell = selected_cell(worker, value, cell_uids)
		result.setdefault(cell, (name, value))
		if len(result) == len(cell_uids):
			return result
	raise RuntimeError("could not find one rendezvous key per Cell")


def metric(endpoint, name):
	with urllib.request.urlopen(endpoint + "/metrics", timeout=10) as response:
		for line in response.read().decode().splitlines():
			if line.startswith(name + " "):
				return int(line.split()[1])
	raise RuntimeError(f"metric {name} is absent from {endpoint}")


def ready_pods(kubectl, selector):
	return [
		item for item in kubectl.json("get", "pods", "-l", selector).get("items", [])
		if base.ready(item)
	]


def wait_replacement(kubectl, selector, old_uid, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		pods = ready_pods(kubectl, selector)
		last = [(item["metadata"]["name"], item["metadata"]["uid"]) for item in pods]
		if len(pods) == 1 and pods[0]["metadata"]["uid"] != old_uid:
			return pods[0]
		time.sleep(0.25)
	raise TimeoutError(f"stateless executor Pod was not replaced: {last}")


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
		try: os.unlink(temporary)
		except FileNotFoundError: pass


def main():
	args = parse_args()
	hub_api = base.Kubectl(args.hub_kubeconfig, API_NAMESPACE)
	hub_registry = base.Kubectl(args.hub_kubeconfig, REGISTRY_NAMESPACE)
	fleet = base.Kubectl(args.hub_kubeconfig, "actor-fleet-system")
	runtime_a = base.Kubectl(args.runtime_a_kubeconfig, RUNTIME_NAMESPACE)
	runtime_b = base.Kubectl(args.runtime_b_kubeconfig, RUNTIME_NAMESPACE)
	stateless_a = base.Kubectl(args.runtime_a_kubeconfig, STATELESS_NAMESPACE)
	stateless_b = base.Kubectl(args.runtime_b_kubeconfig, STATELESS_NAMESPACE)

	forwards = {
		"api": base.PortForward(hub_api, "service/workers-api", 8080),
		"registry": base.PortForward(hub_registry, "service/worker-registry", 8080),
		"engine-a": base.PortForward(runtime_a, "service/local-runtime-a-engine", 6420),
		"engine-b": base.PortForward(runtime_b, "service/local-runtime-b-engine", 6420),
		"stateless-a": base.PortForward(stateless_a, "service/local-runtime-a-stateless-executor", 19084),
		"stateless-b": base.PortForward(stateless_b, "service/local-runtime-b-stateless-executor", 19084),
	}
	for name, forward in forwards.items():
		forward.start("/health" if name.startswith("engine") else "/readyz")

	worker = f"stateless-do-e2e-{time.time_ns():x}"[-63:]
	object_paths = []
	try:
		api = forwards["api"].base_url + "/v1"
		_, version = request("POST", f"{api}/workers/{worker}/versions", {
			"main_module": "main.js",
			"modules": {"main.js": WORKER_SOURCE},
			"compatibility_date": "2026-08-14",
			"durable_objects": {"COUNTER": CLASS_NAME},
		})
		request("POST", f"{api}/workers/{worker}/deployments", {"version_id": version["id"]})
		_, plain = request(
			"GET", f"{api}/workers/{worker}/dispatch",
			headers={"X-Workers-Original-URL": "https://stateless.example/plain"},
		)
		if plain != {"plane": "stateless", "host": "stateless.example", "path": "/plain"}:
			raise RuntimeError(f"ordinary stateless fetch changed URL or response: {plain}")

		cells = fleet.json("get", "rivetcells", "-l", "fleet.actor.dev/pool=local-mesh")
		cell_uids = {}
		for item in cells.get("items", []):
			cluster = item.get("spec", {}).get("managementCluster")
			uid = item.get("status", {}).get("spokeCellRef", {}).get("uid")
			if cluster in {"runtime-a", "runtime-b"} and uid:
				cell_uids[cluster] = uid
		if set(cell_uids) != {"runtime-a", "runtime-b"}:
			raise RuntimeError(f"A/B Cell identity is incomplete: {cell_uids}")
		targets = names_for_cells(worker, cell_uids)

		before = {
			"runtime-a": metric(forwards["stateless-a"].base_url, "rivet_stateless_dispatch_total"),
			"runtime-b": metric(forwards["stateless-b"].base_url, "rivet_stateless_dispatch_total"),
		}
		values = {}
		for target in ("runtime-b", "runtime-b", "runtime-a", "runtime-a"):
			name, _ = targets[target]
			_, payload = request(
				"POST", f"{api}/workers/{worker}/dispatch",
				headers={"X-Workers-Original-URL": "https://stateless.example/counter?" + urllib.parse.urlencode({"name": name})},
			)
			values.setdefault(target, []).append(payload["value"])
		if values != {"runtime-b": [1, 2], "runtime-a": [1, 2]}:
			raise RuntimeError(f"Durable Object state did not serialize by key: {values}")
		after = {
			"runtime-a": metric(forwards["stateless-a"].base_url, "rivet_stateless_dispatch_total"),
			"runtime-b": metric(forwards["stateless-b"].base_url, "rivet_stateless_dispatch_total"),
		}
		deltas = {cell: after[cell] - before[cell] for cell in before}
		if sum(deltas.values()) != 4 or min(deltas.values()) < 1:
			raise RuntimeError(f"A/B stateless dispatch did not exercise both Cells: {deltas}")

		records = {}
		for target, (name, value) in targets.items():
			path = f"/workers/{worker}/objects/{CLASS_NAME}/{value}"
			object_paths.append(path)
			_, record = request(
				"GET",
				f"{forwards['registry'].base_url}/internal/v1/namespaces/{ACTOR_NAMESPACE}/workers/{worker}/objects/{CLASS_NAME}/{value}",
			)
			if record.get("placement", {}).get("cell_uid") != cell_uids[target]:
				raise RuntimeError(f"{target} immutable placement differs: {record}")
			records[target] = record
			_, direct = request(
				"POST", api + path + "/fetch",
				headers={"X-Workers-Original-URL": "https://counter.internal/increment"},
			)
			if direct.get("value") != 3:
				raise RuntimeError(f"direct ObjectRef did not converge with binding: {direct}")

		b_record = records["runtime-b"]
		request(
			"POST",
			f"{forwards['engine-b'].base_url}/actors/{urllib.parse.quote(b_record['actor_id'], safe='')}/sleep?namespace={ACTOR_NAMESPACE}",
			{},
		)
		base.wait_for_sleep(forwards["engine-b"].base_url, b_record["actor_id"], args.timeout)
		name, _ = targets["runtime-b"]
		_, woke = request(
			"POST", f"{api}/workers/{worker}/dispatch",
			headers={"X-Workers-Original-URL": "https://stateless.example/counter?" + urllib.parse.urlencode({"name": name})},
		)
		if woke.get("value") != 4:
			raise RuntimeError(f"sleep/wake lost Durable Object state: {woke}")

		selector = "fleet.actor.dev/cell-name=local-runtime-a,fleet.actor.dev/component=stateless-executor"
		pods = ready_pods(stateless_a, selector)
		if len(pods) != 1:
			raise RuntimeError(f"expected one local A executor Pod, got {len(pods)}")
		old_uid = pods[0]["metadata"]["uid"]
		forwards["stateless-a"].stop()
		stateless_a.run("delete", "pod", pods[0]["metadata"]["name"], "--wait=false")
		new_pod = wait_replacement(stateless_a, selector, old_uid, args.timeout)
		forwards["stateless-a"].start("/readyz")
		for _ in range(2):
			request(
				"GET", f"{api}/workers/{worker}/dispatch",
				headers={"X-Workers-Original-URL": "https://stateless.example/plain"},
			)
		if metric(forwards["stateless-a"].base_url, "rivet_stateless_dispatch_total") < 1:
			raise RuntimeError("replacement A executor did not receive a dispatch")

		result = {
			"schema": "stateless-durable-routing-e2e/v1",
			"verdict": "passed",
			"worker": worker,
			"version": version["id"],
			"dispatchDeltas": deltas,
			"placements": {
				cell: {"cellUid": cell_uids[cell], "objectId": targets[cell][1], "actorId": records[cell]["actor_id"]}
				for cell in sorted(targets)
			},
			"sameAndCrossCell": True,
			"sleepWake": True,
			"statelessPodReplacement": {"oldUid": old_uid, "newUid": new_pod["metadata"]["uid"]},
		}
		if args.receipt:
			publish_new(args.receipt, result)
		print(json.dumps(result, indent=2, sort_keys=True))
	finally:
		api = forwards["api"].base_url + "/v1"
		for path in object_paths:
			try: request("DELETE", api + path, expected=(204, 410))
			except Exception: pass
		for forward in forwards.values():
			forward.stop()


if __name__ == "__main__":
	main()
