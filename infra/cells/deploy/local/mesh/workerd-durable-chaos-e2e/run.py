#!/usr/bin/env python3
"""Qualify one persistent Durable Object across the complete local fault matrix."""

import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


HERE = pathlib.Path(__file__).resolve().parent
BASE_RUNNER = HERE.parent / "workerd-persistent-code-e2e" / "run.py"
RUNTIME_NAMESPACE = "actor-fdb-cell-system"
REGISTRY_NAMESPACE = "worker-registry-system"
API_NAMESPACE = "workers-api-system"
ACTOR_NAMESPACE = "default"
WORKER = "durable-chaos-counter"
CLASS_NAME = "Counter"


class TransientRequestError(RuntimeError):
	pass


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
    const url = new URL(request.url);
    const current = (await this.ctx.storage.get("value")) ?? 0;
    if (url.pathname === "/value") {
      return Response.json({ value: current });
    }
    if (url.pathname !== "/increment" && url.pathname !== "/slow-increment") {
      return new Response("not found", { status: 404 });
    }
    const token = request.headers.get("Idempotency-Key");
    if (!token || !/^[a-zA-Z0-9._:-]{1,128}$/.test(token)) {
      return Response.json({ error: "valid Idempotency-Key required" }, { status: 400 });
    }
    const operationKey = `operation:${token}`;
    const replay = await this.ctx.storage.get(operationKey);
    if (replay !== undefined) {
      return Response.json({ value: replay, replayed: true });
    }
    const value = current + 1;
    await this.ctx.storage.put({ value, [operationKey]: value });
    if (url.pathname === "/slow-increment") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return Response.json({ value, replayed: false });
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--k3d-cluster", default="rivet-runtime-a")
	parser.add_argument("--timeout", type=float, default=240)
	parser.add_argument("--skip-node-drain", action="store_true")
	return parser.parse_args()


def digest(*parts):
	value = hashlib.sha256()
	for part in parts:
		value.update(part.encode())
		value.update(b"\0")
	return value.hexdigest()


def http_json(method, url, body=None, headers=None, timeout=30, expected=(200, 201, 204)):
	encoded = None if body is None else json.dumps(body).encode()
	request = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		request.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		request.add_header(name, value)
	try:
		with urllib.request.urlopen(request, timeout=timeout) as response:
			status = response.status
			payload = response.read()
	except urllib.error.HTTPError as error:
		status = error.code
		payload = error.read()
	if status not in expected:
		error_type = TransientRequestError if status >= 500 or status in (408, 429) else RuntimeError
		raise error_type(
			f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}"
		)
	if not payload:
		return status, None
	try:
		return status, json.loads(payload)
	except json.JSONDecodeError:
		return status, payload.decode(errors="replace")


def ready_pods(kubectl, selector):
	items = kubectl.json("get", "pods", "-l", selector).get("items", [])
	return [pod for pod in items if base.ready(pod)]


