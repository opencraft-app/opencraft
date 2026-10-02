#!/usr/bin/env python3
"""Qualify stateless load -> HPA -> k3d Node -> admission -> drain -> deletion."""

import argparse
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import tempfile
import time
import urllib.error
import urllib.request
import uuid


HERE = pathlib.Path(__file__).resolve().parent
MESH = HERE.parent
BASE_RUNNER = MESH / "workerd-persistent-code-e2e" / "run.py"
PROVIDER_MODULE = HERE / "provider.py"
NAMESPACE = "actor-stateless-system"
API_NAMESPACE = "workers-api-system"
CELL = "local-runtime-a"
CLUSTER = "rivet-runtime-a"
DEPLOYMENT = f"{CELL}-stateless-executor"
SELECTOR = f"fleet.actor.dev/cell-name={CELL},fleet.actor.dev/component=stateless-executor"
HPA = DEPLOYMENT
CRD_NAME = "statelesscapacityrequests.local.fleet.actor.dev"
ADAPTER_RELEASE = "stateless-capacity-e2e-adapter"
ADAPTER_VERSION = "5.3.0"
ADAPTER_SHA256 = "aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31"
ADAPTER_OCI = "oci://ghcr.io/prometheus-community/charts/prometheus-adapter"
TOKEN_HEADER = "X-Rivet-Stateless-Executor-Token"


def load_module(name, path):
	spec = importlib.util.spec_from_file_location(name, path)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load helper module {path}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_module("workerd_persistent_code_e2e", BASE_RUNNER)
provider_module = load_module("stateless_capacity_provider", PROVIDER_MODULE)


WORKER_SOURCE = r'''
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const delayMs = Number(url.searchParams.get("delay_ms") ?? "0");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 90000) {
      return new Response("invalid delay", { status: 400 });
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return Response.json({ marker: "stateless-capacity-provider-e2e", delayMs });
  }
};
'''.strip()


def run_command(arguments, timeout=300, input_text=None):
	return provider_module.run_command(arguments, timeout=timeout, input_text=input_text)


def request(method, url, body=None, headers=None, expected=(200, 201, 204), timeout=120):
	encoded = None if body is None else json.dumps(body).encode()
	req = urllib.request.Request(url, data=encoded, method=method)
	if encoded is not None:
		req.add_header("content-type", "application/json")
	for name, value in (headers or {}).items():
		req.add_header(name, value)
	try:
		with urllib.request.urlopen(req, timeout=timeout) as response:
			status, payload, response_headers = response.status, response.read(), response.headers
	except urllib.error.HTTPError as error:
		status, payload, response_headers = error.code, error.read(), error.headers
	if status not in expected:
		raise RuntimeError(f"{method} {url} returned HTTP {status}: {payload.decode(errors='replace')}")
	if not payload:
		return status, None, response_headers
	try:
		return status, json.loads(payload), response_headers
	except json.JSONDecodeError:
		return status, payload.decode(errors="replace"), response_headers


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


