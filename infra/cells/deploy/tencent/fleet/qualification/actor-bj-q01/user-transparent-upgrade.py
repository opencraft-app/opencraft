#!/usr/bin/env python3
"""Qualify a runtime release through only the public Workers /v1 contract."""

import argparse
import collections
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import pathlib
import signal
import statistics
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


CELL = "actor-bj-q01"
NAMESPACE = "actor-fdb-cell-system"
CLASS_NAME = "Agent"
COMPATIBILITY_DATE = "2026-08-14"
FORBIDDEN_PUBLIC_FIELDS = ("actor_id", "namespace", "runner", "datacenter")
STATIC_REPLICA_MANAGERS = {
    "rivet-runtime-installer",
    "rivet-runtime-release-fields",
    "rivet-runtime-rollback",
    "rivet-runtime-admission-installer",
    "rivet-runtime-admission-rollback",
    "rivet-runtime-release-ledger",
}

WORKER_SOURCE = r'''
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const value = (await this.ctx.storage.get("value")) ?? 0;
    if (url.pathname === "/read") {
      return Response.json({ value });
    }
    if (url.pathname === "/increment") {
      const next = value + 1;
      await this.ctx.storage.put("value", next);
      return Response.json({ value: next });
    }
    return new Response("not found", { status: 404 });
  }
}

export default { fetch() { return new Response("ready"); } };
'''.strip()


def load_soak_helpers():
    path = pathlib.Path(__file__).resolve().with_name("load-driven-soak.py")
    spec = importlib.util.spec_from_file_location("q01_upgrade_soak_helpers", str(path))
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load q01 qualification helpers")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


soak = load_soak_helpers()


def utc_now():
    return soak.utc_now()


def json_request(method, url, body=None, headers=None, expected=(200,), timeout=10):
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=encoded, method=method)
    request.add_header("X-Request-ID", "upgrade-" + uuid.uuid4().hex)
    if encoded is not None:
        request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            response_headers = dict(response.headers.items())
            payload = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        response_headers = dict(error.headers.items()) if error.headers else {}
        payload = error.read()
    elapsed = time.monotonic() - started
    parsed = None
    if payload:
        try:
            parsed = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            parsed = payload.decode("utf-8", errors="replace")
    if status not in expected:
        raise RuntimeError(
            "{} {} returned {} in {:.3f}s: {}".format(method, url, status, elapsed, parsed)
        )
    return status, parsed, elapsed, response_headers


def assert_public_resource(value, object_type=None):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).lower()
    for forbidden in FORBIDDEN_PUBLIC_FIELDS:
        if '"{}"'.format(forbidden) in encoded:
            raise RuntimeError("public resource leaked private field {}".format(forbidden))
    if object_type is not None:
        if not isinstance(value, dict) or value.get("object") != object_type:
            raise RuntimeError("expected public {} resource, got {}".format(object_type, value))


def owns_field(fields, path):
    cursor = fields or {}
    for component in path:
        if not isinstance(cursor, dict) or component not in cursor:
            return False
        cursor = cursor[component]
    return True


def replica_field_managers(statefulset):
    owners = []
    for entry in statefulset.get("metadata", {}).get("managedFields", []) or []:
        if owns_field(entry.get("fieldsV1"), ("f:spec", "f:replicas")):
            owners.append(entry.get("manager", "unknown"))
    return sorted(set(owners))