def wait_for_pods_replaced(kubectl, selector, old_uids, count, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		pods = ready_pods(kubectl, selector)
		last = [(pod["metadata"]["name"], pod["metadata"]["uid"]) for pod in pods]
		if len(pods) == count and all(pod["metadata"]["uid"] not in old_uids for pod in pods):
			return pods
		time.sleep(0.25)
	raise TimeoutError(f"Pods did not converge to {count} replacement replicas: {last}")


def wait_for_node(kubectl, previous, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		items = kubectl.json("get", "nodes").get("items", [])
		ready = {
			item["metadata"]["name"]
			for item in items
			if base.ready(item) and item["metadata"]["name"] not in previous
		}
		last = sorted(ready)
		if len(ready) == 1:
			return next(iter(ready))
		time.sleep(0.25)
	raise TimeoutError(f"temporary k3d node did not become Ready: {last}")


def wait_for_host_on_node(kubectl, selector, old_uid, node, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		pods = ready_pods(kubectl, selector)
		last = [
			(pod["metadata"]["name"], pod["metadata"]["uid"], pod["spec"].get("nodeName"))
			for pod in pods
		]
		if (
			len(pods) == 1
			and pods[0]["metadata"]["uid"] != old_uid
			and pods[0]["spec"].get("nodeName") == node
		):
			return pods[0]
		time.sleep(0.25)
	raise TimeoutError(f"workerd Host did not relocate to {node}: {last}")


class Qualification:
	def __init__(self, args):
		self.args = args
		self.hub_registry = base.Kubectl(args.hub_kubeconfig, REGISTRY_NAMESPACE)
		self.hub_api = base.Kubectl(args.hub_kubeconfig, API_NAMESPACE)
		self.runtime = base.Kubectl(args.runtime_kubeconfig, RUNTIME_NAMESPACE)
		self.api_forward = base.PortForward(self.hub_api, "service/workers-api", 8080)
		self.engine_forward = base.PortForward(
			self.runtime, f"service/{args.cell}-engine", 6420
		)
		self.run_id = uuid.uuid4().hex[:12]
		self.object_id = digest(WORKER, CLASS_NAME, self.run_id)
		self.actor_name = "mf-" + digest(WORKER, CLASS_NAME)[:24]
		self.actor_id = None
		self.expected = 0
		self.identity_checks = []
		self.faults = []
		self.transient_k3d_node = None
		self.transient_kube_node = None
		self.original_compute_node = None

	@property
	def api(self):
		return self.api_forward.base_url + "/v1"

	@property
	def engine(self):
		return self.engine_forward.base_url

	@property
	def object_url(self):
		return (
			f"{self.api}/workers/{WORKER}/objects/{CLASS_NAME}/{self.object_id}/fetch"
		)

	def start(self):
		self.api_forward.start("/readyz")
		self.engine_forward.start("/health")

	def upload_and_deploy(self):
		_, version = http_json(
			"POST",
			f"{self.api}/workers/{WORKER}/versions",
			{
				"main_module": "main.js",
				"modules": {"main.js": WORKER_SOURCE},
				"compatibility_date": "2026-08-14",
				"durable_objects": {"COUNTER": CLASS_NAME},
			},
		)
		_, deployment = http_json(
			"POST",
			f"{self.api}/workers/{WORKER}/deployments",
			{"version_id": version["id"]},
		)
		http_json("PUT", self.object_url.removesuffix("/fetch"))
		# Capture identity before the first mutation so cleanup still owns the
		# exact Actor if a later assertion fails.
		self.assert_identity("created")
		return version["id"], deployment["id"]

	def fetch(self, path, method="GET", token=None, timeout=30):
		headers = {"X-Workers-Original-URL": f"https://chaos.worker.test{path}"}
		if token is not None:
			headers["Idempotency-Key"] = token
		return http_json(method, self.object_url, headers=headers, timeout=timeout)[1]

	def read_value(self, timeout=None):
		deadline = time.monotonic() + (timeout or self.args.timeout)
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.fetch("/value")
				if last.get("value") == self.expected:
					return last
				if isinstance(last.get("value"), int) and last["value"] > self.expected:
					raise RuntimeError(
						f"Counter advanced past acknowledged value {self.expected}: {last}"
					)
			except (
				TransientRequestError,
				TimeoutError,
				socket.timeout,
				urllib.error.URLError,
				ConnectionError,
			) as error:
				last = str(error)
			time.sleep(0.25)
		raise TimeoutError(f"Counter did not recover value {self.expected}: {last}")

	def advance(self, label, token=None):
		token = token or f"{self.run_id}:{label}"
		target = self.expected + 1
		deadline = time.monotonic() + self.args.timeout
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.fetch("/increment", method="POST", token=token)
				if last.get("value") == target:
					self.expected = target
					self.read_value()
					self.assert_identity(label)
					return last
				if isinstance(last.get("value"), int) and last["value"] > target:
					raise RuntimeError(f"mutation {label} executed more than once: {last}")
			except (
				TransientRequestError,
				TimeoutError,
				socket.timeout,
				urllib.error.URLError,
				ConnectionError,
			) as error:
				last = str(error)
			time.sleep(0.25)
		raise TimeoutError(f"mutation {label} did not converge to {target}: {last}")

	def actor_records(self):
		query = urllib.parse.urlencode(
			{
				"namespace": ACTOR_NAMESPACE,
				"name": self.actor_name,
				"key": self.object_id,
			}
		)
		return base.request_json("GET", f"{self.engine}/actors?{query}")["actors"]

	def assert_identity(self, stage):
		records = self.actor_records()
		if len(records) != 1:
			raise RuntimeError(f"{stage}: expected one logical Actor record, got {records}")
		actor_id = records[0]["actor_id"]
		if self.actor_id is None:
			self.actor_id = actor_id
		elif actor_id != self.actor_id:
			raise RuntimeError(
				f"{stage}: logical Actor ID drifted from {self.actor_id} to {actor_id}"
			)
		self.identity_checks.append(
			{
				"stage": stage,
				"actor_id": actor_id,
				"generation": records[0].get("generation"),
				"connectable": records[0].get("connectable_ts") is not None,
			}
		)

	def sleep_wake(self):
		base.request_json(
			"POST",
			f"{self.engine}/actors/{urllib.parse.quote(self.actor_id, safe='')}/sleep?namespace={ACTOR_NAMESPACE}",
			{},
		)
		base.wait_for_sleep(self.engine, self.actor_id, self.args.timeout)
		self.advance("sleep-wake")
		self.faults.append("actor_sleep_wake")

	def restart_host(self, reason):
		selector = (
			f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host"
		)
		pods = ready_pods(self.runtime, selector)
		if len(pods) != 1:
			raise RuntimeError(f"{reason}: expected one Ready workerd Host, got {len(pods)}")
		pod = pods[0]
		self.runtime.run("delete", "pod", pod["metadata"]["name"], "--wait=false")
		base.wait_for_host_replacement(
			self.runtime, pod["metadata"]["name"], pod["metadata"]["uid"], self.args.timeout
		)
		self.faults.append(reason)

	def rollout(self, kubectl, deployment, selector, count, reason, forward=None):
		old = {pod["metadata"]["uid"] for pod in ready_pods(kubectl, selector)}
		if len(old) != count:
			raise RuntimeError(f"{reason}: expected {count} Ready Pods before restart, got {len(old)}")
		if forward is not None:
			forward.stop()
		kubectl.run("rollout", "restart", f"deployment/{deployment}")
		kubectl.run("rollout", "status", f"deployment/{deployment}", f"--timeout={int(self.args.timeout)}s")
		wait_for_pods_replaced(kubectl, selector, old, count, self.args.timeout)
		if forward is not None:
			forward.start("/health" if forward is self.engine_forward else "/readyz")
		self.faults.append(reason)

	def create_transient_compute_node(self):
		previous = {
			item["metadata"]["name"]
			for item in self.runtime.json("get", "nodes").get("items", [])
		}
		self.transient_k3d_node = f"{self.args.k3d_cluster}-chaos-{self.run_id[:6]}"
		command = [
			"k3d",
			"node",
			"create",
			self.transient_k3d_node,
			"--cluster",
			self.args.k3d_cluster,
			"--role",
			"agent",
			"--k3s-node-label",
			"rivet.dev/compute=true",
			"--k3s-node-label",
			"rivet.dev/pvm=true",
			"--timeout",
			f"{int(self.args.timeout)}s",
		]
		result = subprocess.run(command, text=True, capture_output=True, timeout=self.args.timeout + 30)
		if result.returncode:
			raise RuntimeError(f"create temporary k3d compute node: {result.stderr.strip()}")
		self.transient_kube_node = wait_for_node(self.runtime, previous, self.args.timeout)
		self.runtime.run(
			"taint",
			"node",
			self.transient_kube_node,
			"rivet.dev/compute=true:NoSchedule",
			"--overwrite",
		)
		statefulset = self.runtime.json(
			"get", "statefulset", f"{self.args.cell}-runtime-hosts"
		)
		pod_spec = statefulset["spec"]["template"]["spec"]
		images = {
			container["image"]
			for container in pod_spec.get("initContainers", []) + pod_spec.get("containers", [])
			if container["image"].startswith("rivet/")
		}
		for image in sorted(images):
			result = subprocess.run(
				["k3d", "image", "import", image, "--cluster", self.args.k3d_cluster],
				text=True,
				capture_output=True,
				timeout=self.args.timeout,
			)
			if result.returncode:
				raise RuntimeError(
					f"import runtime image {image} into temporary compute node: {result.stderr.strip()}"
				)

	def node_drain(self):
		if self.args.skip_node_drain:
			self.faults.append("node_drain_SKIPPED")
			return
		selector = (
			f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host"
		)
		pods = ready_pods(self.runtime, selector)
		if len(pods) != 1:
			raise RuntimeError(f"node drain requires one Ready Host: {pods}")
		old = pods[0]
		self.original_compute_node = old["spec"]["nodeName"]
		self.create_transient_compute_node()
		self.runtime.run(
			"drain",
			self.original_compute_node,
			"--ignore-daemonsets",
			"--delete-emptydir-data",
			f"--timeout={int(self.args.timeout)}s",
			timeout=self.args.timeout + 30,
		)
		wait_for_host_on_node(
			self.runtime,
			selector,
			old["metadata"]["uid"],
			self.transient_kube_node,
			self.args.timeout,
		)
		self.runtime.run("uncordon", self.original_compute_node)
		self.advance("node-drain")
		self.faults.append("compute_node_drain")

	def interrupted_retry(self):
		token = f"{self.run_id}:ambiguous-response"
		timed_out = False
		try:
			self.fetch("/slow-increment", method="POST", token=token, timeout=0.5)
		except (TimeoutError, socket.timeout, urllib.error.URLError, ConnectionError):
			timed_out = True
		if not timed_out:
			raise RuntimeError("slow mutation returned a response instead of creating ambiguity")
		# The Worker starts its five-second delay only after the SQLite write is
		# acknowledged. Leave enough time for that branch, then remove the Host
		# before any response can reach the disconnected caller.
		time.sleep(1)
		self.restart_host("host_replacement_during_ambiguous_response")
		target = self.expected + 1
		deadline = time.monotonic() + self.args.timeout
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.fetch("/increment", method="POST", token=token)
				if last.get("value") == target:
					if last.get("replayed") is not True:
						raise RuntimeError(
							"ambiguous first execution was not durably committed before retry"
						)
					self.expected = target
					self.read_value()
					self.assert_identity("ambiguous-response-retry")
					self.faults.append("idempotent_retry_after_lost_response")
					return last
			except (
				TransientRequestError,
				TimeoutError,
				socket.timeout,
				urllib.error.URLError,
				ConnectionError,
			) as error:
				last = str(error)
			time.sleep(0.25)
		raise TimeoutError(f"ambiguous mutation did not converge exactly once: {last}")

	def concurrent_serialization(self, count=8):
		start = self.expected
		with concurrent.futures.ThreadPoolExecutor(max_workers=count) as executor:
			responses = list(
				executor.map(
					lambda index: self.fetch(
						"/increment",
						method="POST",
						token=f"{self.run_id}:burst:{index}",
					),
					range(count),
				)
			)
		values = sorted(item["value"] for item in responses)
		expected_values = list(range(start + 1, start + count + 1))
		if values != expected_values:
			raise RuntimeError(
				f"concurrent Durable Object mutations were not serialized: {values}"
			)
		if any(item.get("replayed") is not False for item in responses):
			raise RuntimeError(f"fresh concurrent mutation unexpectedly replayed: {responses}")
		self.expected += count
		self.read_value()
		self.assert_identity("concurrent-serialization")

	def restore_transient_node(self):
		if self.original_compute_node:
			try:
				self.runtime.run("uncordon", self.original_compute_node)
			except Exception:
				pass
		if self.transient_kube_node:
			selector = (
				f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host"
			)
			pods = ready_pods(self.runtime, selector)
			if (
				self.original_compute_node
				and len(pods) == 1
				and pods[0]["spec"].get("nodeName") == self.transient_kube_node
			):
				old = pods[0]
				self.runtime.run(
					"drain",
					self.transient_kube_node,
					"--ignore-daemonsets",
					"--delete-emptydir-data",
					f"--timeout={int(self.args.timeout)}s",
					timeout=self.args.timeout + 30,
				)
				wait_for_host_on_node(
					self.runtime,
					selector,
					old["metadata"]["uid"],
					self.original_compute_node,
					self.args.timeout,
				)
		if self.transient_k3d_node:
			name = self.transient_kube_node or self.transient_k3d_node
			result = subprocess.run(
				["k3d", "node", "delete", name],
				text=True,
				capture_output=True,
				timeout=self.args.timeout,
			)
			if result.returncode:
				raise RuntimeError(f"delete temporary k3d node {name}: {result.stderr.strip()}")
		if self.transient_kube_node:
			self.runtime.run(
				"delete", "node", self.transient_kube_node, "--ignore-not-found", "--wait=true"
			)
		self.transient_k3d_node = None
		self.transient_kube_node = None

	def cleanup_actor(self):
		if self.actor_id is None:
			return
		base.request_json(
			"DELETE",
			f"{self.engine}/actors/{urllib.parse.quote(self.actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
		)

	def run(self):
		self.start()
		version_id, deployment_id = self.upload_and_deploy()
		self.advance("baseline")
		self.sleep_wake()
		self.restart_host("workerd_host_replacement_fdb_client_reconnect")
		self.advance("after-host-replacement")
		self.rollout(
			self.runtime,
			f"{self.args.cell}-engine",
			f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=engine",
			1,
			"engine_restart_fdb_client_reconnect",
			self.engine_forward,
		)
		self.advance("after-engine-restart")
		self.rollout(
			self.hub_registry,
			"worker-registry",
			"app.kubernetes.io/name=worker-registry",
			3,
			"registry_restart_fdb_client_reconnect",
		)
		self.advance("after-registry-restart")
		self.rollout(
			self.hub_api,
			"workers-api",
			"app.kubernetes.io/name=workers-api",
			3,
			"workers_api_three_replica_restart",
			self.api_forward,
		)
		self.advance("after-api-restart")
		self.node_drain()
		self.interrupted_retry()
		self.concurrent_serialization()
		return {
			"schema": "rivet-workerd-durable-chaos-e2e/v1",
			"status": "PASS",
			"worker": WORKER,
			"version_id": version_id,
			"deployment_id": deployment_id,
			"object_id": self.object_id,
			"actor_id": self.actor_id,
			"final_counter": self.expected,
			"faults": self.faults,
			"identity_checks": self.identity_checks,
			"http_semantics": "at-least-once with caller-provided idempotency key",
		}


def main():
	qualification = Qualification(parse_args())

	def cleanup():
		errors = []
		try:
			qualification.restore_transient_node()
		except Exception as error:
			errors.append(f"node cleanup: {error}")
		try:
			qualification.cleanup_actor()
		except Exception as error:
			errors.append(f"Actor cleanup: {error}")
		qualification.engine_forward.stop()
		qualification.api_forward.stop()
		return errors

	try:
		result = qualification.run()
	except BaseException:
		cleanup_errors = cleanup()
		if cleanup_errors:
			print("; ".join(cleanup_errors), file=sys.stderr)
		raise
	cleanup_errors = cleanup()
	if cleanup_errors:
		raise RuntimeError("; ".join(cleanup_errors))
	print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
	main()
