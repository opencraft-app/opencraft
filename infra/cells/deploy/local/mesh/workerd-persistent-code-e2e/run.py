#!/usr/bin/env python3
"""Prove uploaded JavaScript and actor SQLite survive a workerd Host replacement."""

import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


KUBE_NAMESPACE = "actor-fdb-cell-system"
ACTOR_NAMESPACE = "default"
REGISTRY_NAMESPACE = "worker-registry-system"
COMPATIBILITY_DATE = "2026-08-14"

WORKER_SOURCE = r"""
export default {
  async fetch(request, env) {
    await env.RIVET_STORAGE.sql.exec(
      "CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)"
    );
    const path = new URL(request.url).pathname;
    if (path === "/increment") {
      await env.RIVET_STORAGE.sql.exec(
        "INSERT INTO counter (id, value) VALUES (1, 1) " +
        "ON CONFLICT(id) DO UPDATE SET value = value + 1"
      );
    }
    const result = await env.RIVET_STORAGE.sql.exec(
      "SELECT value FROM counter WHERE id = 1"
    );
    return Response.json({
      count: Number(result.rows[0]?.value ?? 0),
      release: "__RELEASE__",
    });
  }
};
""".strip()


def free_port():
	with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as listener:
		listener.bind(("127.0.0.1", 0))
		return listener.getsockname()[1]


def request_json(method, url, body=None, timeout=30):
	data = None if body is None else json.dumps(body).encode()
	request = urllib.request.Request(url, data=data, method=method)
	if data is not None:
		request.add_header("content-type", "application/json")
	try:
		with urllib.request.urlopen(request, timeout=timeout) as response:
			payload = response.read()
	except urllib.error.HTTPError as error:
		payload = error.read().decode(errors="replace")
		raise RuntimeError(f"{method} {url} returned HTTP {error.code}: {payload}") from error
	return json.loads(payload) if payload else {}


def upload_version(registry_endpoint, release):
	version = request_json(
		"POST",
		f"{registry_endpoint}/versions",
		{
			"main_module": "main.js",
			"modules": {"main.js": WORKER_SOURCE.replace("__RELEASE__", release)},
			"compatibility_date": COMPATIBILITY_DATE,
		},
	)
	version_id = version["version_id"]
	if not version_id.startswith("v_") or len(version_id) != 66:
		raise RuntimeError(f"registry returned invalid immutable Version: {version_id}")
	return version_id


def create_deployment(registry_endpoint, versions):
	worker = request_json(
		"POST",
		f"{registry_endpoint}/deployments",
		{
			"strategy": "percentage",
			"versions": [
				{"version_id": version_id, "percentage": percentage}
				for version_id, percentage in versions
			],
		},
	)
	deployment = worker["deployment"]
	if not deployment["id"].startswith("d_") or deployment["versions"] != [
		{"version_id": version_id, "percentage": percentage}
		for version_id, percentage in versions
	]:
		raise RuntimeError(f"registry returned invalid Deployment: {deployment}")
	return deployment


def assigned_version(worker, actor_id, deployment):
	digest = hashlib.sha256()
	for component in (
		"rivet-worker-deployment/v1",
		ACTOR_NAMESPACE,
		worker,
		deployment["id"],
		actor_id,
	):
		digest.update(component.encode())
		digest.update(b"\0")
	bucket = int.from_bytes(digest.digest()[:8], "big") % 10_000
	upper_bound = 0
	for target in deployment["versions"]:
		upper_bound += round(float(target["percentage"]) * 100)
		if bucket < upper_bound:
			return target["version_id"]
	raise RuntimeError(f"Deployment does not cover assignment bucket {bucket}")


class Kubectl:
	def __init__(self, kubeconfig, namespace):
		self.kubeconfig = pathlib.Path(kubeconfig)
		self.namespace = namespace

	def command(self, *args):
		return [
			"kubectl",
			"--kubeconfig",
			str(self.kubeconfig),
			"-n",
			self.namespace,
			*args,
		]

	def run(self, *args, timeout=180):
		result = subprocess.run(
			self.command(*args),
			text=True,
			stdout=subprocess.PIPE,
			stderr=subprocess.PIPE,
			timeout=timeout,
		)
		if result.returncode:
			raise RuntimeError(
				f"{' '.join(self.command(*args))} failed: {result.stderr.strip()}"
			)
		return result.stdout

	def json(self, *args):
		return json.loads(self.run(*args, "-o", "json"))


