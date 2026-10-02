#!/usr/bin/env python3
"""Prove HPA -> CapacityRequest -> k3d Node -> lossless Host drain locally."""

import argparse
import importlib.util
import json
import os
import pathlib
import time
import uuid


HERE = pathlib.Path(__file__).resolve().parent


def load_module(name, path):
	spec = importlib.util.spec_from_file_location(name, path)
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


provider_module = load_module("workerd_capacity_provider", HERE / "provider.py")
happy = load_module("workerd_host_drain_e2e", HERE.parent / "workerd-host-drain-e2e" / "run.py")
autoscaling = happy.autoscaling
capacity = happy.capacity

NAMESPACE = happy.NAMESPACE
CONTROLLER_NAME = happy.CONTROLLER_NAME
CRD_NAME = "workerdcapacityrequests.local.fleet.actor.dev"


class Harness(happy.Harness):
	def __init__(self, args):
		super().__init__(args)
		self.provider = None
		self.provider_run_id = uuid.uuid4().hex[:8]
		self.crd_installed = False
		self.request_evidence = None
		self.provider_reconcile_errors_before_restart = 0
		self.provider_image_imports_before_restart = 0
		self.evidence = {
			"schema": "rivet-workerd-capacity-provider-e2e/v1",
			"cell": args.cell,
			"cluster": args.cluster,
			"capacity_per_host": args.capacity,
			"provider_run_id": self.provider_run_id,
			"started_at_unix_ms": int(time.time() * 1000),
			"phases": {},
		}

	def preflight_provider(self):
		# The autoscaling preflight checks the HPA/custom-metrics names and records
		# the exact original Engine, StatefulSet and affinity state.
		self.preflight()
		try:
			self.kubectl.run("get", "deployment", CONTROLLER_NAME)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing Deployment {CONTROLLER_NAME}")
		try:
			self.kubectl_all("get", "customresourcedefinition", CRD_NAME)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing test CRD {CRD_NAME}")
		stale = sorted(name for name in self.k3d_nodes() if name.startswith("k3d-workerd-provider-"))
		if stale:
			raise RuntimeError(f"refusing to adopt stale provider Nodes: {stale}")
		compute_nodes = set(self.compute_nodes())
		k3d_nodes = self.k3d_nodes()
		if not compute_nodes.issubset(k3d_nodes):
			raise RuntimeError(
				"kubeconfig and --cluster do not identify the same k3d cluster: "
				f"compute_nodes={sorted(compute_nodes)}, k3d_nodes={sorted(k3d_nodes)}"
			)

	def install_provider(self):
		self.kubectl_all("create", "-f", str(HERE / "crd.yaml"))
		self.crd_installed = True
		self.kubectl_all(
			"wait",
			"--for=condition=Established",
			f"customresourcedefinition/{CRD_NAME}",
			"--timeout=60s",
		)
		self.provider = self.new_provider()
		self.provider.start()

	def new_provider(self):
		return provider_module.Provider(
			kubeconfig=self.args.kubeconfig,
			cluster=self.args.cluster,
			namespace=NAMESPACE,
			cell=self.args.cell,
			statefulset=self.statefulset,
			runtime_image=self.runtime_image,
			run_id=self.provider_run_id,
		)

	def restart_provider(self):
		before = self.provider.request()
		self.provider.stop()
		self.provider_reconcile_errors_before_restart += self.provider.reconcile_errors
		self.provider_image_imports_before_restart += self.provider.image_imports
		self.provider = self.new_provider()
		self.provider.start()
		after = self.wait_request_phase("Ready")
		return {"before": before, "after": after}

	def wait_request_phase(self, phases, timeout=None):
		if isinstance(phases, str):
			phases = {phases}
		else:
			phases = set(phases)
		deadline = time.monotonic() + (timeout or self.args.provider_timeout)
		last = None
		while time.monotonic() < deadline:
			last = self.provider.request()
			if last is not None and last.get("status", {}).get("phase") in phases:
				self.request_evidence = last
				return last
			time.sleep(0.25)
		raise TimeoutError(
			f"CapacityRequest did not reach {sorted(phases)}: request={last}, "
			f"provider_error={self.provider.last_error}"
		)

	def assert_request_identity_immutable(self, request):
		patch = {"spec": {"cell": f"{self.args.cell}-mutated"}}
		try:
			self.kubectl.run(
				"patch",
				provider_module.RESOURCE,
				request["metadata"]["name"],
				"--type=merge",
				"-p",
				json.dumps(patch),
			)
		except RuntimeError as error:
			if "CapacityRequest identity is immutable" not in str(error):
				raise RuntimeError(f"unexpected CapacityRequest mutation rejection: {error}") from error
			return str(error)
		raise RuntimeError("Kubernetes accepted a mutable CapacityRequest identity")

	def run(self):
		self.preflight_provider()
		self.configure_allocator()
		self.patch_required_anti_affinity()
		self.install_adapter()
		self.install_hpa()
		self.install_provider()
		self.start_engine_forward()
		self.refresh_hosts(1)
		baseline = self.wait_empty()
		self.evidence["phases"]["baseline"] = {
			"compute_nodes": self.compute_nodes(),
			"hosts": [{"pod": host.pod, "uid": host.uid, "node": host.node} for host in self.hosts],
			"stats": baseline,
		}

		live = []
		for index in range(self.args.capacity):
			live.append(self.create_actor(f"provider-fill-{index}"))
			self.wait_ownership(live)
		pending_actor = self.create_actor("provider-pending")
		live.append(pending_actor)
		pending_control = self.wait_pending_no_envoys(pending_actor)
		hpa = self.wait_hpa_replicas(2)
		ready_request = self.wait_request_phase("Ready")
		immutability_rejection = self.assert_request_identity_immutable(ready_request)
		self.refresh_hosts(2)
		owners = self.wait_ownership(live, timeout=self.args.actor_timeout)
		target = max(self.hosts, key=lambda host: happy.ordinal(host.pod))
		request_node = ready_request["spec"]["nodeName"]
		if target.node != request_node:
			raise RuntimeError(f"new Host landed on {target.node}, request owns {request_node}")
		if owners[pending_actor.actor_id] != [target.label]:
			raise RuntimeError(f"pending Actor did not spill to provider Host: {owners}")
		self.evidence["phases"]["scale_up"] = {
			"hpa": hpa.get("status", {}),
			"pending_actor_id": pending_actor.actor_id,
			"pending_actor_error": pending_control.get("error"),
			"capacity_request": ready_request,
			"identity_mutation_rejected": "CapacityRequest identity is immutable"
			in immutability_rejection,
			"owners": owners,
			"compute_nodes": self.compute_nodes(),
		}
		self.evidence["phases"]["provider_restart"] = self.restart_provider()

		keep_ids, migrating_actor = happy.retained_actor_set(live, owners, target.label)
		for actor in list(live):
			if actor.actor_id in keep_ids:
				continue
			self.delete_actor(actor)
			self.wait_actor_absent(actor)
			self.actors.remove(actor)
			live.remove(actor)
		owners_before = self.wait_ownership(live)
		before = capacity.request_json(
			"POST",
			self.actor_url(migrating_actor.actor_id, "/increment"),
			timeout=self.args.request_timeout,
		)
		if before.get("count") != 1:
			raise RuntimeError(f"pre-drain durable counter was not committed: {before}")

		self.install_controller()
		drain_states = self.wait_serial_scale_down(target)
		deleted_request = self.wait_request_phase("Deleted")
		self.refresh_hosts(1)
		owners_after = self.wait_ownership(live, timeout=self.args.actor_timeout)
		after = capacity.request_json(
			"GET", self.actor_url(migrating_actor.actor_id), timeout=self.args.request_timeout
		)
		if after.get("count") != before["count"] or after.get("generation", 0) <= before.get(
			"generation", 0
		):
			raise RuntimeError(f"actor did not migrate losslessly: before={before}, after={after}")
		if any(labels != ["host-0"] for labels in owners_after.values()):
			raise RuntimeError(f"actors did not converge on retained Host: {owners_after}")
		if len(self.compute_nodes()) != 1:
			raise RuntimeError("provider did not remove exactly one empty compute Node")
		self.evidence["phases"]["scale_down"] = {
			"drain_states": drain_states,
			"owners_before": owners_before,
			"owners_after": owners_after,
			"durable_counter_before": before,
			"durable_counter_after": after,
			"capacity_request": deleted_request,
			"compute_nodes": self.compute_nodes(),
		}

		# A terminal request must not make the provider one-shot. Drive the same
		# ordinal through a second scale-up and require a fresh request and Node UID.
		for index in range(len(live), self.args.capacity):
			actor = self.create_actor(f"provider-refill-{index}")
			live.append(actor)
			self.wait_ownership(live)
		repeat_pending = self.create_actor("provider-repeat-pending")
		live.append(repeat_pending)
		repeat_pending_control = self.wait_pending_no_envoys(repeat_pending)
		repeat_hpa = self.wait_hpa_replicas(2)
		repeat_request = self.wait_request_phase("Ready")
		self.refresh_hosts(2)
		repeat_owners = self.wait_ownership(live, timeout=self.args.actor_timeout)
		if repeat_request["metadata"]["name"] == deleted_request["metadata"]["name"]:
			raise RuntimeError("repeat scale-up reused the terminal CapacityRequest")
		if repeat_request.get("status", {}).get("nodeUID") == deleted_request.get("status", {}).get(
			"nodeUID"
		):
			raise RuntimeError("repeat scale-up did not create a new provider Node identity")
		self.evidence["phases"]["repeat_scale_up"] = {
			"hpa": repeat_hpa.get("status", {}),
			"pending_actor_id": repeat_pending.actor_id,
			"pending_actor_error": repeat_pending_control.get("error"),
			"capacity_request": repeat_request,
			"owners": repeat_owners,
			"compute_nodes": self.compute_nodes(),
		}
		provider_image_imports = self.provider_image_imports_before_restart + self.provider.image_imports
		if provider_image_imports != 2:
			raise RuntimeError(
				f"expected one image import for each of two provider Nodes, got {provider_image_imports}"
			)
		self.evidence["provider_image_imports"] = provider_image_imports
		self.evidence["provider_reconcile_errors"] = (
			self.provider_reconcile_errors_before_restart + self.provider.reconcile_errors
		)
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		cleanup_errors = []
		provider_stopped = self.provider is None
		if self.hpa_installed:
			try:
				self.kubectl.run("delete", "horizontalpodautoscaler", self.hpa, "--ignore-not-found")
			except Exception as error:
				cleanup_errors.append(f"delete HPA: {error}")
			self.hpa_installed = False
		try:
			super().cleanup()
		except Exception as error:
			cleanup_errors.append(f"base cleanup: {error}")

		if self.provider is not None:
			try:
				request = self.wait_request_phase({"Deleted", "Failed"}, timeout=180)
				self.request_evidence = request
			except Exception as error:
				cleanup_errors.append(f"settle provider: {error}")
			if self.request_evidence is not None and self.request_evidence.get("status", {}).get(
				"phase"
			) == "Failed":
				try:
					node_name = self.request_evidence["spec"]["nodeName"]
					if self.provider.maybe_json("get", "node", node_name) is not None:
						self.provider.delete_node(
							node_name,
							ordinal=self.request_evidence["spec"]["ordinal"],
							expected_node_uid=self.request_evidence.get("status", {}).get("nodeUID"),
						)
				except Exception as error:
					cleanup_errors.append(f"delete failed-request Node: {error}")
			try:
				self.provider.stop()
				self.evidence["provider_reconcile_errors"] = (
					self.provider_reconcile_errors_before_restart + self.provider.reconcile_errors
				)
				self.evidence["provider_image_imports"] = (
					self.provider_image_imports_before_restart + self.provider.image_imports
				)
			except Exception as error:
				cleanup_errors.append(f"stop provider: {error}")
			else:
				provider_stopped = True
				self.provider = None
		if self.request_evidence is not None:
			self.evidence["final_capacity_request"] = self.request_evidence

		if self.crd_installed:
			if not provider_stopped:
				cleanup_errors.append("preserve provider CRD because the provider thread is still running")
			else:
				try:
					provider_nodes = sorted(
						name
						for name in self.k3d_nodes()
						if name.startswith(f"k3d-workerd-provider-{self.provider_run_id}-")
					)
					if provider_nodes:
						raise RuntimeError(
							"refusing to delete CRD while owned provider Nodes remain: "
							f"{provider_nodes}"
						)
					requests = json.loads(
						self.kubectl_all("get", provider_module.RESOURCE, "-A", "-o", "json")
					).get("items", [])
					foreign = [
						item["metadata"]["name"]
						for item in requests
						if item.get("spec", {}).get("runID") != self.provider_run_id
					]
					if foreign:
						raise RuntimeError(f"refusing to delete CRD with foreign requests: {foreign}")
					self.kubectl_all(
						"delete", "customresourcedefinition", CRD_NAME, "--ignore-not-found"
					)
				except Exception as error:
					cleanup_errors.append(f"delete provider CRD: {error}")
				else:
					self.crd_installed = False
		if self.adapter_installed:
			try:
				autoscaling.run_command(
					[
						"helm",
						"--kubeconfig",
						str(self.args.kubeconfig),
						"uninstall",
						autoscaling.ADAPTER_RELEASE,
						"--namespace",
						"observability",
					],
					timeout=180,
				)
			except Exception as error:
				cleanup_errors.append(f"uninstall Prometheus Adapter: {error}")
			self.adapter_installed = False
		if cleanup_errors:
			self.evidence.setdefault("cleanup_errors", []).extend(cleanup_errors)


