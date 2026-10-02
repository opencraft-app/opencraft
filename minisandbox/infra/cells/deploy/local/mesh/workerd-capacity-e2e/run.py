#!/usr/bin/env python3
"""Qualify capacity-aware workerd placement against one idle runtime Cell."""

import argparse
import contextlib
import dataclasses
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


NAMESPACE = "actor-fdb-cell-system"
ACTOR_NAMESPACE = "default"
TEST_ACTOR_NAME = "workerd-counter"


def request_json(method, url, body=None, headers=None, timeout=20):
	data = None if body is None else json.dumps(body).encode()
	request = urllib.request.Request(url, data=data, method=method)
	if data is not None:
		request.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		request.add_header(name, value)
	try:
		with urllib.request.urlopen(request, timeout=timeout) as response:
			payload = response.read()
	except urllib.error.HTTPError as error:
		payload = error.read().decode(errors="replace")
		raise RuntimeError(f"{method} {url} returned HTTP {error.code}: {payload}") from error
	return json.loads(payload) if payload else {}


def actor_error_name(value):
	if isinstance(value, str):
		return value.lower()
	if isinstance(value, dict) and len(value) == 1:
		return str(next(iter(value))).lower()
	return None


def validate_exact_owners(owners, actor_ids, host_labels):
	expected = set(actor_ids)
	if set(owners) != expected:
		raise RuntimeError(
			f"registry ownership mismatch: expected={sorted(expected)}, observed={owners}"
		)
	valid_hosts = set(host_labels)
	for actor_id, labels in owners.items():
		if len(labels) != 1 or labels[0] not in valid_hosts:
			raise RuntimeError(f"Actor {actor_id} has invalid registry owners {labels}")


def validate_packing_trajectory(trajectory, host_labels, capacity):
	if len(trajectory) != capacity * len(host_labels):
		raise RuntimeError("packing trajectory does not cover total advertised capacity")
	for point in trajectory:
		for label in host_labels:
			active = point["counts"].get(label)
			if not isinstance(active, int) or not 0 <= active <= capacity:
				raise RuntimeError(f"placement trajectory exceeded Host capacity: {point}")
	final_counts = trajectory[-1]["counts"]
	if any(final_counts.get(label) != capacity for label in host_labels):
		raise RuntimeError(f"final placement did not fill both Hosts exactly: {final_counts}")
	# A random ring sample can contain only one of the two Envoys even when K > 1.
	# The scoring reducer's bin-pack choice is covered exhaustively in Rust; this
	# deployed gate records the stochastic trajectory and asserts only physical
	# invariants. Choose the first Host that reaches its ceiling as the release
	# target so the pending Actor has exactly one reusable slot.
	first_full = next(
		point
		for point in trajectory
		if any(point["counts"].get(label) == capacity for label in host_labels)
	)
	packed_host = next(
		label for label in host_labels if first_full["counts"].get(label) == capacity
	)
	spill_host = next(label for label in host_labels if label != packed_host)
	return packed_host, spill_host


def validate_host_capacity(stats, capacity):
	for label, value in stats.items():
		if value.get("host_max_active_actors") != capacity:
			raise RuntimeError(
				f"Host {label} advertised capacity {value.get('host_max_active_actors')}, "
				f"expected {capacity}"
			)
		active = value.get("host_active_actors")
		if not isinstance(active, int) or active < 0 or active > capacity:
			raise RuntimeError(f"Host {label} exceeded capacity: {active}/{capacity}")


def free_local_port():
	with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as listener:
		listener.bind(("127.0.0.1", 0))
		return listener.getsockname()[1]


class Kubectl:
	def __init__(self, kubeconfig, namespace=NAMESPACE):
		self.kubeconfig = kubeconfig
		self.namespace = namespace

	def run(self, *arguments, timeout=120, input_text=None):
		command = [
			"kubectl",
			"--kubeconfig",
			str(self.kubeconfig),
			"-n",
			self.namespace,
			*arguments,
		]
		result = subprocess.run(
			command,
			input=input_text,
			text=True,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			timeout=timeout,
		)
		if result.returncode != 0:
			raise RuntimeError(
				f"command failed ({result.returncode}): {' '.join(command)}\n{result.stderr}"
			)
		return result.stdout

	def json(self, *arguments, timeout=120):
		return json.loads(self.run(*arguments, "-o", "json", timeout=timeout))