def template_sha256(workload):
    payload = json.dumps(
        workload.get("spec", {}).get("template", {}),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def workload_images(workload):
    spec = workload.get("spec", {}).get("template", {}).get("spec", {})
    result = {}
    for kind, field in (("container", "containers"), ("init", "initContainers")):
        for item in spec.get(field, []) or []:
            result["{}/{}".format(kind, item.get("name"))] = item.get("image")
    return result


def deployment_status(workload):
    return {
        "generation": workload.get("metadata", {}).get("generation"),
        "observed_generation": workload.get("status", {}).get("observedGeneration"),
        "spec_replicas": workload.get("spec", {}).get("replicas"),
        "ready_replicas": workload.get("status", {}).get("readyReplicas", 0),
        "template_sha256": template_sha256(workload),
        "images": workload_images(workload),
    }


def assert_component_transition(name, before, after, scalable=False):
    """Prove that only a changed Pod template replaces running instances.

    A StatefulSet owned by the capacity plane may add or remove ordinals while
    the release is running.  For an unchanged template, every ordinal present
    in both snapshots must retain its exact UID.  Fixed-size Deployments and
    NATS must retain the complete UID set.  A changed template must leave no
    pre-release Pod alive.
    """
    changed = before["template_sha256"] != after["template_sha256"]
    before_by_name = {item["name"]: item["uid"] for item in before["pods"]}
    after_by_name = {item["name"]: item["uid"] for item in after["pods"]}
    before_uids = set(before_by_name.values())
    after_uids = set(after_by_name.values())
    if changed:
        survivors = sorted(before_uids.intersection(after_uids))
        if survivors:
            raise RuntimeError(
                "{} template changed but old Pod UIDs survived: {}".format(name, survivors)
            )
        outcome = "changed_complete_rollout"
    elif scalable:
        replaced = sorted(
            pod_name for pod_name in set(before_by_name).intersection(after_by_name)
            if before_by_name[pod_name] != after_by_name[pod_name]
        )
        if replaced:
            raise RuntimeError(
                "{} template was unchanged but existing ordinals were replaced: {}".format(
                    name, replaced
                )
            )
        outcome = "unchanged_preserved_existing_ordinals"
    else:
        if before_uids != after_uids:
            raise RuntimeError(
                "{} template was unchanged but Pod UID set changed".format(name)
            )
        outcome = "unchanged_preserved_exact_uid_set"
    return {
        "component": name,
        "template_changed": changed,
        "outcome": outcome,
        "before_template_sha256": before["template_sha256"],
        "after_template_sha256": after["template_sha256"],
        "before_pod_uids": sorted(before_uids),
        "after_pod_uids": sorted(after_uids),
    }


def assert_target_images(snapshot, targets):
    evidence = {}
    for component, expected in targets.items():
        actual_images = snapshot[component]["images"]
        for container, expected_image in expected.items():
            actual = actual_images.get(container)
            if actual != expected_image:
                raise RuntimeError(
                    "{} {} target image mismatch: expected {}, got {}".format(
                        component, container, expected_image, actual
                    )
                )
        evidence[component] = dict(expected)
    return evidence


def pod_records(pods, component):
    result = []
    for pod in pods.get("items", []):
        metadata = pod.get("metadata", {})
        if metadata.get("labels", {}).get("fleet.actor.dev/component") != component:
            continue
        conditions = {
            item.get("type"): item.get("status")
            for item in pod.get("status", {}).get("conditions", [])
        }
        result.append({
            "name": metadata.get("name"),
            "uid": metadata.get("uid"),
            "node": pod.get("spec", {}).get("nodeName"),
            "ready": conditions.get("Ready") == "True",
            "deleting": metadata.get("deletionTimestamp") is not None,
            "image_ids": sorted(
                item.get("imageID", "")
                for item in pod.get("status", {}).get("containerStatuses", [])
            ),
        })
    return sorted(result, key=lambda item: item.get("name") or "")


def workload_snapshot(kube):
    engine = kube.json("-n", NAMESPACE, "get", "deployment", CELL + "-engine")
    nats = kube.json("-n", NAMESPACE, "get", "statefulset", CELL + "-nats")
    runtime = kube.json("-n", NAMESPACE, "get", "statefulset", CELL + "-runtime-hosts")
    capacity = kube.json("-n", NAMESPACE, "get", "deployment", CELL + "-runtime-capacity")
    reporter = kube.json("-n", NAMESPACE, "get", "deployment", CELL + "-cell-reporter")
    pods = kube.json(
        "-n", NAMESPACE, "get", "pods", "-l", "fleet.actor.dev/cell-name=" + CELL
    )
    ledger_map = kube.json_optional(
        "-n", NAMESPACE, "get", "configmap", CELL + "-release-ledger",
        "--ignore-not-found",
    )
    ledger = None
    if ledger_map is not None:
        try:
            ledger = json.loads(ledger_map.get("data", {}).get("ledger.json", "null"))
        except (TypeError, ValueError) as error:
            raise RuntimeError("release ledger contains invalid JSON") from error
    result = {
        "at": utc_now(),
        "engine_generation": engine.get("metadata", {}).get("generation"),
        "engine_observed_generation": engine.get("status", {}).get("observedGeneration"),
        "engine_spec_replicas": engine.get("spec", {}).get("replicas"),
        "engine_ready_replicas": engine.get("status", {}).get("readyReplicas", 0),
        "nats_generation": nats.get("metadata", {}).get("generation"),
        "nats_observed_generation": nats.get("status", {}).get("observedGeneration"),
        "nats_spec_replicas": nats.get("spec", {}).get("replicas"),
        "nats_ready_replicas": nats.get("status", {}).get("readyReplicas", 0),
        "nats_current_revision": nats.get("status", {}).get("currentRevision"),
        "nats_update_revision": nats.get("status", {}).get("updateRevision"),
        "runtime_generation": runtime.get("metadata", {}).get("generation"),
        "runtime_observed_generation": runtime.get("status", {}).get("observedGeneration"),
        "runtime_spec_replicas": runtime.get("spec", {}).get("replicas"),
        "runtime_ready_replicas": runtime.get("status", {}).get("readyReplicas", 0),
        "runtime_updated_replicas": runtime.get("status", {}).get("updatedReplicas", 0),
        "runtime_current_revision": runtime.get("status", {}).get("currentRevision"),
        "runtime_update_revision": runtime.get("status", {}).get("updateRevision"),
        "runtime_replica_field_managers": replica_field_managers(runtime),
        "engine_pods": pod_records(pods, "engine"),
        "nats_pods": pod_records(pods, "nats"),
        "runtime_pods": pod_records(pods, "workerd-host"),
        "capacity_pods": pod_records(pods, "runtime-capacity-controller"),
        "reporter_pods": pod_records(pods, "cell-reporter"),
        "ledger": ledger,
    }
    for name, workload in (
        ("engine", engine),
        ("nats", nats),
        ("runtime", runtime),
        ("capacity", capacity),
        ("reporter", reporter),
    ):
        status = deployment_status(workload)
        result[name + "_template_sha256"] = status["template_sha256"]
        result[name + "_images"] = status["images"]
        if name in ("capacity", "reporter"):
            for field in ("generation", "observed_generation", "spec_replicas", "ready_replicas"):
                result[name + "_" + field] = status[field]
    return result


def assert_healthy_snapshot(snapshot, require_replica_ownership=True):
    for prefix in ("engine", "nats", "runtime", "capacity", "reporter"):
        desired = snapshot[prefix + "_spec_replicas"]
        ready = snapshot[prefix + "_ready_replicas"]
        minimum = 3 if prefix in ("engine", "nats", "runtime") else 1
        if not isinstance(desired, int) or desired < minimum or ready != desired:
            raise RuntimeError("{} workload is not fully Ready: {}".format(prefix, snapshot))
    for prefix in ("engine", "nats", "runtime", "capacity", "reporter"):
        if snapshot[prefix + "_generation"] != snapshot[prefix + "_observed_generation"]:
            raise RuntimeError("{} has not observed its current generation".format(prefix))
    if snapshot["runtime_current_revision"] != snapshot["runtime_update_revision"]:
        raise RuntimeError("runtime StatefulSet revisions have not converged")
    if snapshot["nats_current_revision"] != snapshot["nats_update_revision"]:
        raise RuntimeError("NATS StatefulSet revisions have not converged")
    for component in (
        "engine_pods", "nats_pods", "runtime_pods", "capacity_pods", "reporter_pods"
    ):
        records = snapshot[component]
        if len(records) != snapshot[component.split("_")[0] + "_spec_replicas"]:
            raise RuntimeError("{} does not have the desired Pod count".format(component))
        if any(not item["ready"] or item["deleting"] or not item["uid"] for item in records):
            raise RuntimeError("{} contains an unhealthy Pod: {}".format(component, records))
    if require_replica_ownership:
        forbidden = STATIC_REPLICA_MANAGERS.intersection(snapshot["runtime_replica_field_managers"])
        if forbidden:
            raise RuntimeError("static release manager owns runtime replicas: {}".format(sorted(forbidden)))


def compact_capacity_snapshot(snapshot):
    return {
        "at": snapshot["at"],
        "engine_desired": snapshot["engine_spec_replicas"],
        "engine_ready": snapshot["engine_ready_replicas"],
        "nats_desired": snapshot["nats_spec_replicas"],
        "nats_ready": snapshot["nats_ready_replicas"],
        "runtime_desired": snapshot["runtime_spec_replicas"],
        "runtime_ready": snapshot["runtime_ready_replicas"],
        "runtime_current_revision": snapshot["runtime_current_revision"],
        "runtime_update_revision": snapshot["runtime_update_revision"],
        "capacity_desired": snapshot["capacity_spec_replicas"],
        "capacity_ready": snapshot["capacity_ready_replicas"],
        "reporter_desired": snapshot["reporter_spec_replicas"],
        "reporter_ready": snapshot["reporter_ready_replicas"],
    }


def capacity_state(snapshot):
    """Return the comparable portion of a compact capacity observation."""
    compact = compact_capacity_snapshot(snapshot)
    compact.pop("at", None)
    return compact


class BoundedWorkloadTimeline(object):
    """Hash every observation while retaining only bounded transition evidence.

    The release monitor polls the full Kubernetes workload graph every two
    seconds. Keeping every full response made a one-hour failed qualification
    receipt grow without bound and made recovery through TAT impractical. The
    digest below still commits to the exact ordered observation stream; first
    and last snapshots preserve terminal diagnostics, and compact state changes
    retain the rollout sequence without turning the receipt into an access log.
    """

    EDGE_SAMPLES = 64

    def __init__(self):
        self.lock = threading.Lock()
        self.digest = hashlib.sha256()
        self.observation_count = 0
        self.error_count = 0
        self.first_snapshot = None
        self.last_snapshot = None
        self.last_state = None
        self.state_change_count = 0
        self.first_changes = []
        self.last_changes = collections.deque(maxlen=self.EDGE_SAMPLES)
        self.first_errors = []
        self.last_errors = collections.deque(maxlen=self.EDGE_SAMPLES)

    def _hash(self, kind, value):
        encoded = json.dumps(
            {"kind": kind, "value": value},
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.digest.update(len(encoded).to_bytes(8, "big"))
        self.digest.update(encoded)

    def record_snapshot(self, snapshot):
        snapshot = dict(snapshot)
        state = capacity_state(snapshot)
        with self.lock:
            self._hash("snapshot", snapshot)
            self.observation_count += 1
            if self.first_snapshot is None:
                self.first_snapshot = snapshot
            self.last_snapshot = snapshot
            if state != self.last_state:
                change = {"at": snapshot.get("at"), "state": state}
                self.state_change_count += 1
                if len(self.first_changes) < self.EDGE_SAMPLES:
                    self.first_changes.append(change)
                else:
                    self.last_changes.append(change)
                self.last_state = state

    def record_error(self, error):
        value = {"at": utc_now(), "error": str(error)}
        with self.lock:
            self._hash("error", value)
            self.error_count += 1
            if len(self.first_errors) < self.EDGE_SAMPLES:
                self.first_errors.append(value)
            else:
                self.last_errors.append(value)

    @staticmethod
    def _edge_samples(first, last, total):
        samples = list(first)
        if total > len(first):
            samples.extend(last)
        return samples

    def summary(self):
        with self.lock:
            changes = self._edge_samples(
                self.first_changes, self.last_changes, self.state_change_count
            )
            errors = self._edge_samples(
                self.first_errors, self.last_errors, self.error_count
            )
            return {
                "schema": "bounded-workload-timeline/v1",
                "observation_count": self.observation_count,
                "error_count": self.error_count,
                "stream_sha256": self.digest.hexdigest(),
                "state_change_count": self.state_change_count,
                "state_changes": changes,
                "state_changes_truncated": max(0, self.state_change_count - len(changes)),
                "errors": errors,
                "errors_truncated": max(0, self.error_count - len(errors)),
                "first_snapshot": self.first_snapshot,
                "last_snapshot": self.last_snapshot,
            }


def component_view(snapshot, prefix, pod_field):
    return {
        "template_sha256": snapshot[prefix + "_template_sha256"],
        "images": snapshot[prefix + "_images"],
        "pods": snapshot[pod_field],
    }


def target_images_from_environment():
    required = (
        "RIVET_RUNTIME_IMAGE",
        "RIVET_REPORTER_IMAGE",
        "RIVET_NATS_IMAGE",
        "RIVET_WORKERD_METRICS_IMAGE",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError("upgrade qualification target image environment is incomplete: {}".format(missing))
    runtime_image = os.environ["RIVET_RUNTIME_IMAGE"]
    reporter_image = os.environ["RIVET_REPORTER_IMAGE"]
    return {
        "engine": {"container/engine": runtime_image},
        "runtime": {
            "init/prepare-workerd-config": runtime_image,
            "container/workerd": runtime_image,
            "container/workerd-host": runtime_image,
            "container/workerd-metrics": os.environ["RIVET_WORKERD_METRICS_IMAGE"],
        },
        "nats": {"container/nats": os.environ["RIVET_NATS_IMAGE"]},
        "capacity": {"container/controller": reporter_image},
        "reporter": {"container/reporter": reporter_image},
    }


def wait_for_healthy_capacity(kube, timeout, require_replica_ownership=True):
    started = time.monotonic()
    deadline = started + timeout
    observations = []
    last_compact = None
    last_error = None
    while True:
        snapshot = workload_snapshot(kube)
        compact = compact_capacity_snapshot(snapshot)
        state = capacity_state(snapshot)
        if state != last_compact:
            observations.append(compact)
            last_compact = state
        try:
            assert_healthy_snapshot(snapshot, require_replica_ownership)
            return snapshot, {
                "elapsed_seconds": time.monotonic() - started,
                "observations": observations,
            }
        except RuntimeError as error:
            last_error = str(error)
        if time.monotonic() >= deadline:
            raise RuntimeError(
                "capacity did not converge within {} seconds: {}".format(timeout, last_error)
            )
        time.sleep(5)


def object_url(endpoint, worker, object_id):
    return "{}/v1/workers/{}/objects/{}/{}".format(
        endpoint,
        urllib.parse.quote(worker, safe=""),
        urllib.parse.quote(CLASS_NAME, safe=""),
        object_id,
    )


def fetch_value(endpoint, worker, object_id, operation, timeout=10):
    status, payload, elapsed, headers = json_request(
        "POST",
        object_url(endpoint, worker, object_id) + "/fetch",
        headers={"X-Workers-Original-URL": "https://agent.invalid/" + operation},
        expected=(200,),
        timeout=timeout,
    )
    if not isinstance(payload, dict) or not isinstance(payload.get("value"), int):
        raise RuntimeError("invalid Agent {} result: {}".format(operation, payload))
    response_request_id = next(
        (value for name, value in headers.items() if name.lower() == "x-request-id"),
        None,
    )
    return payload["value"], status, elapsed, response_request_id


class ProbeCampaign(object):
    def __init__(self, endpoint, worker, object_ids, concurrency, interval, max_seconds):
        self.endpoint = endpoint
        self.worker = worker
        self.object_ids = object_ids
        self.concurrency = concurrency
        self.interval = interval
        self.max_seconds = max_seconds
        self.stop_event = threading.Event()
        self.samples = []
        self.failures = []
        self.threads = []
        self.lock = threading.Lock()

    def _run(self, worker_index):
        cursor = worker_index
        while not self.stop_event.is_set():
            object_id = self.object_ids[cursor % len(self.object_ids)]
            cursor += self.concurrency
            started_at = utc_now()
            started = time.monotonic()
            sample = {"at": started_at, "object_id": object_id}
            try:
                value, status, elapsed, request_id = fetch_value(
                    self.endpoint, self.worker, object_id, "read", timeout=max(10, int(self.max_seconds + 2))
                )
                sample.update({
                    "status": status,
                    "seconds": elapsed,
                    "value": value,
                    "request_id": request_id,
                })
                if value != 1:
                    raise RuntimeError("Counter changed during release: {}".format(value))
                if elapsed >= self.max_seconds:
                    raise RuntimeError("public read exceeded {:.3f}s: {:.3f}s".format(self.max_seconds, elapsed))
            except Exception as error:
                sample.setdefault("seconds", time.monotonic() - started)
                sample["error"] = str(error)
                with self.lock:
                    self.failures.append(dict(sample))
            with self.lock:
                self.samples.append(sample)
            self.stop_event.wait(self.interval)

    def start(self):
        for index in range(self.concurrency):
            thread = threading.Thread(target=self._run, args=(index,), daemon=True)
            self.threads.append(thread)
            thread.start()

    def stop(self):
        self.stop_event.set()
        for thread in self.threads:
            thread.join(timeout=15)

    def receipt_summary(self):
        # The campaign can produce tens of thousands of successful probes. A
        # qualification receipt is durable evidence, not an access log: retain
        # exact aggregate/coverage evidence, a digest of the complete ordered
        # stream, and only bounded diagnostic samples.
        with self.lock:
            samples = [dict(item) for item in self.samples]
            failures = [dict(item) for item in self.failures]
        digest = hashlib.sha256()
        per_object = {}
        successful = 0
        latencies = []
        for sample in samples:
            encoded = json.dumps(sample, sort_keys=True, separators=(",", ":")).encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
            object_id = sample.get("object_id")
            entry = per_object.setdefault(object_id, {
                "object_id": object_id, "count": 0, "successful": 0,
                "failed": 0, "max_seconds": 0.0,
            })
            entry["count"] += 1
            seconds = sample.get("seconds")
            if isinstance(seconds, (int, float)):
                seconds = float(seconds)
                latencies.append(seconds)
                entry["max_seconds"] = max(entry["max_seconds"], seconds)
            if sample.get("error"):
                entry["failed"] += 1
            else:
                entry["successful"] += 1
                successful += 1
        return {
            "schema": "bounded-probe-summary/v1",
            "count": len(samples),
            "successful_count": successful,
            "failure_count": len(failures),
            "failures": failures[:64],
            "failures_truncated": max(0, len(failures) - 64),
            "stream_sha256": digest.hexdigest(),
            "max_seconds": max(latencies) if latencies else None,
            "p50_seconds": statistics.median(latencies) if latencies else None,
            "p99_seconds": percentile(latencies, 0.99) if latencies else None,
            "per_object": [per_object[key] for key in sorted(per_object)],
            "diagnostic_samples": (samples[:16] + samples[-16:]) if len(samples) > 32 else samples,
        }


def run_release(path, log_path, timeout):
    with open(str(log_path), "wb") as output:
        process = subprocess.Popen(
            [str(path)],
            stdout=output,
            stderr=subprocess.STDOUT,
            env=os.environ.copy(),
            start_new_session=True,
        )
        try:
            return process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                # release-runtime.sh handles TERM transactionally and may need
                # to roll workloads back serially. Do not turn a bounded gate
                # timeout into an unbounded half-rollback by killing it early.
                process.wait(timeout=900)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=30)
            raise RuntimeError("runtime release exceeded {} seconds".format(timeout))


def percentile(values, fraction):
    return soak.quantile(values, fraction)


def atomic_receipt(path, document):
    temporary = path.with_name("." + path.name + ".tmp." + str(os.getpid()))
    temporary.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
    os.chmod(str(temporary), 0o640)
    os.replace(str(temporary), str(path))


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--release-script", required=True, type=pathlib.Path)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--release-log", required=True, type=pathlib.Path)
    parser.add_argument("--objects", type=int, default=32)
    parser.add_argument("--probe-concurrency", type=int, default=20)
    parser.add_argument("--probe-interval", type=float, default=0.5)
    parser.add_argument("--pre-probe-seconds", type=float, default=5.0)
    parser.add_argument("--post-probe-seconds", type=float, default=10.0)
    parser.add_argument("--max-request-seconds", type=float, default=3.0)
    parser.add_argument("--release-timeout", type=int, default=3600)
    parser.add_argument("--capacity-convergence-timeout", type=int, default=900)
    args = parser.parse_args()
    if args.objects < 32 or args.probe_concurrency < 20:
        parser.error("qualification requires at least 32 Objects and 20 concurrent probes")
    if (args.probe_interval <= 0 or args.max_request_seconds <= 0 or args.release_timeout < 60
            or args.capacity_convergence_timeout < 60):
        parser.error("probe intervals, deadline and release timeout must be positive and bounded")
    if not args.release_script.is_absolute() or not args.release_script.is_file():
        parser.error("--release-script must be an existing absolute path")
    if not args.receipt.is_absolute() or not args.release_log.is_absolute():
        parser.error("receipt and release log paths must be absolute")
    return args


def main():
    args = parse_args()
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.release_log.parent.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    # DELETE Worker intentionally rejects every Worker with a Durable Object
    # namespace, even after all concrete Objects are gone. Reuse one named
    # qualification fixture so repeated release gates do not create immortal
    # Worker/Version inventories. The global operation lock excludes overlap.
    worker = "q01-platform-upgrade-gate"
    object_ids = [hashlib.sha256((run_id + ":" + str(index)).encode()).hexdigest()
                  for index in range(args.objects)]
    receipt = {
        "schema": "actor-bj-q01-user-transparent-upgrade/v4",
        "cell": CELL,
        "namespace": NAMESPACE,
        "run_id": run_id,
        "worker": worker,
        "started_at": utc_now(),
        "parameters": {
            "objects": args.objects,
            "probe_concurrency": args.probe_concurrency,
            "probe_interval": args.probe_interval,
            "pre_probe_seconds": args.pre_probe_seconds,
            "post_probe_seconds": args.post_probe_seconds,
            "max_request_seconds": args.max_request_seconds,
            "release_timeout": args.release_timeout,
            "capacity_convergence_timeout": args.capacity_convergence_timeout,
        },
        "worker_source_sha256": hashlib.sha256(WORKER_SOURCE.encode()).hexdigest(),
        "public_api_only": True,
        "verdict": "running",
    }
    port_forward = None
    campaign = None
    timeline_stop = threading.Event()
    timeline_thread = None
    kube = soak.Kubectl(args.kubeconfig)
    endpoint = None
    cleanup_errors = []
    failure = None
    timeline = BoundedWorkloadTimeline()
    try:
        # The first ledger-enabled release is itself allowed to transfer a
        # legacy static replicas owner. The post-release state is not.
        before, pre_capacity = wait_for_healthy_capacity(
            kube, args.capacity_convergence_timeout, require_replica_ownership=False
        )
        receipt["before"] = before
        receipt["pre_capacity_convergence"] = pre_capacity
        port_forward = soak.PortForward(
            args.kubeconfig, NAMESPACE, "service/" + CELL + "-workers-api", 8080, "/readyz"
        )
        port_forward.wait()
        endpoint = port_forward.endpoint

        _, version, _, _ = json_request(
            "POST", endpoint + "/v1/workers/" + worker + "/versions",
            {
                "main_module": "main.js",
                "modules": {"main.js": WORKER_SOURCE},
                "compatibility_date": COMPATIBILITY_DATE,
                "durable_objects": {"AGENT": CLASS_NAME},
            },
            expected=(201,), timeout=30,
        )
        assert_public_resource(version, "version")
        version_id = version["id"]
        _, deployment, _, _ = json_request(
            "POST", endpoint + "/v1/workers/" + worker + "/deployments",
            {"version_id": version_id}, expected=(200, 201), timeout=60,
        )
        assert_public_resource(deployment, "deployment")
        receipt["version_id"] = version_id
        receipt["deployment_id"] = deployment["id"]

        object_refs = {}
        def create_one(object_id):
            _, value, elapsed, _ = json_request(
                "PUT", object_url(endpoint, worker, object_id), expected=(200, 201), timeout=15
            )
            assert_public_resource(value, "object")
            expected_ref = {
                "object": "object", "id": object_id, "worker": worker, "class_name": CLASS_NAME
            }
            if value != expected_ref:
                raise RuntimeError("unstable ObjectRef: {}".format(value))
            return object_id, value, elapsed

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.probe_concurrency) as pool:
            for object_id, value, elapsed in pool.map(create_one, object_ids):
                object_refs[object_id] = value
        receipt["object_refs"] = [object_refs[item] for item in object_ids]

        def initialize_one(object_id):
            value, _, elapsed, _ = fetch_value(endpoint, worker, object_id, "increment")
            if value != 1:
                raise RuntimeError("initial Counter value was not 1: {}".format(value))
            return elapsed

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.probe_concurrency) as pool:
            initial_latencies = list(pool.map(initialize_one, object_ids))
        receipt["initial_write_seconds"] = {
            "max": max(initial_latencies),
            "p50": statistics.median(initial_latencies),
            "p99": percentile(initial_latencies, 0.99),
        }
        if max(initial_latencies) >= args.max_request_seconds:
            raise RuntimeError("initial public writes exceeded the request SLO")

        _, public_worker_before, _, _ = json_request(
            "GET", endpoint + "/v1/workers/" + worker, expected=(200,), timeout=15
        )
        assert_public_resource(public_worker_before, "worker")
        receipt["public_worker_before"] = public_worker_before

        campaign = ProbeCampaign(
            endpoint, worker, object_ids, args.probe_concurrency,
            args.probe_interval, args.max_request_seconds,
        )
        campaign.start()
        def record_timeline():
            while not timeline_stop.is_set():
                try:
                    timeline.record_snapshot(workload_snapshot(kube))
                except Exception as error:
                    timeline.record_error(error)
                timeline_stop.wait(2)
        timeline_thread = threading.Thread(target=record_timeline, daemon=True)
        timeline_thread.start()
        time.sleep(args.pre_probe_seconds)
        if len(campaign.samples) < args.probe_concurrency or campaign.failures:
            raise RuntimeError("public pre-release probe did not establish a clean baseline")

        receipt["release_started_at"] = utc_now()
        release_status = run_release(args.release_script, args.release_log, args.release_timeout)
        receipt["release_finished_at"] = utc_now()
        receipt["release_exit_code"] = release_status
        if release_status != 0:
            raise RuntimeError("runtime release exited {}".format(release_status))
        time.sleep(args.post_probe_seconds)
        campaign.stop()
        timeline_stop.set()
        timeline_thread.join(timeout=15)
        timeline_summary = timeline.summary()
        receipt["timeline"] = timeline_summary
        receipt["timeline_errors"] = timeline_summary["errors"]
        receipt["public_probe"] = campaign.receipt_summary()

        after, post_capacity = wait_for_healthy_capacity(
            kube, args.capacity_convergence_timeout
        )
        receipt["after"] = after
        receipt["post_capacity_convergence"] = post_capacity
        receipt["runtime_replica_delta"] = (
            after["runtime_spec_replicas"] - before["runtime_spec_replicas"]
        )
        receipt["target_images"] = assert_target_images(
            {
                name: component_view(after, name, pod_field)
                for name, pod_field in (
                    ("engine", "engine_pods"),
                    ("runtime", "runtime_pods"),
                    ("nats", "nats_pods"),
                    ("capacity", "capacity_pods"),
                    ("reporter", "reporter_pods"),
                )
            },
            target_images_from_environment(),
        )
        receipt["component_transitions"] = [
            assert_component_transition(
                name,
                component_view(before, name, pod_field),
                component_view(after, name, pod_field),
                scalable=(name == "runtime"),
            )
            for name, pod_field in (
                ("engine", "engine_pods"),
                ("runtime", "runtime_pods"),
                ("nats", "nats_pods"),
                ("capacity", "capacity_pods"),
                ("reporter", "reporter_pods"),
            )
        ]
        if after.get("ledger") is None:
            raise RuntimeError("release completed without a static release ledger")

        _, public_worker_after, _, _ = json_request(
            "GET", endpoint + "/v1/workers/" + worker, expected=(200,), timeout=15
        )
        assert_public_resource(public_worker_after, "worker")
        receipt["public_worker_after"] = public_worker_after
        if public_worker_after != public_worker_before:
            raise RuntimeError("Worker/Version/Deployment public identity changed during platform release")

        # A semantic candidate can be Kubernetes-healthy yet user-visible wrong.
        # Capture its exact images, template transitions and stable Worker identity
        # before failing the gate. Those facts are the only authority for a later
        # exact rollback; a transient dependency error must not authorize one.
        if campaign.failures:
            raise RuntimeError("public /v1 requests failed during release: {}".format(campaign.failures[:3]))

        def verify_one(object_id):
            _, ref, _, _ = json_request(
                "PUT", object_url(endpoint, worker, object_id), expected=(200, 201), timeout=15
            )
            assert_public_resource(ref, "object")
            if ref != object_refs[object_id]:
                raise RuntimeError("ObjectRef changed after release")
            value, _, elapsed, _ = fetch_value(endpoint, worker, object_id, "increment")
            if value != 2:
                raise RuntimeError("Counter did not advance exactly from 1 to 2: {}".format(value))
            read, _, _, _ = fetch_value(endpoint, worker, object_id, "read")
            if read != 2:
                raise RuntimeError("Counter read-back was not 2: {}".format(read))
            return elapsed

        with concurrent.futures.ThreadPoolExecutor(max_workers=args.probe_concurrency) as pool:
            final_latencies = list(pool.map(verify_one, object_ids))
        if max(final_latencies) >= args.max_request_seconds:
            raise RuntimeError("post-release write exceeded the public request SLO")
        receipt["post_release_write_seconds"] = {
            "max": max(final_latencies),
            "p50": statistics.median(final_latencies),
            "p99": percentile(final_latencies, 0.99),
        }
        receipt["verdict"] = "passed"
    except Exception as error:
        failure = error
        receipt["verdict"] = "failed"
        receipt["error"] = str(error)
    finally:
        if campaign is not None:
            campaign.stop()
            receipt.setdefault("public_probe", campaign.receipt_summary())
        timeline_stop.set()
        if timeline_thread is not None:
            timeline_thread.join(timeout=15)
        timeline_summary = timeline.summary()
        receipt.setdefault("timeline", timeline_summary)
        receipt.setdefault("timeline_errors", timeline_summary["errors"])
        retain_for_rollback = bool(
            receipt.get("release_exit_code") == 0
            and receipt.get("public_probe", {}).get("failures")
            and receipt.get("target_images")
            and receipt.get("component_transitions")
            and receipt.get("public_worker_after") == receipt.get("public_worker_before")
        )
        receipt["rollback_objects_retained"] = retain_for_rollback
        if endpoint is not None and not retain_for_rollback:
            for object_id in object_ids:
                try:
                    json_request(
                        "DELETE", object_url(endpoint, worker, object_id),
                        expected=(204, 404), timeout=30,
                    )
                except Exception as error:
                    cleanup_errors.append("object {}: {}".format(object_id, error))
            receipt["worker_fixture_retained"] = True
        elif endpoint is not None:
            receipt["worker_fixture_retained"] = True
            receipt["rollback_object_refs"] = [object_refs[item] for item in object_ids]
        if port_forward is not None:
            port_forward.close()
        if args.release_log.exists():
            receipt["release_log"] = {
                "path": str(args.release_log),
                "bytes": args.release_log.stat().st_size,
                "sha256": hashlib.sha256(args.release_log.read_bytes()).hexdigest(),
            }
        receipt["cleanup_errors"] = cleanup_errors
        receipt["finished_at"] = utc_now()
        if cleanup_errors and receipt["verdict"] == "passed":
            receipt["verdict"] = "failed"
            receipt["error"] = "public resource cleanup was incomplete"
            failure = RuntimeError(receipt["error"])
        atomic_receipt(args.receipt, receipt)
        print("receipt={} verdict={}".format(args.receipt, receipt["verdict"]))
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