class PortForward:
	def __init__(self, kubectl, resource, remote_port):
		self.kubectl = kubectl
		self.resource = resource
		self.remote_port = remote_port
		self.local_port = free_port()
		self.process = None
		self.log = None

	@property
	def base_url(self):
		return f"http://127.0.0.1:{self.local_port}"

	def start(self, ready_path):
		self.log = tempfile.TemporaryFile(mode="w+")
		self.process = subprocess.Popen(
			self.kubectl.command(
				"port-forward", self.resource, f"{self.local_port}:{self.remote_port}"
			),
			stdout=self.log,
			stderr=subprocess.STDOUT,
			text=True,
			start_new_session=True,
		)
		deadline = time.monotonic() + 30
		while time.monotonic() < deadline:
			if self.process.poll() is not None:
				self.log.seek(0)
				raise RuntimeError(f"port-forward exited: {self.log.read()}")
			try:
				request_json("GET", self.base_url + ready_path, timeout=1)
				return
			except Exception:
				time.sleep(0.1)
		raise TimeoutError(f"{self.resource} port-forward did not become ready")

	def stop(self):
		if self.process is not None:
			self.process.terminate()
			try:
				self.process.wait(timeout=5)
			except subprocess.TimeoutExpired:
				self.process.kill()
				self.process.wait(timeout=5)
			self.process = None
		if self.log is not None:
			self.log.close()
			self.log = None


def ready(pod):
	return any(
		condition.get("type") == "Ready" and condition.get("status") == "True"
		for condition in pod.get("status", {}).get("conditions", [])
	)


