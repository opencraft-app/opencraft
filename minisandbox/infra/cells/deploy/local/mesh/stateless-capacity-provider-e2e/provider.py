#!/usr/bin/env python3
"""Fail-closed k3d stateless-node provider used only by local qualification."""

import dataclasses
import json
import os
import pathlib
import signal
import subprocess
import threading
import time


API_VERSION = "local.fleet.actor.dev/v1alpha1"
KIND = "StatelessCapacityRequest"
RESOURCE = "statelesscapacityrequests"
TERMINAL_PHASES = {"Deleted", "Failed"}
STARTUP_TAINT_KEY = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"
PREPARED_IMAGE_ANNOTATION = "local.fleet.actor.dev/stateless-runtime-image-id"
RUN_LABEL = "local.fleet.actor.dev/stateless-provider-run-id"


@dataclasses.dataclass(frozen=True)
class Snapshot:
	phase: str
	desired_replicas: int
	pod_identity: str
	node_exists: bool
	node_ready: bool
	node_admitted: bool
	node_cordoned: bool
	node_busy: bool


def decide(snapshot: Snapshot) -> str:
	"""Return the sole safe next mutation for one immutable capacity request."""
	if snapshot.phase in TERMINAL_PHASES:
		return "None"
	if snapshot.pod_identity == "Replaced":
		return "Fail"
	if snapshot.phase == "Pending":
		if snapshot.desired_replicas < 2 or snapshot.pod_identity == "Absent":
			return "MarkDeleted"
		return "Provision"
	if snapshot.phase == "Provisioning":
		if snapshot.desired_replicas < 2 or snapshot.pod_identity == "Absent":
			return "BeginDrain" if snapshot.node_exists else "MarkDeleted"
		if not snapshot.node_exists:
			return "Provision"
		if snapshot.node_ready and snapshot.node_admitted:
			return "MarkReady"
		return "Prepare"
	if snapshot.phase == "Ready":
		if not snapshot.node_exists:
			return "Fail"
		if snapshot.pod_identity == "Absent":
			return "Fail"
		if snapshot.desired_replicas < 2:
			return "BeginDrain"
		return "Restore" if snapshot.node_cordoned else "None"
	if snapshot.phase in {"Draining", "Deleting"}:
		if not snapshot.node_exists:
			return "MarkDeleted"
		if snapshot.desired_replicas >= 2:
			return "Restore" if snapshot.pod_identity == "Exact" else "Fail"
		if not snapshot.node_cordoned:
			return "Cordon"
		if snapshot.pod_identity != "Absent" or snapshot.node_busy:
			return "None"
		return "Delete"
	return "Fail"