def default_output():
	agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return agents_dir / "benchmarks/local-mesh/workerd-capacity-provider-e2e" / f"{stamp}.json"


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
	parser.add_argument("--cluster", required=True)
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--controller-image", required=True)
	parser.add_argument("--capacity", type=int, default=4)
	parser.add_argument("--request-timeout", type=float, default=20)
	parser.add_argument("--actor-timeout", type=float, default=300)
	parser.add_argument("--failure-timeout", type=float, default=300)
	parser.add_argument("--settle-timeout", type=float, default=180)
	parser.add_argument("--adapter-timeout", type=float, default=180)
	parser.add_argument("--hpa-timeout", type=float, default=300)
	parser.add_argument("--pod-timeout", type=float, default=600)
	parser.add_argument("--provider-timeout", type=float, default=600)
	parser.add_argument("--drain-timeout", type=float, default=300)
	parser.add_argument("--max-generation", type=int, default=32)
	parser.add_argument("--hosts", type=int, default=2)
	parser.add_argument("--output", type=pathlib.Path, default=default_output())
	args = parser.parse_args()
	if not args.kubeconfig.is_file():
		parser.error(f"kubeconfig does not exist: {args.kubeconfig}")
	if not args.cluster.startswith("rivet-runtime-"):
		parser.error("cluster must be an explicit local rivet-runtime-* k3d cluster")
	if args.capacity < 2 or args.capacity > 128:
		parser.error("capacity must be between 2 and 128")
	return args


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
		capacity.write_receipt(args.output, harness.evidence)
	print(json.dumps(harness.evidence, indent=2, sort_keys=True))
	print(f"receipt: {args.output}")
	if failure is not None:
		raise failure
	if harness.evidence.get("cleanup_errors"):
		raise RuntimeError("qualification passed but cleanup did not complete")


if __name__ == "__main__":
	main()