class PortForward:
	def __init__(self, kubectl, resource, remote_port):
		self.kubectl = kubectl
		self.resource = resource
		self.remote_port = remote_port
		self.local_port = free_local_port()
		self.process = None
		self.log = tempfile.TemporaryFile(mode="w+")

	@property
	def base_url(self):
		return f"http://127.0.0.1:{self.local_port}"

	def start(self, timeout=30):
		if self.process is not None:
			raise RuntimeError(f"port-forward for {self.resource} already started")
		command = [
			"kubectl",
			"--kubeconfig",
			str(self.kubectl.kubeconfig),
			"-n",
			self.kubectl.namespace,
			"port-forward",
			self.resource,
			f"{self.local_port}:{self.remote_port}",
		]
		self.process = subprocess.Popen(command, stdout=self.log, stderr=subprocess.STDOUT)
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			if self.process.poll() is not None:
				break
			with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as client:
				client.settimeout(0.2)
				if client.connect_ex(("127.0.0.1", self.local_port)) == 0:
					return
			time.sleep(0.1)
		self.log.seek(0)
		raise RuntimeError(f"port-forward for {self.resource} failed:\n{self.log.read()}")

	def stop(self):
		if self.process is None:
			return
		if self.process.poll() is None:
			self.process.terminate()
			try:
				self.process.wait(timeout=5)
			except subprocess.TimeoutExpired:
				self.process.kill()
				self.process.wait(timeout=5)
		self.process = None


@dataclasses.dataclass
class Actor:
	actor_id: str
	key: str
	generation: int = 0


@dataclasses.dataclass
class Host:
	label: str
	pod: str
	uid: str
	node: str
	forward: PortForward

	def stats(self, token):
		return request_json(
			"GET",
			f"{self.forward.base_url}/v1/sqlite/stats",
			headers={"x-rivet-workerd-token": token},
		)

	def lookup(self, token, actor_ids, generation):
		return request_json(
			"POST",
			f"{self.forward.base_url}/v1/sqlite/registry-lookup",
			{
				"actors": [
					{"actor_id": actor_id, "generation": generation}
					for actor_id in actor_ids
				]
			},
			headers={"x-rivet-workerd-token": token},
		)


