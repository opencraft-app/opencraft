#!/usr/bin/env python3
"""Durable, fail-closed k3d capacity provider used only by local qualification."""

import dataclasses
import json
import os
import pathlib
import signal
import subprocess
import threading
import time


API_VERSION = "local.fleet.actor.dev/v1alpha1"
KIND = "WorkerdCapacityRequest"
RESOURCE = "workerdcapacityrequests"
TERMINAL_PHASES = {"Deleted", "Failed"}
PREPARED_IMAGE_ANNOTATION = "local.fleet.actor.dev/prepared-image"
PREPARING_TAINT_KEY = "local.fleet.actor.dev/preparing"


@dataclasses.dataclass(frozen=True)
class Snapshot:
	phase: str
	desired_replicas: int
	ordinal: int
	pod_identity: str
	node_exists: bool
	node_ready: bool
	node_cordoned: bool
	node_busy: bool


def decide(snapshot):
	"""Return the only safe next action for one durable capacity request."""
	if snapshot.phase in TERMINAL_PHASES:
		return "None"
	if snapshot.pod_identity == "Replaced":
		return "Fail"
	if snapshot.phase == "Pending":
		if snapshot.desired_replicas <= snapshot.ordinal or snapshot.pod_identity == "Absent":
			return "MarkDeleted"
		return "Provision"
	if snapshot.phase == "Provisioning":
		if snapshot.desired_replicas <= snapshot.ordinal or snapshot.pod_identity == "Absent":
			return "BeginDrain" if snapshot.node_exists else "MarkDeleted"
		if not snapshot.node_exists:
			return "Provision"
		return "MarkReady" if snapshot.node_ready else "None"
	if snapshot.phase == "Ready":
		if not snapshot.node_exists:
			return "Fail"
		if snapshot.desired_replicas <= snapshot.ordinal:
			return "BeginDrain"
		return "Restore" if snapshot.node_cordoned else "None"
	if snapshot.phase == "Draining":
		if snapshot.desired_replicas > snapshot.ordinal:
			return "Restore"
		if not snapshot.node_exists:
			return "MarkDeleted"
		if not snapshot.node_cordoned:
			return "Cordon"
		if snapshot.pod_identity != "Absent" or snapshot.node_busy:
			return "None"
		return "Delete"
	if snapshot.phase == "Deleting":
		# Once deletion has removed the Node, finish this request. A replacement
		# Pending Pod will produce a new request instead of entering Ready without
		# backing capacity.
		if not snapshot.node_exists:
			return "MarkDeleted"
		if snapshot.desired_replicas > snapshot.ordinal:
			return "Restore"
		if not snapshot.node_cordoned:
			return "Cordon"
		if snapshot.pod_identity != "Absent" or snapshot.node_busy:
			return "None"
		return "Delete"
	return "Fail"


def can_rebind_replacement_pod(previous_request, pod, node, node_name, ordinal, run_id):
	"""Allow a new request only when an aborted drain kept the exact provider Node."""
	if previous_request is None or previous_request.get("status", {}).get("phase") != "Failed":
		return False
	previous_spec = previous_request.get("spec", {})
	previous_status = previous_request.get("status", {})
	return (
		previous_spec.get("ordinal") == ordinal
		and previous_spec.get("nodeName") == node_name
		and previous_spec.get("podRef", {}).get("name") == pod.get("metadata", {}).get("name")
		and pod.get("spec", {}).get("nodeName") == node_name
		and node is not None
		and previous_status.get("nodeUID") == node.get("metadata", {}).get("uid")
		and node.get("metadata", {}).get("labels", {}).get(
			"local.fleet.actor.dev/provider-run-id"
		)
		== run_id
	)


def terminate_process_group(process):
	if process.poll() is not None:
		return
	try:
		os.killpg(process.pid, signal.SIGTERM)
	except ProcessLookupError:
		return
	try:
		process.wait(timeout=2)
		return
	except subprocess.TimeoutExpired:
		pass
	try:
		os.killpg(process.pid, signal.SIGKILL)
	except ProcessLookupError:
		return
	process.wait(timeout=2)