def wait_for_host_replacement(kubectl, pod_name, old_uid, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			pod = kubectl.json("get", "pod", pod_name)
			last = pod.get("status", {})
			if pod["metadata"]["uid"] != old_uid and ready(pod):
				return pod["metadata"]["uid"]
		except Exception as error:
			last = str(error)
		time.sleep(0.25)
	raise TimeoutError(f"Host Pod was not replaced and Ready: {last}")


def retry_counter(engine_url, actor_id, expected, release, timeout, suffix="/counter"):
	url = f"{engine_url}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			payload = request_json("GET", url, timeout=10)
			last = payload
			if payload.get("count") == expected and payload.get("release") == release:
				return payload
			if isinstance(payload.get("count"), int) and payload["count"] > expected:
				raise RuntimeError(f"counter advanced more than once: {payload}")
		except Exception as error:
			last = str(error)
		time.sleep(0.25)
	raise TimeoutError(
		f"Actor did not return counter {expected} from release {release}: {last}"
	)


def active_envoy_keys(engine_url):
	payload = request_json(
		"GET", f"{engine_url}/envoys?namespace={ACTOR_NAMESPACE}&name=workerd", timeout=10
	)
	return {
		item["envoy_key"]
		for item in payload.get("envoys", [])
		if item.get("stop_ts") is None
	}


def wait_for_new_envoy(engine_url, old_keys, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			last = active_envoy_keys(engine_url)
			new_keys = last - old_keys
			if new_keys:
				return sorted(new_keys)
		except Exception as error:
			last = str(error)
		time.sleep(0.25)
	raise TimeoutError(f"replacement workerd Envoy was not visible to Engine: {last}")


def wait_for_sleep(engine_url, actor_id, timeout):
	query = urllib.parse.urlencode(
		{"namespace": ACTOR_NAMESPACE, "actor_ids": actor_id}
	)
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		try:
			payload = request_json("GET", f"{engine_url}/actors?{query}", timeout=10)
			actors = payload.get("actors", [])
			last = actors
			if (
				len(actors) == 1
				and actors[0].get("sleep_ts") is not None
				and actors[0].get("connectable_ts") is None
			):
				return actors[0]
		except Exception as error:
			last = str(error)
		time.sleep(0.25)
	raise TimeoutError(f"Actor did not become durably sleeping: {last}")


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	parser = argparse.ArgumentParser()
	parser.add_argument("--hub-kubeconfig", default=state / "mesh-hub.kubeconfig")
	parser.add_argument("--runtime-kubeconfig", default=state / "runtime-a.kubeconfig")
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--timeout", type=float, default=180)
	return parser.parse_args()


def main():
	args = parse_args()
	hub = Kubectl(args.hub_kubeconfig, REGISTRY_NAMESPACE)
	runtime = Kubectl(args.runtime_kubeconfig, KUBE_NAMESPACE)
	registry_forward = PortForward(hub, "service/worker-registry", 8080)
	engine_forward = PortForward(runtime, f"service/{args.cell}-engine", 6420)
	run_id = uuid.uuid4().hex[:12]
	worker = f"persistent-e2e-{run_id}"
	actor_id = None
	result = {"worker": worker, "cell": args.cell}
	cleanup_errors = []
	try:
		registry_forward.start("/readyz")
		engine_forward.start("/health")
		registry_endpoint = (
			f"{registry_forward.base_url}/v1/namespaces/{ACTOR_NAMESPACE}/workers/{worker}"
		)
		version_v1 = upload_version(registry_endpoint, "v1")
		create_deployment(registry_endpoint, [(version_v1, 100)])

		created = request_json(
			"POST",
			f"{engine_forward.base_url}/actors?namespace={ACTOR_NAMESPACE}",
			{
				"name": worker,
				"key": run_id,
				"runner_name_selector": "workerd",
				"crash_policy": "restart",
				# Deployment-bound Durable Object: no immutable version pin.
				"worker": {"worker": worker},
			},
		)
		actor_id = created["actor"]["actor_id"]
		first = request_json(
			"POST",
			f"{engine_forward.base_url}/gateway/{urllib.parse.quote(actor_id, safe='')}/increment",
			timeout=30,
		)
		if first.get("count") != 1 or first.get("release") != "v1":
			raise RuntimeError(f"first acknowledged mutation returned the wrong count: {first}")
		request_json(
			"POST",
			f"{engine_forward.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}/sleep?namespace={ACTOR_NAMESPACE}",
			{},
			timeout=30,
		)
		sleep_state = wait_for_sleep(
			engine_forward.base_url, actor_id, args.timeout
		)
		version_v2 = upload_version(registry_endpoint, "v2")
		if version_v2 == version_v1:
			raise RuntimeError("v2 deployment reused the v1 immutable Version")
		gradual = create_deployment(
			registry_endpoint, [(version_v1, 50), (version_v2, 50)]
		)
		gradual_version = assigned_version(worker, actor_id, gradual)
		gradual_release = "v1" if gradual_version == version_v1 else "v2"
		old_envoy_keys = active_envoy_keys(engine_forward.base_url)
		if not old_envoy_keys:
			raise RuntimeError("Engine reported no active workerd Envoy before Host replacement")

		pods = runtime.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={args.cell},fleet.actor.dev/component=workerd-host",
		).get("items", [])
		if len(pods) != 1 or not ready(pods[0]):
			raise RuntimeError(f"qualification requires exactly one Ready runtime Host, got {len(pods)}")
		pod_name = pods[0]["metadata"]["name"]
		old_uid = pods[0]["metadata"]["uid"]
		runtime.run("delete", "pod", pod_name, "--wait=false")
		new_uid = wait_for_host_replacement(runtime, pod_name, old_uid, args.timeout)
		new_envoy_keys = wait_for_new_envoy(
			engine_forward.base_url, old_envoy_keys, args.timeout
		)
		recovered = retry_counter(
			engine_forward.base_url, actor_id, 1, gradual_release, args.timeout
		)
		second = request_json(
			"POST",
			f"{engine_forward.base_url}/gateway/{urllib.parse.quote(actor_id, safe='')}/increment",
			timeout=30,
		)
		if second.get("count") != 2 or second.get("release") != gradual_release:
			raise RuntimeError(f"post-recovery mutation returned the wrong count: {second}")

		version_v3 = upload_version(registry_endpoint, "v3")
		if version_v3 in (version_v1, version_v2):
			raise RuntimeError("v3 deployment did not create a new immutable Version")
		create_deployment(registry_endpoint, [(version_v3, 100)])
		online_upgraded = retry_counter(
			engine_forward.base_url, actor_id, 2, "v3", args.timeout
		)
		third = request_json(
			"POST",
			f"{engine_forward.base_url}/gateway/{urllib.parse.quote(actor_id, safe='')}/increment",
			timeout=30,
		)
		if third.get("count") != 3 or third.get("release") != "v3":
			raise RuntimeError(f"online deployment mutation returned the wrong value: {third}")

		result.update(
			{
				"actor_id": actor_id,
				"version_v1": version_v1,
				"version_v2": version_v2,
				"version_v3": version_v3,
				"gradual_deployment_id": gradual["id"],
				"gradual_assigned_version": gradual_version,
				"gradual_assigned_release": gradual_release,
				"deployment_bound": True,
				"counter_before_replacement": first["count"],
				"sleep_ts": sleep_state["sleep_ts"],
				"counter_recovered_read_only": recovered["count"],
				"counter_after_replacement": second["count"],
				"counter_after_online_upgrade_read": online_upgraded["count"],
				"counter_after_online_upgrade_write": third["count"],
				"old_envoy_keys": sorted(old_envoy_keys),
				"new_envoy_keys": new_envoy_keys,
				"host_pod": pod_name,
				"old_pod_uid": old_uid,
				"new_pod_uid": new_uid,
			}
		)
		print(json.dumps(result, indent=2, sort_keys=True))
	finally:
		if actor_id is not None and engine_forward.process is not None:
			try:
				request_json(
					"DELETE",
					f"{engine_forward.base_url}/actors/{urllib.parse.quote(actor_id, safe='')}?namespace={ACTOR_NAMESPACE}",
				)
			except Exception as error:
				cleanup_errors.append(f"Actor cleanup: {error}")
		if registry_forward.process is not None:
			try:
				request_json(
					"DELETE",
					f"{registry_forward.base_url}/v1/namespaces/{ACTOR_NAMESPACE}/workers/{worker}",
				)
			except Exception as error:
				cleanup_errors.append(f"Worker cleanup: {error}")
		engine_forward.stop()
		registry_forward.stop()
		if cleanup_errors:
			print("; ".join(cleanup_errors), file=sys.stderr)


if __name__ == "__main__":
	main()