class Harness:
	def __init__(self, args):
		self.args = args
		self.kubectl = Kubectl(args.kubeconfig)
		self.statefulset = f"{args.cell}-runtime-hosts"
		self.deployment = f"{args.cell}-engine"
		self.configmap = f"{args.cell}-runtime-config"
		self.secret = f"{args.cell}-runtime-auth"
		self.engine_forward = None
		self.hosts = []
		self.actors = []
		self.original_replicas = None
		self.original_host_env = None
		self.original_config = None
		self.token = None
		self.run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
		self.evidence = {
			"schema": "rivet-workerd-capacity-e2e/v1",
			"cell": args.cell,
			"capacity_per_host": args.capacity,
			"started_at_unix_ms": int(time.time() * 1000),
			"phases": {},
		}

	@property
	def engine_url(self):
		return self.engine_forward.base_url

	def actor_url(self, actor_id, suffix=""):
		return f"{self.engine_url}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

	def capture_original_state(self):
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		self.original_replicas = statefulset["spec"]["replicas"]
		containers = statefulset["spec"]["template"]["spec"]["containers"]
		container_index = next(
			(index for index, container in enumerate(containers) if container["name"] == "workerd-host"),
			None,
		)
		if container_index is None:
			raise RuntimeError("workerd-host container is missing")
		self.original_host_env = (container_index, containers[container_index].get("env", []))
		configmap = self.kubectl.json("get", "configmap", self.configmap)
		self.original_config = configmap["data"]["config.jsonc"]
		token = self.kubectl.run(
			"get", "secret", self.secret, "-o", "jsonpath={.data.token}"
		).strip()
		import base64

		self.token = base64.b64decode(token).decode()
		if len(self.token) != 64:
			raise RuntimeError("runtime auth token is not the expected 64-byte hex token")

	def configure_allocator(self):
		config = json.loads(self.original_config)
		pegboard = config.setdefault("pegboard", {})
		# Make the ordinary retry far longer than the assertion window. Capacity
		# reuse therefore proves that gateway demand expedited this exact Actor;
		# it cannot pass by accidentally waiting for the background retry tick.
		pegboard["base_retry_timeout"] = 10_000
		pegboard["envoy_load_balancer"] = {
			"hash": {
				"virtual_nodes": 64,
				"samples": 8,
				"max_scan": 64,
				"slot_jitter": 0,
				"use_snapshot_read": True,
			}
		}
		patch = json.dumps({"data": {"config.jsonc": json.dumps(config)}})
		self.kubectl.run("patch", "configmap", self.configmap, "--type=merge", "-p", patch)
		self.kubectl.run("rollout", "restart", f"deployment/{self.deployment}")
		self.kubectl.run(
			"rollout", "status", f"deployment/{self.deployment}", "--timeout=5m", timeout=330
		)

	def scale_hosts(self):
		# Capacity qualification needs Actors to remain resident until the explicit
		# release and Host-loss phases. Product auto-sleep is qualified separately.
		self.kubectl.run(
			"set",
			"env",
			f"statefulset/{self.statefulset}",
			"--containers=workerd-host",
			"RIVET_WORKERD_IDLE_SLEEP_MS=0",
		)
		self.kubectl.run(
			"scale", f"statefulset/{self.statefulset}", f"--replicas={self.args.hosts}"
		)
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)

	def list_host_pods(self):
		payload = self.kubectl.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host",
		)
		pods = []
		for item in payload["items"]:
			ready = any(
				condition.get("type") == "Ready" and condition.get("status") == "True"
				for condition in item.get("status", {}).get("conditions", [])
			)
			if ready:
				pods.append(
					(
						item["metadata"]["name"],
						item["metadata"]["uid"],
						item["spec"]["nodeName"],
					)
				)
		pods.sort()
		if len(pods) != self.args.hosts:
			raise RuntimeError(f"expected {self.args.hosts} Ready workerd Pods, got {pods}")
		return pods

	def scheduling_evidence(self, pods):
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		spec = statefulset["spec"]["template"]["spec"]
		node_selector = spec.get("nodeSelector", {})
		affinity = spec.get("affinity", {})
		requires_compute = node_selector.get("rivet.dev/compute") == "true" or any(
			expression.get("key") == "rivet.dev/compute"
			and expression.get("operator") == "In"
			and "true" in expression.get("values", [])
			for term in affinity.get("nodeAffinity", {})
			.get("requiredDuringSchedulingIgnoredDuringExecution", {})
			.get("nodeSelectorTerms", [])
			for expression in term.get("matchExpressions", [])
		)
		if not requires_compute:
			raise RuntimeError("workerd StatefulSet does not require compute nodes")
		tolerates_compute = any(
			item.get("key") == "rivet.dev/compute"
			and item.get("value") == "true"
			and item.get("effect") == "NoSchedule"
			for item in spec.get("tolerations", [])
		)
		if not tolerates_compute:
			raise RuntimeError("workerd StatefulSet does not tolerate the compute-node taint")

		nodes = {}
		for _, _, node_name in pods:
			node = self.kubectl.json("get", "node", node_name)
			labels = node["metadata"].get("labels", {})
			if labels.get("rivet.dev/compute") != "true":
				raise RuntimeError(f"workerd Pod escaped onto non-compute node {node_name}")
			if labels.get("rivet.dev/control") == "true":
				raise RuntimeError(f"workerd Pod shares control identity on node {node_name}")
			nodes[node_name] = labels

		anti_affinity = affinity.get("podAntiAffinity", {}).get(
			"requiredDuringSchedulingIgnoredDuringExecution", []
		)
		return {
			"requires_compute_node": True,
			"tolerates_compute_taint": True,
			"required_pod_anti_affinity": bool(anti_affinity),
			"pod_nodes": {pod: node for pod, _, node in pods},
			"distinct_nodes": len(nodes),
		}

	def start_forwards(self):
		self.engine_forward = PortForward(self.kubectl, f"service/{self.args.cell}-engine", 6420)
		self.engine_forward.start()
		self.hosts = []
		pods = self.list_host_pods()
		self.evidence["scheduling"] = self.scheduling_evidence(pods)
		for index, (pod, uid, node) in enumerate(pods):
			forward = PortForward(self.kubectl, f"pod/{pod}", 18081)
			forward.start()
			self.hosts.append(Host(f"host-{index}", pod, uid, node, forward))

	def stop_forwards(self):
		for host in self.hosts:
			host.forward.stop()
		self.hosts = []
		if self.engine_forward is not None:
			self.engine_forward.stop()
			self.engine_forward = None

	def read_stats(self):
		stats = {host.label: host.stats(self.token) for host in self.hosts}
		validate_host_capacity(stats, self.args.capacity)
		return stats

	def wait_empty(self):
		deadline = time.monotonic() + self.args.settle_timeout
		last = None
		while time.monotonic() < deadline:
			last = self.read_stats()
			if all(
				value["host_active_actors"] == 0 and value["bridge_active_actors"] == 0
				for value in last.values()
			):
				return last
			time.sleep(0.25)
		raise TimeoutError(f"workerd Hosts were not empty: {last}")

	def create_actor(self, suffix):
		key = f"capacity-e2e-{self.run_id}-{suffix}"
		created = request_json(
			"POST",
			f"{self.engine_url}/actors?{urllib.parse.urlencode({'namespace': ACTOR_NAMESPACE})}",
			{
				"name": TEST_ACTOR_NAME,
				"key": key,
				"runner_name_selector": "workerd",
				"crash_policy": "restart",
			},
			timeout=self.args.request_timeout,
		)
		actor = Actor(created["actor"]["actor_id"], key)
		self.actors.append(actor)
		return actor

	def control(self, actor):
		payload = request_json(
			"GET",
			f"{self.engine_url}/actors?{urllib.parse.urlencode({'namespace': ACTOR_NAMESPACE, 'actor_ids': actor.actor_id})}",
			timeout=self.args.request_timeout,
		)
		actors = payload.get("actors", [])
		return actors[0] if actors else None

	def wait_pending_no_envoys(self, actor):
		deadline = time.monotonic() + self.args.actor_timeout
		last = None
		while time.monotonic() < deadline:
			last = self.control(actor)
			if last is not None and actor_error_name(last.get("error")) == "no_envoys":
				if last.get("connectable_ts") is not None:
					raise RuntimeError("capacity-exhausted Actor became connectable")
				return last
			time.sleep(0.25)
		raise TimeoutError(f"Actor did not enter no_envoys pending state: {last}")

	def ownership(self, actors):
		actor_ids = [actor.actor_id for actor in actors]
		owners = {actor_id: [] for actor_id in actor_ids}
		generations = {}
		for host in self.hosts:
			for generation in range(1, self.args.max_generation + 1):
				payload = host.lookup(self.token, actor_ids, generation)
				entries = payload.get("actors")
				if not isinstance(entries, list) or len(entries) != len(actors):
					raise RuntimeError(f"Host {host.label} returned invalid registry manifest")
				for entry in entries:
					actor_id = entry.get("actor_id")
					if actor_id not in owners or entry.get("generation") != generation:
						raise RuntimeError(f"Host {host.label} returned wrong registry identity: {entry}")
					if entry.get("host_active") != entry.get("bridge_active"):
						raise RuntimeError(f"Host {host.label} registry layers disagree: {entry}")
					if entry.get("host_active"):
						owners[actor_id].append(host.label)
						previous = generations.setdefault(actor_id, generation)
						if previous != generation:
							raise RuntimeError(
								f"Actor {actor_id} has multiple active generations: "
								f"{previous}, {generation}"
							)
		for actor in actors:
			if actor.actor_id in generations:
				actor.generation = generations[actor.actor_id]
		return owners

	def wait_ownership(self, actors, timeout=None):
		deadline = time.monotonic() + (timeout or self.args.actor_timeout)
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.ownership(actors)
				validate_exact_owners(last, [actor.actor_id for actor in actors], [h.label for h in self.hosts])
				return last
			except Exception as error:
				last = str(error)
			time.sleep(0.25)
		raise TimeoutError(f"registry ownership did not converge: {last}")

	def delete_actor(self, actor):
		request_json(
			"DELETE",
			f"{self.engine_url}/actors/{urllib.parse.quote(actor.actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
			timeout=self.args.request_timeout,
		)

	def wait_actor_absent(self, actor):
		deadline = time.monotonic() + self.args.actor_timeout
		while time.monotonic() < deadline:
			control = self.control(actor)
			if control is None or control.get("destroy_ts") is not None:
				return
			time.sleep(0.25)
		raise TimeoutError(f"Actor {actor.actor_id} was not destroyed")

	def request_wake(self, actor):
		"""Issue real gateway demand; ownership, not the HTTP payload, is the assertion."""
		def request():
			try:
				with urllib.request.urlopen(
					self.actor_url(actor.actor_id), timeout=self.args.actor_timeout
				) as response:
					response.read(1)
			except Exception:
				# The synthetic capacity Actor has no application-response contract. A
				# gateway error after dispatch does not invalidate the lifecycle wake.
				pass

		thread = threading.Thread(target=request, daemon=True)
		thread.start()
		return thread

	def replace_host(self, label):
		host = next(host for host in self.hosts if host.label == label)
		old_uid = host.uid
		host.forward.stop()
		self.kubectl.run("delete", "pod", host.pod, "--wait=false")
		deadline = time.monotonic() + self.args.failure_timeout
		new_uid = None
		while time.monotonic() < deadline:
			try:
				pod = self.kubectl.json("get", "pod", host.pod)
				ready = any(
					condition.get("type") == "Ready" and condition.get("status") == "True"
					for condition in pod.get("status", {}).get("conditions", [])
				)
				if ready and pod["metadata"]["uid"] != old_uid:
					new_uid = pod["metadata"]["uid"]
					break
			except Exception:
				pass
			time.sleep(1)
		if new_uid is None:
			raise TimeoutError(f"replacement Pod for {host.pod} did not become Ready")
		host.uid = new_uid
		host.forward = PortForward(self.kubectl, f"pod/{host.pod}", 18081)
		host.forward.start()
		return old_uid, new_uid

	def run(self):
		self.capture_original_state()
		self.configure_allocator()
		self.scale_hosts()
		self.start_forwards()
		baseline = self.wait_empty()
		self.evidence["phases"]["baseline"] = {
			"stats": baseline,
			"background_retry_timeout_ms": 10_000,
			"pods": [{"label": host.label, "pod": host.pod, "uid": host.uid} for host in self.hosts],
		}

		live = []
		trajectory = []
		for index in range(self.args.capacity * self.args.hosts):
			actor = self.create_actor(f"placed-{index}")
			live.append(actor)
			owners = self.wait_ownership(live)
			counts = {host.label: 0 for host in self.hosts}
			for labels in owners.values():
				counts[labels[0]] += 1
			trajectory.append(
				{
					"actors": len(live),
					"new_actor_id": actor.actor_id,
					"new_actor_owner": owners[actor.actor_id][0],
					"counts": counts,
				}
			)
		owners = self.wait_ownership(live)
		packed_host, spill_host = validate_packing_trajectory(
			trajectory, [host.label for host in self.hosts], self.args.capacity
		)
		full_stats = self.read_stats()
		if any(value["host_active_actors"] != self.args.capacity for value in full_stats.values()):
			raise RuntimeError(f"both Hosts were not exactly full: {full_stats}")
		self.evidence["phases"]["packed_and_spilled"] = {
			"packed_host": packed_host,
			"spill_host": spill_host,
			"trajectory": trajectory,
			"owners": owners,
			"stats": full_stats,
		}

		pending = self.create_actor("pending-full")
		pending_control = self.wait_pending_no_envoys(pending)
		self.evidence["phases"]["full_rejection"] = {
			"actor_id": pending.actor_id,
			"error": pending_control.get("error"),
			"stats": self.read_stats(),
		}

		released = next(actor for actor in live if owners[actor.actor_id] == [packed_host])
		self.delete_actor(released)
		self.wait_actor_absent(released)
		self.actors.remove(released)
		live.remove(released)
		wake_started = time.monotonic()
		wake_request = self.request_wake(pending)
		live.append(pending)
		owners = self.wait_ownership(live, timeout=8)
		wake_duration_ms = (time.monotonic() - wake_started) * 1000
		wake_request.join(timeout=1)
		if owners[pending.actor_id] != [packed_host]:
			raise RuntimeError(
				f"pending Actor did not reuse released capacity on {packed_host}: "
				f"{owners[pending.actor_id]}"
			)
		self.evidence["phases"]["released_and_reused"] = {
			"deleted_actor_id": released.actor_id,
			"recovered_actor_id": pending.actor_id,
			"recovered_owner": owners[pending.actor_id][0],
			"same_actor_recovered": True,
			"wake_duration_ms": wake_duration_ms,
			"background_retry_timeout_ms": 10_000,
			"stats": self.read_stats(),
		}

		old_uid, new_uid = self.replace_host(spill_host)
		recovered_owners = self.wait_ownership(live, timeout=self.args.failure_timeout)
		recovered_stats = self.read_stats()
		if any(value["host_active_actors"] > self.args.capacity for value in recovered_stats.values()):
			raise RuntimeError(f"failure recovery exceeded Host capacity: {recovered_stats}")
		self.evidence["phases"]["failure_recovery"] = {
			"replaced_host": spill_host,
			"old_pod_uid": old_uid,
			"new_pod_uid": new_uid,
			"owners": recovered_owners,
			"stats": recovered_stats,
		}
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		cleanup_errors = []
		if self.engine_forward is not None:
			for actor in list(self.actors):
				try:
					self.delete_actor(actor)
				except Exception as error:
					cleanup_errors.append(f"delete {actor.actor_id}: {error}")
			try:
				self.wait_empty()
			except Exception as error:
				cleanup_errors.append(f"wait empty: {error}")
		self.stop_forwards()
		if self.original_config is not None:
			try:
				patch = json.dumps({"data": {"config.jsonc": self.original_config}})
				self.kubectl.run(
					"patch", "configmap", self.configmap, "--type=merge", "-p", patch
				)
				self.kubectl.run("rollout", "restart", f"deployment/{self.deployment}")
				self.kubectl.run(
					"rollout",
					"status",
					f"deployment/{self.deployment}",
					"--timeout=5m",
					timeout=330,
				)
			except Exception as error:
				cleanup_errors.append(f"restore Engine config: {error}")
		if self.original_host_env is not None:
			try:
				container_index, environment = self.original_host_env
				patch = json.dumps(
					[
						{
							"op": "replace",
							"path": (
								f"/spec/template/spec/containers/{container_index}/env"
							),
							"value": environment,
						}
					]
				)
				self.kubectl.run(
					"patch", "statefulset", self.statefulset, "--type=json", "-p", patch
				)
			except Exception as error:
				cleanup_errors.append(f"restore Host environment: {error}")
		if self.original_replicas is not None:
			try:
				self.kubectl.run(
					"scale",
					f"statefulset/{self.statefulset}",
					f"--replicas={self.original_replicas}",
				)
				self.kubectl.run(
					"rollout",
					"status",
					f"statefulset/{self.statefulset}",
					"--timeout=10m",
					timeout=630,
				)
			except Exception as error:
				cleanup_errors.append(f"restore Host replicas: {error}")
		if cleanup_errors:
			self.evidence["cleanup_errors"] = cleanup_errors