class Harness:
	def __init__(self, args):
		self.args = args
		self.runtime = base.Kubectl(args.runtime_kubeconfig, NAMESPACE)
		self.hub = base.Kubectl(args.hub_kubeconfig, API_NAMESPACE)
		self.run_id = uuid.uuid4().hex[:8]
		self.provider = None
		self.provider_errors = 0
		self.provider_imports = 0
		self.adapter_installed = False
		self.crd_installed = False
		self.hpa_installed = False
		self.deployment_patched = False
		self.original_affinity = None
		self.original_strategy = None
		self.original_replicas = None
		self.runtime_image = None
		self.runtime_image_id = None
		self.api_forward = None
		self.service_forward = None
		self.extra_forwards = []
		self.worker = None
		self.version = None
		self.last_request = None
		self.evidence = {
			"schema": "stateless-capacity-provider-e2e/v1",
			"cell": CELL,
			"cluster": CLUSTER,
			"run_id": self.run_id,
			"hpa_target_in_flight_per_pod": args.hpa_target,
			"load_requests": args.load_requests,
			"started_at_unix_ms": int(time.time() * 1000),
			"phases": {},
		}

	def kubectl_all(self, *arguments, timeout=180, input_text=None):
		return run_command(
			["kubectl", "--kubeconfig", str(self.args.runtime_kubeconfig), *arguments],
			timeout=timeout,
			input_text=input_text,
		)

	def k3d_nodes(self):
		payload = json.loads(run_command(["k3d", "node", "list", "-o", "json"]))
		return {
			item["name"] for item in payload
			if item.get("runtimeLabels", {}).get("k3d.cluster") == CLUSTER
		}

	def stateless_nodes(self):
		payload = json.loads(self.kubectl_all(
			"get", "nodes", "-l", "rivet.dev/stateless=true", "-o", "json"
		))
		return sorted(item["metadata"]["name"] for item in payload.get("items", []))

	def ready_pods(self):
		return [
			item for item in self.runtime.json("get", "pods", "-l", SELECTOR).get("items", [])
			if base.ready(item) and item.get("metadata", {}).get("deletionTimestamp") is None
		]

	def wait_ready_pods(self, count, timeout=None):
		deadline = time.monotonic() + (timeout or self.args.pod_timeout)
		last = None
		while time.monotonic() < deadline:
			pods = self.ready_pods()
			last = [
				(item["metadata"]["name"], item["metadata"]["uid"], item["spec"].get("nodeName"))
				for item in pods
			]
			if len(pods) == count:
				return pods
			time.sleep(0.5)
		raise TimeoutError(f"expected {count} Ready stateless Pods: {last}")

	def preflight(self):
		deployment = self.runtime.json("get", "deployment", DEPLOYMENT)
		self.original_replicas = int(deployment["spec"]["replicas"])
		self.original_affinity = copy.deepcopy(deployment["spec"]["template"]["spec"].get("affinity"))
		self.original_strategy = copy.deepcopy(deployment["spec"].get("strategy"))
		if self.original_replicas != 1:
			raise RuntimeError(f"qualification requires one baseline executor, got {self.original_replicas}")
		pods = self.wait_ready_pods(1, timeout=30)
		baseline_node = f"k3d-{CLUSTER}-stateless-0"
		if pods[0]["spec"].get("nodeName") != baseline_node:
			raise RuntimeError(f"baseline executor is not on {baseline_node}: {pods[0]['spec'].get('nodeName')}")
		if self.stateless_nodes() != [baseline_node]:
			raise RuntimeError(f"qualification requires one admitted stateless Node: {self.stateless_nodes()}")
		stale = sorted(name for name in self.k3d_nodes() if name.startswith("k3d-stateless-provider-"))
		if stale:
			raise RuntimeError(f"refusing to adopt stale provider Nodes: {stale}")
		try:
			self.runtime.run("get", "horizontalpodautoscaler", HPA)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing HPA {HPA}")
		try:
			self.kubectl_all("get", "customresourcedefinition", CRD_NAME)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing test CRD {CRD_NAME}")
		api_services = json.loads(self.kubectl_all("get", "apiservice", "-o", "json"))
		if any(
			item["metadata"]["name"].endswith(".external.metrics.k8s.io")
			for item in api_services.get("items", [])
		):
			raise RuntimeError("refusing to replace an existing external.metrics.k8s.io provider")
		containers = deployment["spec"]["template"]["spec"]["containers"]
		self.runtime_image = next(item["image"] for item in containers if item["name"] == "executor")
		self.runtime_image_id = run_command([
			"docker", "image", "inspect", self.runtime_image, "--format", "{{.Id}}"
		]).strip()
		configured = deployment["spec"]["template"]["metadata"]["annotations"][
			"fleet.actor.dev/runtime-digest"
		]
		if configured != self.runtime_image_id:
			raise RuntimeError(
				f"Deployment runtime digest does not match local image: {configured} != {self.runtime_image_id}"
			)
		self.evidence["phases"]["baseline"] = {
			"node": baseline_node,
			"pod": pods[0]["metadata"]["name"],
			"pod_uid": pods[0]["metadata"]["uid"],
			"runtime_image": self.runtime_image,
			"runtime_image_id": self.runtime_image_id,
		}

	def patch_required_anti_affinity(self):
		affinity = copy.deepcopy(self.original_affinity) or {}
		affinity["podAntiAffinity"] = {
			"requiredDuringSchedulingIgnoredDuringExecution": [{
				"labelSelector": {"matchLabels": {
					"fleet.actor.dev/cell-name": CELL,
					"fleet.actor.dev/component": "stateless-executor",
				}},
				"topologyKey": "kubernetes.io/hostname",
			}],
		}
		# With one stateless Node, the production zero-unavailable rollout would
		# create a surge Pod that the new required anti-affinity intentionally
		# leaves Pending. Use a bounded setup-only replacement strategy so the
		# HPA-created second replica, not the preparation rollout, is the demand
		# observed by the fake provider.
		patch = [
			{"op": "replace", "path": "/spec/strategy", "value": {
				"type": "RollingUpdate",
				"rollingUpdate": {"maxUnavailable": 1, "maxSurge": 0},
			}},
			{"op": "replace", "path": "/spec/template/spec/affinity", "value": affinity},
		]
		self.runtime.run(
			"patch", "deployment", DEPLOYMENT, "--type=json", "-p", json.dumps(patch)
		)
		self.deployment_patched = True
		self.runtime.run("rollout", "status", f"deployment/{DEPLOYMENT}", "--timeout=5m", timeout=330)
		pod = self.wait_ready_pods(1)[0]
		self.runtime.run(
			"annotate", "pod", pod["metadata"]["name"],
			"controller.kubernetes.io/pod-deletion-cost=10000", "--overwrite",
		)

	def ensure_adapter_chart(self):
		cache = pathlib.Path("/data/build-cache/helm") / f"prometheus-adapter-{ADAPTER_VERSION}.tgz"
		cache.parent.mkdir(parents=True, exist_ok=True)
		if not cache.exists():
			run_command([
				"helm", "pull", ADAPTER_OCI, "--version", ADAPTER_VERSION,
				"--destination", str(cache.parent),
			], timeout=180)
		actual = hashlib.sha256(cache.read_bytes()).hexdigest()
		if actual != ADAPTER_SHA256:
			raise RuntimeError(f"Prometheus Adapter chart SHA-256 mismatch: {actual}")
		return cache

	def install_adapter(self):
		chart = self.ensure_adapter_chart()
		run_command([
			"helm", "--kubeconfig", str(self.args.runtime_kubeconfig), "upgrade", "--install",
			ADAPTER_RELEASE, str(chart), "--namespace", "observability",
			"--values", str(HERE / "adapter-values.yaml"), "--atomic", "--wait", "--timeout", "10m",
		], timeout=660)
		self.adapter_installed = True
		deadline = time.monotonic() + self.args.adapter_timeout
		last = None
		while time.monotonic() < deadline:
			try:
				payload = json.loads(self.kubectl_all(
					"get", "apiservice", "v1beta1.external.metrics.k8s.io", "-o", "json"
				))
				last = payload.get("status", {})
				if any(
					condition.get("type") == "Available" and condition.get("status") == "True"
					for condition in last.get("conditions", [])
				):
					return
			except Exception as error:
				last = str(error)
			time.sleep(2)
		raise TimeoutError(f"external metrics API did not become Available: {last}")

	def install_hpa(self):
		hpa = {
			"apiVersion": "autoscaling/v2",
			"kind": "HorizontalPodAutoscaler",
			"metadata": {"name": HPA, "namespace": NAMESPACE},
			"spec": {
				"minReplicas": 1,
				"maxReplicas": 2,
				"scaleTargetRef": {
					"apiVersion": "apps/v1", "kind": "Deployment", "name": DEPLOYMENT,
				},
				"behavior": {
					"scaleUp": {
						"stabilizationWindowSeconds": 0,
						"selectPolicy": "Max",
						"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
					},
					"scaleDown": {
						"stabilizationWindowSeconds": 15,
						"selectPolicy": "Max",
						"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
					},
				},
				"metrics": [{
					"type": "External",
					"external": {
						"metric": {
							"name": "rivet_stateless_in_flight_total",
							"selector": {"matchLabels": {"cell": CELL}},
						},
						"target": {
							"type": "AverageValue", "averageValue": str(self.args.hpa_target),
						},
					},
				}],
			},
		}
		self.kubectl_all("apply", "-f", "-", input_text=json.dumps(hpa))
		self.hpa_installed = True

	def install_provider(self):
		self.kubectl_all("create", "-f", str(HERE / "crd.yaml"))
		self.crd_installed = True
		self.kubectl_all(
			"wait", "--for=condition=Established", f"customresourcedefinition/{CRD_NAME}",
			"--timeout=60s",
		)
		self.provider = self.new_provider()
		self.provider.start()

	def new_provider(self):
		return provider_module.Provider(
			kubeconfig=self.args.runtime_kubeconfig,
			cluster=CLUSTER,
			namespace=NAMESPACE,
			cell=CELL,
			deployment=DEPLOYMENT,
			runtime_image=self.runtime_image,
			runtime_image_id=self.runtime_image_id,
			run_id=self.run_id,
		)

	def wait_request_phase(self, phases, timeout=None):
		phases = {phases} if isinstance(phases, str) else set(phases)
		deadline = time.monotonic() + (timeout or self.args.provider_timeout)
		last = None
		while time.monotonic() < deadline:
			last = self.provider.request()
			if last is not None and last.get("status", {}).get("phase") in phases:
				self.last_request = last
				return last
			time.sleep(0.25)
		raise TimeoutError(
			f"capacity request did not reach {sorted(phases)}: request={last}, "
			f"provider_error={self.provider.last_error}"
		)

	def restart_provider(self):
		before = self.provider.request()
		self.provider.stop()
		self.provider_errors += self.provider.reconcile_errors
		self.provider_imports += self.provider.image_imports
		self.provider = self.new_provider()
		self.provider.start()
		after = self.wait_request_phase("Ready")
		return {"before": before, "after": after}

	def assert_request_immutable(self, request_value):
		try:
			self.runtime.run(
				"patch", provider_module.RESOURCE, request_value["metadata"]["name"],
				"--type=merge", "-p", json.dumps({"spec": {"cell": "mutated"}}),
			)
		except RuntimeError as error:
			if "StatelessCapacityRequest identity is immutable" not in str(error):
				raise RuntimeError(f"unexpected immutable identity rejection: {error}") from error
			return
		raise RuntimeError("Kubernetes accepted mutable capacity request identity")

	def publish_worker(self):
		self.api_forward = base.PortForward(self.hub, "service/workers-api", 8080)
		self.api_forward.start("/readyz")
		self.worker = f"stateless-capacity-{time.time_ns():x}"[-63:]
		api = self.api_forward.base_url + "/v1"
		_, version, _ = request("POST", f"{api}/workers/{self.worker}/versions", {
			"main_module": "main.js",
			"modules": {"main.js": WORKER_SOURCE},
			"compatibility_date": "2026-08-14",
		})
		self.version = version["id"]
		request("POST", f"{api}/workers/{self.worker}/deployments", {"version_id": self.version})
		self.service_forward = base.PortForward(
			self.runtime, f"service/{DEPLOYMENT}", 19084
		)
		self.service_forward.start("/readyz")

	def executor_token(self):
		secret = self.runtime.json("get", "secret", f"{CELL}-stateless-auth")
		return base64.b64decode(secret["data"]["executor-token"]).decode()

	def dispatch(self, endpoint, token, delay_ms, timeout=None):
		return request(
			"GET",
			f"{endpoint}/internal/v1/workers/{self.worker}/versions/{self.version}/dispatch",
			headers={
				TOKEN_HEADER: token,
				"X-Rivet-Original-URL": f"https://capacity.example/test?delay_ms={delay_ms}",
			},
			timeout=timeout or max(30, delay_ms / 1000 + 20),
		)

	def metric(self, endpoint, name):
		with urllib.request.urlopen(endpoint + "/metrics", timeout=3) as response:
			for line in response.read().decode().splitlines():
				if line.startswith(name + " "):
					return float(line.split()[1])
		raise RuntimeError(f"metric {name} is absent")

	def wait_metric(self, endpoint, name, predicate, timeout):
		deadline = time.monotonic() + timeout
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.metric(endpoint, name)
				if predicate(last):
					return last
			except Exception:
				pass
			time.sleep(0.1)
		raise TimeoutError(f"metric {name} did not converge, last={last}")

	def wait_deployment_replicas(self, replicas, timeout=None):
		deadline = time.monotonic() + (timeout or self.args.hpa_timeout)
		last = None
		while time.monotonic() < deadline:
			deployment = self.runtime.json("get", "deployment", DEPLOYMENT)
			hpa = self.runtime.json("get", "horizontalpodautoscaler", HPA)
			last = {"deployment": deployment["spec"].get("replicas"), "hpa": hpa.get("status", {})}
			if int(deployment["spec"].get("replicas", 0)) == replicas:
				return hpa
			time.sleep(1)
		raise TimeoutError(f"HPA did not select {replicas} replicas: {last}")

	def requeue_restored_pod_after_required_owner_is_gone(self):
		"""Remove a scheduler-backoff Pod only after the conflicting old Pod is gone."""
		deadline = time.monotonic() + 180
		while time.monotonic() < deadline:
			pods = self.runtime.json("get", "pods", "-l", SELECTOR).get("items", [])
			required = [
				pod for pod in pods
				if pod.get("spec", {}).get("affinity", {}).get("podAntiAffinity", {}).get(
					"requiredDuringSchedulingIgnoredDuringExecution"
				)
			]
			if required:
				time.sleep(0.5)
				continue
			# A preferred-affinity Pod can remain in the scheduler's backoff queue
			# after the old required-affinity Pod disappears. Recreate only that
			# unscheduled Pod; never touch an assigned or Ready Pod.
			for pod in pods:
				if (
					pod.get("metadata", {}).get("deletionTimestamp") is None
					and not pod.get("spec", {}).get("nodeName")
				):
					self.runtime.run("delete", "pod", pod["metadata"]["name"], "--wait=false")
			return
		raise TimeoutError("required-affinity executor Pod did not leave during restore")

	def run(self):
		self.preflight()
		self.patch_required_anti_affinity()
		self.install_adapter()
		self.install_hpa()
		self.install_provider()
		self.publish_worker()
		token = self.executor_token()
		with concurrent.futures.ThreadPoolExecutor(max_workers=self.args.load_requests) as pool:
			futures = [
				pool.submit(
					self.dispatch, self.service_forward.base_url, token, self.args.request_delay_ms
				)
				for _ in range(self.args.load_requests)
			]
			in_flight = self.wait_metric(
				self.service_forward.base_url, "rivet_stateless_in_flight",
				lambda value: value >= self.args.load_requests, 20,
			)
			up_hpa = self.wait_deployment_replicas(2)
			ready_request = self.wait_request_phase("Ready")
			self.assert_request_immutable(ready_request)
			pods = self.wait_ready_pods(2)
			provider_pod = next(
				pod for pod in pods if pod["spec"].get("nodeName") == self.provider.node_name
			)
			self.runtime.run(
				"annotate", "pod", provider_pod["metadata"]["name"],
				"controller.kubernetes.io/pod-deletion-cost=-10000", "--overwrite",
			)
			provider_forward = base.PortForward(
				self.runtime, f"pod/{provider_pod['metadata']['name']}", 19084
			)
			self.extra_forwards.append(provider_forward)
			provider_forward.start("/readyz")
			_, probe, _ = self.dispatch(provider_forward.base_url, token, 0)
			if probe != {"marker": "stateless-capacity-provider-e2e", "delayMs": 0}:
				raise RuntimeError(f"new provider Node did not execute Worker code: {probe}")
			restarted = self.restart_provider()
			self.evidence["phases"]["scale_up"] = {
				"observed_in_flight": in_flight,
				"hpa": up_hpa.get("status", {}),
				"capacity_request": ready_request,
				"provider_restart": restarted,
				"pods": [{
					"name": pod["metadata"]["name"], "uid": pod["metadata"]["uid"],
					"node": pod["spec"].get("nodeName"),
				} for pod in pods],
				"stateless_nodes": self.stateless_nodes(),
			}
			results = [future.result() for future in futures]
			if any(
				payload != {"marker": "stateless-capacity-provider-e2e", "delayMs": self.args.request_delay_ms}
				for _, payload, _ in results
			):
				raise RuntimeError("one or more held requests returned an unexpected body")
		self.wait_metric(
			self.service_forward.base_url, "rivet_stateless_in_flight", lambda value: value == 0, 10
		)
		down_hpa = self.wait_deployment_replicas(1)
		deleted_request = self.wait_request_phase("Deleted", timeout=self.args.scale_down_timeout)
		pods = self.wait_ready_pods(1)
		baseline_node = f"k3d-{CLUSTER}-stateless-0"
		if pods[0]["spec"].get("nodeName") != baseline_node:
			raise RuntimeError(f"scale-down did not retain baseline Node: {pods[0]['spec'].get('nodeName')}")
		if self.stateless_nodes() != [baseline_node] or self.provider.node_name in self.k3d_nodes():
			raise RuntimeError("provider Node did not disappear from both Kubernetes and k3d")
		self.evidence["phases"]["scale_down"] = {
			"hpa": down_hpa.get("status", {}),
			"capacity_request": deleted_request,
			"retained_pod": pods[0]["metadata"]["name"],
			"retained_node": baseline_node,
			"stateless_nodes": self.stateless_nodes(),
		}
		self.evidence["provider_image_imports"] = self.provider_imports + self.provider.image_imports
		self.evidence["provider_reconcile_errors"] = self.provider_errors + self.provider.reconcile_errors
		if self.evidence["provider_image_imports"] != 1:
			raise RuntimeError(
				f"expected exactly one image preparation, got {self.evidence['provider_image_imports']}"
			)
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		errors = []
		for forward in reversed(self.extra_forwards):
			try:
				forward.stop()
			except Exception as error:
				errors.append(f"stop Pod forward: {error}")
		self.extra_forwards = []
		for forward in (self.service_forward, self.api_forward):
			if forward is not None:
				try:
					forward.stop()
				except Exception as error:
					errors.append(f"stop forward: {error}")
		if self.hpa_installed:
			try:
				self.runtime.run("delete", "horizontalpodautoscaler", HPA, "--ignore-not-found")
			except Exception as error:
				errors.append(f"delete HPA: {error}")
			self.hpa_installed = False
		if self.original_replicas is not None:
			try:
				self.runtime.run("scale", "deployment", DEPLOYMENT, f"--replicas={self.original_replicas}")
			except Exception as error:
				errors.append(f"restore replicas: {error}")
		if self.provider is not None:
			try:
				request_value = self.provider.request()
				if request_value is not None and request_value.get("status", {}).get("phase") not in {
					"Deleted", "Failed"
				}:
					request_value = self.wait_request_phase({"Deleted", "Failed"}, timeout=180)
				self.last_request = request_value
			except Exception as error:
				errors.append(f"settle provider: {error}")
			try:
				if self.provider.node_name in self.provider.k3d_nodes():
					request_value = self.provider.request()
					expected_uid = (request_value or {}).get("status", {}).get("nodeUID")
					self.provider.delete_node(expected_node_uid=expected_uid)
			except Exception as error:
				errors.append(f"delete provider Node: {error}")
			try:
				self.provider.stop()
				self.provider_errors += self.provider.reconcile_errors
				self.provider_imports += self.provider.image_imports
			except Exception as error:
				errors.append(f"stop provider: {error}")
			self.provider = None
		if self.deployment_patched:
			try:
				setup_strategy = {
					"type": "RollingUpdate",
					"rollingUpdate": {"maxUnavailable": 1, "maxSurge": 0},
				}
				patch = [
					{"op": "replace", "path": "/spec/replicas", "value": self.original_replicas},
					{"op": "replace", "path": "/spec/strategy", "value": setup_strategy},
					{
						"op": "replace", "path": "/spec/template/spec/affinity",
						"value": self.original_affinity,
					},
				]
				self.runtime.run(
					"patch", "deployment", DEPLOYMENT, "--type=json", "-p", json.dumps(patch)
				)
				self.requeue_restored_pod_after_required_owner_is_gone()
				self.runtime.run(
					"rollout", "status", f"deployment/{DEPLOYMENT}", "--timeout=5m", timeout=330
				)
				# The old Pod carried required anti-affinity, so restore the
				# production surge strategy only after that Pod is gone and the
				# preferred-affinity template is Ready.
				self.runtime.run(
					"patch", "deployment", DEPLOYMENT, "--type=json", "-p", json.dumps([{
						"op": "replace", "path": "/spec/strategy", "value": self.original_strategy,
					}])
				)
			except Exception as error:
				errors.append(f"restore Deployment affinity: {error}")
			self.deployment_patched = False
		if self.crd_installed:
			try:
				if any(name.startswith("k3d-stateless-provider-") for name in self.k3d_nodes()):
					raise RuntimeError("owned provider Node remains")
				self.kubectl_all(
					"delete", "customresourcedefinition", CRD_NAME, "--ignore-not-found"
				)
			except Exception as error:
				errors.append(f"delete provider CRD: {error}")
			self.crd_installed = False
		if self.adapter_installed:
			try:
				run_command([
					"helm", "--kubeconfig", str(self.args.runtime_kubeconfig), "uninstall",
					ADAPTER_RELEASE, "--namespace", "observability",
				], timeout=180)
			except Exception as error:
				errors.append(f"uninstall Prometheus Adapter: {error}")
			self.adapter_installed = False
		if errors:
			self.evidence.setdefault("cleanup_errors", []).extend(errors)