def terminate_process_group(process: subprocess.Popen) -> None:
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
			_, stderr = process.communicate()
			raise RuntimeError(f"command cancelled: {' '.join(command)}\n{stderr}")
		remaining = deadline - time.monotonic()
		if remaining <= 0:
			terminate_process_group(process)
			_, stderr = process.communicate()
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
		deployment,
		runtime_image,
		runtime_image_id,
		run_id,
		interval=0.5,
	):
		self.kubeconfig = pathlib.Path(kubeconfig)
		self.cluster = cluster
		self.namespace = namespace
		self.cell = cell
		self.deployment = deployment
		self.runtime_image = runtime_image
		self.runtime_image_id = runtime_image_id
		self.run_id = run_id
		self.interval = interval
		self.node_name = f"k3d-stateless-provider-{run_id}-0"
		self.stop_event = threading.Event()
		self.thread = None
		self.last_error = None
		self.reconcile_errors = 0
		self.image_imports = 0

	def command(self, arguments, timeout=300, input_text=None):
		return run_command(
			arguments,
			timeout=timeout,
			input_text=input_text,
			cancel_event=self.stop_event,
		)

	def kubectl(self, *arguments, timeout=120, input_text=None, namespaced=False):
		command = ["kubectl", "--kubeconfig", str(self.kubeconfig)]
		if namespaced:
			command.extend(["-n", self.namespace])
		command.extend(arguments)
		return self.command(command, timeout=timeout, input_text=input_text)

	def json(self, *arguments, namespaced=False, timeout=120):
		return json.loads(self.kubectl(
			*arguments, "-o", "json", namespaced=namespaced, timeout=timeout
		))

	def maybe_json(self, *arguments, namespaced=False):
		try:
			return self.json(*arguments, namespaced=namespaced)
		except RuntimeError as error:
			if "NotFound" in str(error):
				return None
			raise

	def start(self):
		if self.thread is not None:
			raise RuntimeError("stateless capacity provider already started")
		self.thread = threading.Thread(
			target=self._run, name="stateless-capacity-provider", daemon=True
		)
		self.thread.start()

	def stop(self):
		self.stop_event.set()
		if self.thread is not None:
			self.thread.join(timeout=10)
			if self.thread.is_alive():
				raise RuntimeError("stateless capacity provider did not stop")
		self.thread = None

	def _run(self):
		while not self.stop_event.is_set():
			try:
				self.reconcile_once()
				self.last_error = None
			except Exception as error:
				if self.stop_event.is_set():
					break
				self.last_error = str(error)
				self.reconcile_errors += 1
			self.stop_event.wait(self.interval)

	def requests(self):
		return self.json(
			"get", RESOURCE, "-l", f"local.fleet.actor.dev/run-id={self.run_id}",
			namespaced=True,
		).get("items", [])

	def request(self):
		items = sorted(
			self.requests(),
			key=lambda item: (
				item.get("metadata", {}).get("creationTimestamp", ""),
				item.get("metadata", {}).get("name", ""),
			),
		)
		active = [
			item for item in items
			if item.get("status", {}).get("phase", "Pending") not in TERMINAL_PHASES
		]
		if len(active) > 1:
			raise RuntimeError(f"provider observed {len(active)} active requests for one run")
		return active[0] if active else (items[-1] if items else None)

	def reconcile_once(self):
		request = self.request()
		if request is None or request.get("status", {}).get("phase") in TERMINAL_PHASES:
			self.discover_request()
			return
		deployment = self.json("get", "deployment", self.deployment, namespaced=True)
		spec = request.get("spec", {})
		if (
			spec.get("runID") != self.run_id
			or spec.get("cluster") != self.cluster
			or spec.get("cell") != self.cell
			or spec.get("nodeName") != self.node_name
			or spec.get("runtimeImageID") != self.runtime_image_id
			or spec.get("workloadRef", {}).get("kind") != "Deployment"
			or spec.get("workloadRef", {}).get("name") != self.deployment
			or spec.get("workloadRef", {}).get("uid") != deployment["metadata"]["uid"]
		):
			self.transition(request, "Failed", "request identity does not match provider scope")
			return
		pod_identity = self.pod_identity(spec.get("podRef", {}))
		node = self.maybe_json("get", "node", self.node_name)
		expected_uid = request.get("status", {}).get("nodeUID")
		if node is not None:
			labels = node.get("metadata", {}).get("labels", {})
			if labels.get(RUN_LABEL) != self.run_id:
				self.transition(request, "Failed", "provider Node is outside this run")
				return
			if expected_uid not in (None, node["metadata"]["uid"]):
				self.transition(request, "Failed", "provider Node UID changed")
				return
		phase = request.get("status", {}).get("phase", "Pending")
		desired = int(deployment["spec"].get("replicas", 0))
		snapshot = Snapshot(
			phase=phase,
			desired_replicas=desired,
			pod_identity=pod_identity,
			node_exists=node is not None,
			node_ready=node is not None and node_ready(node),
			node_admitted=node is not None and node_admitted(node, self.runtime_image_id),
			node_cordoned=node is not None and bool(node.get("spec", {}).get("unschedulable")),
			node_busy=(
				node is not None and phase in {"Draining", "Deleting"}
				and desired < 2 and pod_identity == "Absent" and self.node_busy(self.node_name)
			),
		)
		action = decide(snapshot)
		if action == "Provision":
			self.transition(request, "Provisioning", "accepted exact unschedulable Pod demand")
			self.ensure_node()
		elif action == "Prepare":
			self.ensure_node()
		elif action == "MarkReady":
			self.ensure_node()
			node = self.json("get", "node", self.node_name)
			self.transition(
				request, "Ready", "exact runtime image admitted", node_uid=node["metadata"]["uid"]
			)
		elif action == "BeginDrain":
			self.transition(request, "Draining", "replica demand fell; waiting for Pod drain")
			if node is not None:
				self.kubectl("cordon", self.node_name)
		elif action == "Cordon":
			self.kubectl("cordon", self.node_name)
		elif action == "Restore":
			self.ensure_node()
			self.transition(request, "Ready", "scale-up returned before retirement")
		elif action == "Delete":
			self.transition(request, "Deleting", "owned Node is empty after Pod drain")
			self.delete_node(expected_node_uid=expected_uid)
		elif action == "MarkDeleted":
			self.transition(request, "Deleted", "provider and Kubernetes Node are absent")
		elif action == "Fail":
			self.transition(request, "Failed", "identity evidence changed; refusing mutation")

	def discover_request(self):
		deployment = self.json("get", "deployment", self.deployment, namespaced=True)
		if int(deployment["spec"].get("replicas", 0)) < 2:
			return
		pods = self.json(
			"get", "pods", "-l",
			f"fleet.actor.dev/cell-name={self.cell},fleet.actor.dev/component=stateless-executor",
			namespaced=True,
		).get("items", [])
		for pod in sorted(pods, key=lambda item: item["metadata"]["name"]):
			if not pod_unschedulable(pod) or not self.owned_by_deployment(pod, deployment):
				continue
			request = {
				"apiVersion": API_VERSION,
				"kind": KIND,
				"metadata": {
					"generateName": f"stateless-{self.run_id}-",
					"namespace": self.namespace,
					"labels": {"local.fleet.actor.dev/run-id": self.run_id},
				},
				"spec": {
					"runID": self.run_id,
					"cluster": self.cluster,
					"cell": self.cell,
					"nodeName": self.node_name,
					"runtimeImageID": self.runtime_image_id,
					"workloadRef": {
						"kind": "Deployment",
						"name": self.deployment,
						"uid": deployment["metadata"]["uid"],
					},
					"podRef": {
						"name": pod["metadata"]["name"],
						"uid": pod["metadata"]["uid"],
					},
				},
			}
			created = json.loads(self.kubectl(
				"create", "-f", "-", "-o", "json", namespaced=True,
				input_text=json.dumps(request),
			))
			self.transition(created, "Pending", "observed exact unschedulable stateless Pod")
			return

	def owned_by_deployment(self, pod, deployment):
		for owner in pod.get("metadata", {}).get("ownerReferences", []):
			if owner.get("kind") != "ReplicaSet":
				continue
			replica_set = self.maybe_json("get", "replicaset", owner.get("name", ""), namespaced=True)
			if replica_set is None or replica_set["metadata"]["uid"] != owner.get("uid"):
				return False
			return any(
				parent.get("kind") == "Deployment"
				and parent.get("name") == self.deployment
				and parent.get("uid") == deployment["metadata"]["uid"]
				for parent in replica_set.get("metadata", {}).get("ownerReferences", [])
			)
		return False

	def pod_identity(self, reference):
		pod = self.maybe_json("get", "pod", reference.get("name", ""), namespaced=True)
		if pod is None:
			return "Absent"
		return "Exact" if pod["metadata"]["uid"] == reference.get("uid") else "Replaced"

	def transition(self, request, phase, reason, node_uid=None):
		status = request.get("status", {})
		if status.get("phase") == phase:
			return
		now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
		history = list(status.get("history", []))[-31:]
		history.append({"phase": phase, "at": now, "reason": reason})
		updated = {
			"observedGeneration": request["metadata"]["generation"],
			"phase": phase,
			"reason": reason,
			"lastTransitionTime": now,
			"history": history,
		}
		persisted_uid = node_uid or status.get("nodeUID")
		if persisted_uid:
			updated["nodeUID"] = persisted_uid
		patch = {
			"metadata": {"resourceVersion": request["metadata"]["resourceVersion"]},
			"status": updated,
		}
		self.kubectl(
			"patch", RESOURCE, request["metadata"]["name"], "--subresource=status",
			"--type=merge", "-p", json.dumps(patch), namespaced=True,
		)

	def ensure_node(self):
		short = f"stateless-provider-{self.run_id}"
		if self.node_name not in self.k3d_nodes():
			self.command([
				"k3d", "node", "create", short, "--cluster", self.cluster, "--role", "agent",
				"--runtime-label", f"{RUN_LABEL}={self.run_id}",
				"--k3s-node-label", f"{RUN_LABEL}={self.run_id}",
				"--wait", "--timeout", "5m",
			], timeout=330)
		node = self.maybe_json("get", "node", self.node_name)
		if node is None:
			raise RuntimeError(f"created provider Node did not register: {self.node_name}")
		if node.get("metadata", {}).get("labels", {}).get(RUN_LABEL) != self.run_id:
			raise RuntimeError(f"refusing to adopt unowned provider Node {self.node_name}")
		self.kubectl("cordon", self.node_name)
		# k3d persists cluster agent arguments and may inherit the baseline
		# node's local ownership label and taints.  Do not duplicate those on
		# `node create`; normalize the registered Node while it is cordoned.
		self.remove_labels(
			"rivet.dev/compute", "rivet.dev/control", "local.fleet.actor.dev/stateless-base"
		)
		self.remove_taint("rivet.dev/compute")
		node = self.json("get", "node", self.node_name)
		prepared = node.get("metadata", {}).get("annotations", {}).get(PREPARED_IMAGE_ANNOTATION)
		if prepared != self.runtime_image_id:
			self.kubectl(
				"taint", "node", self.node_name,
				f"{STARTUP_TAINT_KEY}=pending:NoSchedule", "--overwrite",
			)
			self.remove_labels("fleet.actor.dev/stateless-admitted")
			self.command(["k3d", "image", "import", self.runtime_image, "--cluster", self.cluster])
			self.image_imports += 1
			self.kubectl(
				"annotate", "node", self.node_name,
				f"{PREPARED_IMAGE_ANNOTATION}={self.runtime_image_id}", "--overwrite",
			)
		self.kubectl(
			"taint", "node", self.node_name, "rivet.dev/stateless=true:NoSchedule", "--overwrite",
		)
		self.kubectl(
			"label", "node", self.node_name, "rivet.dev/stateless=true",
			"fleet.actor.dev/stateless-admitted=true", "--overwrite",
		)
		self.remove_taint(STARTUP_TAINT_KEY)
		self.kubectl("uncordon", self.node_name)

	def remove_labels(self, *keys):
		for key in keys:
			try:
				self.kubectl("label", "node", self.node_name, f"{key}-")
			except RuntimeError as error:
				if "not found" not in str(error).lower():
					raise

	def remove_taint(self, key):
		try:
			self.kubectl("taint", "node", self.node_name, f"{key}-")
		except RuntimeError as error:
			if "not found" not in str(error).lower():
				raise

	def delete_node(self, *, expected_node_uid=None):
		node = self.maybe_json("get", "node", self.node_name)
		if node is not None:
			if node.get("metadata", {}).get("labels", {}).get(RUN_LABEL) != self.run_id:
				raise RuntimeError(f"refusing to delete unowned provider Node {self.node_name}")
			if expected_node_uid is not None and node["metadata"]["uid"] != expected_node_uid:
				raise RuntimeError(f"refusing to delete replacement Node {self.node_name}")
			self.kubectl("cordon", self.node_name)
		deployment = self.json("get", "deployment", self.deployment, namespaced=True)
		if int(deployment["spec"].get("replicas", 0)) >= 2:
			raise RuntimeError("scale-up returned before provider Node deletion")
		if self.node_busy(self.node_name):
			raise RuntimeError(f"refusing to delete busy provider Node {self.node_name}")
		if self.node_name in self.k3d_nodes():
			container = json.loads(self.command(["docker", "inspect", self.node_name]))[0]
			labels = container.get("Config", {}).get("Labels", {})
			if (
				labels.get(RUN_LABEL) != self.run_id
				or labels.get("k3d.cluster") != self.cluster
			):
				raise RuntimeError(f"refusing to delete unowned provider container {self.node_name}")
			self.command(["k3d", "node", "delete", self.node_name], timeout=180)
		if self.node_name in self.k3d_nodes():
			raise RuntimeError(f"k3d provider Node remains after deletion: {self.node_name}")
		self.kubectl("delete", "node", self.node_name, "--ignore-not-found")

	def node_busy(self, node_name):
		pods = self.json(
			"get", "pods", "-A", "--field-selector", f"spec.nodeName={node_name}"
		).get("items", [])
		for pod in pods:
			if pod.get("status", {}).get("phase") in {"Succeeded", "Failed"}:
				continue
			if pod.get("metadata", {}).get("annotations", {}).get("kubernetes.io/config.mirror"):
				continue
			if any(
				owner.get("kind") == "DaemonSet"
				for owner in pod.get("metadata", {}).get("ownerReferences", [])
			):
				continue
			return True
		return False

	def k3d_nodes(self):
		payload = json.loads(self.command(["k3d", "node", "list", "-o", "json"]))
		return {
			item["name"] for item in payload
			if item.get("runtimeLabels", {}).get("k3d.cluster") == self.cluster
		}


def node_ready(node):
	return any(
		condition.get("type") == "Ready" and condition.get("status") == "True"
		for condition in node.get("status", {}).get("conditions", [])
	)


def node_admitted(node, image_id):
	metadata = node.get("metadata", {})
	labels = metadata.get("labels", {})
	annotations = metadata.get("annotations", {})
	taints = node.get("spec", {}).get("taints", [])
	return (
		labels.get("rivet.dev/stateless") == "true"
		and labels.get("fleet.actor.dev/stateless-admitted") == "true"
		and annotations.get(PREPARED_IMAGE_ANNOTATION) == image_id
		and all(taint.get("key") != STARTUP_TAINT_KEY for taint in taints)
	)


def pod_unschedulable(pod):
	return any(
		condition.get("type") == "PodScheduled"
		and condition.get("status") == "False"
		and condition.get("reason") == "Unschedulable"
		for condition in pod.get("status", {}).get("conditions", [])
	)