def run_command(arguments, timeout=300, input_text=None, cancel_event=None):
	command = [str(argument) for argument in arguments]
	if cancel_event is not None and cancel_event.is_set():
		raise RuntimeError(f"command cancelled before start: {' '.join(command)}")
	process = subprocess.Popen(
		command,
		stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
		text=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		start_new_session=True,
	)
	if input_text is not None:
		try:
			process.stdin.write(input_text)
		finally:
			process.stdin.close()
			process.stdin = None
	deadline = time.monotonic() + timeout
	while True:
		if cancel_event is not None and cancel_event.is_set():
			terminate_process_group(process)
			stdout, stderr = process.communicate()
			raise RuntimeError(f"command cancelled: {' '.join(command)}\n{stderr}")
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			terminate_process_group(process)
			stdout, stderr = process.communicate()
			raise TimeoutError(f"command timed out: {' '.join(command)}\n{stderr}")
		try:
			stdout, stderr = process.communicate(timeout=min(0.25, remaining))
			break
		except subprocess.TimeoutExpired:
			continue
	if process.returncode != 0:
		raise RuntimeError(
			f"command failed ({process.returncode}): {' '.join(command)}\n{stderr}"
		)
	return stdout


class Provider:
	def __init__(
		self,
		*,
		kubeconfig,
		cluster,
		namespace,
		cell,
		statefulset,
		runtime_image,
		run_id,
		interval=0.5,
	):
		self.kubeconfig = pathlib.Path(kubeconfig)
		self.cluster = cluster
		self.namespace = namespace
		self.cell = cell
		self.statefulset = statefulset
		self.runtime_image = runtime_image
		self.run_id = run_id
		self.interval = interval
		self.stop_event = threading.Event()
		self.thread = None
		self.last_error = None
		self.reconcile_errors = 0
		self.image_imports = 0

	def kubectl(self, *arguments, timeout=120, input_text=None, namespaced=False):
		command = ["kubectl", "--kubeconfig", str(self.kubeconfig)]
		if namespaced:
			command.extend(["-n", self.namespace])
		command.extend(arguments)
		return self.command(command, timeout=timeout, input_text=input_text)

	def command(self, arguments, timeout=300, input_text=None):
		return run_command(
			arguments,
			timeout=timeout,
			input_text=input_text,
			cancel_event=self.stop_event,
		)

	def json(self, *arguments, namespaced=False, timeout=120):
		return json.loads(self.kubectl(*arguments, "-o", "json", namespaced=namespaced, timeout=timeout))

	def start(self):
		if self.thread is not None:
			raise RuntimeError("capacity provider already started")
		self.thread = threading.Thread(target=self._run, name="workerd-capacity-provider", daemon=True)
		self.thread.start()

	def stop(self):
		self.stop_event.set()
		if self.thread is not None:
			self.thread.join(timeout=10)
			if self.thread.is_alive():
				raise RuntimeError("capacity provider did not stop")
		self.thread = None

	def _run(self):
		while not self.stop_event.is_set():
			try:
				self.reconcile_once()
				self.last_error = None
			except Exception as error:
				if self.stop_event.is_set():
					break
				# Observation failures produce no capacity mutation. The next pass can
				# recover from the request's durable phase.
				self.last_error = str(error)
				self.reconcile_errors += 1
			self.stop_event.wait(self.interval)

	def requests(self):
		payload = self.json(
			"get",
			RESOURCE,
			"-l",
			f"local.fleet.actor.dev/run-id={self.run_id}",
			namespaced=True,
		)
		return payload.get("items", [])

	def request(self):
		items = sorted(
			self.requests(),
			key=lambda item: (
				item.get("metadata", {}).get("creationTimestamp", ""),
				item.get("metadata", {}).get("name", ""),
			),
		)
		active = [
			item
			for item in items
			if item.get("status", {}).get("phase", "Pending") not in TERMINAL_PHASES
		]
		if len(active) > 1:
			raise RuntimeError(f"provider observed {len(active)} active requests for one run")
		return active[0] if active else (items[-1] if items else None)

	def reconcile_once(self):
		request = self.request()
		if request is None or request.get("status", {}).get("phase") in TERMINAL_PHASES:
			self.discover_request(previous_request=request)
			return
		spec = request.get("spec", {})
		if (
			spec.get("cluster") != self.cluster
			or spec.get("cell") != self.cell
			or spec.get("runID") != self.run_id
			or spec.get("workloadRef", {}).get("name") != self.statefulset
		):
			self.transition(request, "Failed", "request identity does not match provider scope")
			return
		statefulset = self.json("get", "statefulset", self.statefulset, namespaced=True)
		if spec.get("workloadRef", {}).get("uid") != statefulset["metadata"]["uid"]:
			self.transition(request, "Failed", "StatefulSet UID changed")
			return
		ordinal = spec.get("ordinal")
		if not isinstance(ordinal, int) or ordinal < 1:
			self.transition(request, "Failed", "invalid requested ordinal")
			return
		node_name = spec.get("nodeName")
		if node_name != f"k3d-workerd-provider-{self.run_id}-{ordinal}-0":
			self.transition(request, "Failed", "node identity is outside the run scope")
			return
		if spec.get("podRef", {}).get("name") != f"{self.statefulset}-{ordinal}":
			self.transition(request, "Failed", "Pod name does not match requested ordinal")
			return
		pod_identity = self.pod_identity(spec.get("podRef", {}))
		node = self.maybe_json("get", "node", node_name)
		expected_node_uid = request.get("status", {}).get("nodeUID")
		if node is not None and node.get("metadata", {}).get("labels", {}).get(
			"local.fleet.actor.dev/provider-run-id"
		) != self.run_id:
			self.transition(request, "Failed", "provider Node is not owned by this run")
			return
		if node is not None and expected_node_uid not in (None, node["metadata"]["uid"]):
			self.transition(request, "Failed", "provider Node UID changed")
			return
		phase = request.get("status", {}).get("phase", "Pending")
		desired_replicas = statefulset["spec"]["replicas"]
		needs_busy_observation = (
			node is not None
			and phase in ("Draining", "Deleting")
			and desired_replicas <= ordinal
			and pod_identity == "Absent"
		)
		snapshot = Snapshot(
			phase=phase,
			desired_replicas=desired_replicas,
			ordinal=ordinal,
			pod_identity=pod_identity,
			node_exists=node is not None,
			node_ready=node is not None and node_ready(node),
			node_cordoned=node is not None and bool(node.get("spec", {}).get("unschedulable")),
			node_busy=needs_busy_observation and self.node_busy(node_name),
		)
		action = decide(snapshot)
		if action == "Provision":
			self.transition(request, "Provisioning", "durably accepted exact Pending Pod demand")
			self.ensure_node(ordinal, node_name)
		elif action == "MarkReady":
			# A crash may occur after k3d creates the Node but before its taint and
			# runtime image are installed. Replay all idempotent configuration before
			# granting Ready capacity.
			self.ensure_node(ordinal, node_name)
			node = self.json("get", "node", node_name)
			self.transition(
				request, "Ready", "provider Node is Ready", node_uid=node["metadata"]["uid"]
			)
		elif action == "BeginDrain":
			self.transition(request, "Draining", "workload demand fell; waiting for exact Pod removal")
			if node is not None:
				self.kubectl("cordon", node_name)
		elif action == "Cordon":
			self.kubectl("cordon", node_name)
		elif action == "Restore":
			if node is not None:
				self.kubectl("uncordon", node_name)
			self.transition(request, "Ready", "scale-up returned while node retirement was pending")
		elif action == "Delete":
			self.transition(request, "Deleting", "node is empty and exact workload Pod is absent")
			self.delete_node(node_name, ordinal=ordinal, expected_node_uid=expected_node_uid)
		elif action == "MarkDeleted":
			self.transition(request, "Deleted", "provider Node and Kubernetes Node are absent")
		elif action == "Fail":
			self.transition(request, "Failed", "request evidence changed; refusing provider mutation")

	def discover_request(self, previous_request=None):
		statefulset = self.json("get", "statefulset", self.statefulset, namespaced=True)
		pods = self.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={self.cell},fleet.actor.dev/component=workerd-host",
			namespaced=True,
		).get("items", [])
		for pod in sorted(pods, key=lambda item: item["metadata"]["name"]):
			owners = pod["metadata"].get("ownerReferences", [])
			if not any(
				owner.get("kind") == "StatefulSet"
				and owner.get("name") == self.statefulset
				and owner.get("uid") == statefulset["metadata"]["uid"]
				for owner in owners
			):
				continue
			ordinal = pod_ordinal(self.statefulset, pod["metadata"]["name"])
			if statefulset["spec"]["replicas"] <= ordinal:
				continue
			short = f"workerd-provider-{self.run_id}-{ordinal}"
			node_name = f"k3d-{short}-0"
			if not pod_unschedulable(pod):
				node = self.maybe_json("get", "node", node_name)
				if not can_rebind_replacement_pod(
					previous_request, pod, node, node_name, ordinal, self.run_id
				):
					continue
			request = {
				"apiVersion": API_VERSION,
				"kind": KIND,
				"metadata": {
					"generateName": f"workerd-{self.run_id}-{ordinal}-",
					"namespace": self.namespace,
					"labels": {"local.fleet.actor.dev/run-id": self.run_id},
				},
				"spec": {
					"runID": self.run_id,
					"cluster": self.cluster,
					"cell": self.cell,
					"ordinal": ordinal,
					"nodeName": node_name,
					"workloadRef": {
						"name": self.statefulset,
						"uid": statefulset["metadata"]["uid"],
					},
					"podRef": {
						"name": pod["metadata"]["name"],
						"uid": pod["metadata"]["uid"],
					},
				},
			}
			created = json.loads(
				self.kubectl(
					"create",
					"-f",
					"-",
					"-o",
					"json",
					namespaced=True,
					input_text=json.dumps(request),
				)
			)
			self.transition(created, "Pending", "observed exact unschedulable workerd Pod")
			return

	def pod_identity(self, reference):
		pod = self.maybe_json("get", "pod", reference.get("name", ""), namespaced=True)
		if pod is None:
			return "Absent"
		return "Exact" if pod["metadata"]["uid"] == reference.get("uid") else "Replaced"

	def maybe_json(self, *arguments, namespaced=False):
		try:
			return self.json(*arguments, namespaced=namespaced)
		except RuntimeError as error:
			if "NotFound" in str(error):
				return None
			raise

	def transition(self, request, phase, reason, node_uid=None):
		status = request.get("status", {})
		if status.get("phase") == phase:
			return
		history = list(status.get("history", []))[-31:]
		now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
		history.append({"phase": phase, "at": now, "reason": reason})
		updated_status = {
			"observedGeneration": request["metadata"]["generation"],
			"phase": phase,
			"reason": reason,
			"lastTransitionTime": now,
			"history": history,
		}
		persisted_node_uid = node_uid or status.get("nodeUID")
		if persisted_node_uid:
			updated_status["nodeUID"] = persisted_node_uid
		patch = {
			"metadata": {"resourceVersion": request["metadata"]["resourceVersion"]},
			"status": updated_status,
		}
		self.kubectl(
			"patch",
			RESOURCE,
			request["metadata"]["name"],
			"--subresource=status",
			"--type=merge",
			"-p",
			json.dumps(patch),
			namespaced=True,
		)

	def ensure_node(self, ordinal, node_name):
		short = f"workerd-provider-{self.run_id}-{ordinal}"
		if node_name not in self.k3d_nodes():
			self.command(
				[
					"k3d",
					"node",
					"create",
					short,
					"--cluster",
					self.cluster,
					"--role",
					"agent",
					"--k3s-node-label",
					f"local.fleet.actor.dev/provider-run-id={self.run_id}",
					"--k3s-arg",
					f"--node-taint={PREPARING_TAINT_KEY}=true:NoSchedule",
					"--wait",
					"--timeout",
					"5m",
				],
				timeout=330,
			)
		node = self.maybe_json("get", "node", node_name)
		if node is None:
			raise RuntimeError(f"created provider Node did not register: {node_name}")
		if node.get("metadata", {}).get("labels", {}).get(
			"local.fleet.actor.dev/provider-run-id"
		) != self.run_id:
			raise RuntimeError(f"refusing to adopt unowned provider Node {node_name}")
		self.kubectl("cordon", node_name)
		annotations = node.get("metadata", {}).get("annotations", {})
		if annotations.get(PREPARED_IMAGE_ANNOTATION) != self.runtime_image:
			if node.get("metadata", {}).get("labels", {}).get("rivet.dev/compute") is not None:
				self.kubectl("label", "node", node_name, "rivet.dev/compute-")
			self.command(["k3d", "image", "import", self.runtime_image, "--cluster", self.cluster])
			self.image_imports += 1
			self.kubectl(
				"annotate",
				"node",
				node_name,
				f"{PREPARED_IMAGE_ANNOTATION}={self.runtime_image}",
				"--overwrite",
			)
		self.kubectl("taint", "node", node_name, "rivet.dev/compute=true:NoSchedule", "--overwrite")
		self.kubectl("label", "node", node_name, "rivet.dev/compute=true", "--overwrite")
		node = self.json("get", "node", node_name)
		if any(taint.get("key") == PREPARING_TAINT_KEY for taint in node.get("spec", {}).get("taints", [])):
			self.kubectl("taint", "node", node_name, f"{PREPARING_TAINT_KEY}-")
		self.kubectl("uncordon", node_name)

	def delete_node(self, node_name, *, ordinal=None, expected_node_uid=None):
		node = self.maybe_json("get", "node", node_name)
		if node is not None:
			if node.get("metadata", {}).get("labels", {}).get(
				"local.fleet.actor.dev/provider-run-id"
			) != self.run_id:
				raise RuntimeError(f"refusing to delete unowned provider Node {node_name}")
			if expected_node_uid is not None and node["metadata"]["uid"] != expected_node_uid:
				raise RuntimeError(f"refusing to delete replacement provider Node {node_name}")
			self.kubectl("cordon", node_name)
		if ordinal is not None:
			statefulset = self.json("get", "statefulset", self.statefulset, namespaced=True)
			if statefulset["spec"]["replicas"] > ordinal:
				raise RuntimeError("scale-up returned before provider Node deletion")
		if self.node_busy(node_name):
			raise RuntimeError(f"refusing to delete busy provider Node {node_name}")
		if node_name in self.k3d_nodes():
			self.command(["k3d", "node", "delete", node_name], timeout=180)
		if node_name in self.k3d_nodes():
			raise RuntimeError(f"k3d provider Node still exists after deletion: {node_name}")
		self.kubectl("delete", "node", node_name, "--ignore-not-found")

	def node_busy(self, node_name):
		pods = self.json(
			"get", "pods", "-A", "--field-selector", f"spec.nodeName={node_name}"
		).get("items", [])
		for pod in pods:
			if pod.get("status", {}).get("phase") in ("Succeeded", "Failed"):
				continue
			if pod.get("metadata", {}).get("annotations", {}).get("kubernetes.io/config.mirror"):
				continue
			if any(owner.get("kind") == "DaemonSet" for owner in pod["metadata"].get("ownerReferences", [])):
				continue
			return True
		return False

	def k3d_nodes(self):
		payload = json.loads(self.command(["k3d", "node", "list", "-o", "json"]))
		return {
			item["name"]
			for item in payload
			if item.get("runtimeLabels", {}).get("k3d.cluster") == self.cluster
		}


def node_ready(node):
	return any(
		condition.get("type") == "Ready" and condition.get("status") == "True"
		for condition in node.get("status", {}).get("conditions", [])
	)


def pod_unschedulable(pod):
	return any(
		condition.get("type") == "PodScheduled"
		and condition.get("status") == "False"
		and condition.get("reason") == "Unschedulable"
		for condition in pod.get("status", {}).get("conditions", [])
	)


def pod_ordinal(statefulset, pod):
	prefix = statefulset + "-"
	if not pod.startswith(prefix):
		raise ValueError(f"Pod {pod} is not owned by StatefulSet {statefulset}")
	ordinal = int(pod[len(prefix) :])
	if ordinal < 0:
		raise ValueError(f"invalid Pod ordinal: {pod}")
	return ordinal