def default_receipt():
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return pathlib.Path("/data/benchmarks/minisandbox/stateless-capacity-provider-e2e") / f"{stamp}.json"


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--hub-kubeconfig", type=pathlib.Path, default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", type=pathlib.Path, default=state / "runtime-a.kubeconfig")
	parser.add_argument("--load-requests", type=int, default=60)
	parser.add_argument("--request-delay-ms", type=int, default=90000)
	parser.add_argument("--hpa-target", type=int, default=48)
	parser.add_argument("--adapter-timeout", type=float, default=180)
	parser.add_argument("--hpa-timeout", type=float, default=300)
	parser.add_argument("--provider-timeout", type=float, default=300)
	parser.add_argument("--pod-timeout", type=float, default=600)
	parser.add_argument("--scale-down-timeout", type=float, default=300)
	parser.add_argument("--receipt", type=pathlib.Path, default=default_receipt())
	args = parser.parse_args()
	for path in (args.hub_kubeconfig, args.runtime_kubeconfig):
		if not path.is_file():
			parser.error(f"kubeconfig does not exist: {path}")
	if not (args.hpa_target < args.load_requests <= 64):
		parser.error("load requests must exceed the HPA target and fit one executor's 64 permits")
	if args.request_delay_ms < 30000 or args.request_delay_ms > 90000:
		parser.error("request delay must be between 30000 and 90000 milliseconds")
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
		publish_new(args.receipt, harness.evidence)
	print(json.dumps(harness.evidence, indent=2, sort_keys=True))
	print(f"receipt: {args.receipt}")
	if failure is not None:
		raise failure
	if harness.evidence.get("cleanup_errors"):
		raise RuntimeError("qualification passed but cleanup did not complete")


if __name__ == "__main__":
	main()