def default_output():
	agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return agents_dir / "benchmarks/local-mesh/workerd-capacity-e2e" / f"{stamp}.json"


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--capacity", type=int, default=4)
	parser.add_argument("--hosts", type=int, default=2)
	parser.add_argument("--request-timeout", type=float, default=20)
	parser.add_argument("--actor-timeout", type=float, default=180)
	parser.add_argument("--failure-timeout", type=float, default=300)
	parser.add_argument("--settle-timeout", type=float, default=120)
	parser.add_argument("--max-generation", type=int, default=32)
	parser.add_argument("--output", type=pathlib.Path, default=default_output())
	args = parser.parse_args()
	if not args.kubeconfig.is_file():
		parser.error(f"kubeconfig does not exist: {args.kubeconfig}")
	if args.capacity < 1 or args.capacity > 128:
		parser.error("capacity must be between 1 and 128")
	if args.hosts != 2:
		parser.error("this qualification currently requires exactly two Hosts")
	if args.max_generation < 1 or args.max_generation > 256:
		parser.error("max-generation must be between 1 and 256")
	return args


def write_receipt(path, evidence):
	path.parent.mkdir(parents=True, exist_ok=True)
	temporary = path.with_suffix(path.suffix + ".tmp")
	temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
	os.replace(temporary, path)


def main():
	args = parse_args()
	harness = Harness(args)
	failure = None
	try:
		harness.run()
	except BaseException as error:
		failure = error
		harness.evidence["verdict"] = "failed"
		harness.evidence["error"] = {"type": type(error).__name__, "message": str(error)}
	finally:
		harness.cleanup()
		harness.evidence["finished_at_unix_ms"] = int(time.time() * 1000)
		write_receipt(args.output, harness.evidence)
	print(json.dumps(harness.evidence, indent=2, sort_keys=True))
	print(f"receipt: {args.output}")
	if failure is not None:
		raise failure
	if harness.evidence.get("cleanup_errors"):
		raise RuntimeError("qualification passed but cleanup did not complete")


if __name__ == "__main__":
	main()
