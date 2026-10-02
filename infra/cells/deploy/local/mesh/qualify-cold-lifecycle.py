#!/usr/bin/env python3
"""Qualify natural Depot cooling and crash boundaries against a configured S3 endpoint."""

import argparse
import base64
import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


HELPERS_PATH = pathlib.Path(__file__).with_name("qualify-real-cos-outage.py")
SPEC = importlib.util.spec_from_file_location("cold_lifecycle_helpers", HELPERS_PATH)
helpers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helpers)

NAMESPACE = "actor-fdb-cell-system"
SCHEMA = "rivet-cold-lifecycle-qualification/v1"


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--hub-kubeconfig")
    parser.add_argument("--cell", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--endpoint-kind", choices=("local-s3", "tencent-cos"), required=True)
    parser.add_argument("--engine-port", type=int, default=24420)
    parser.add_argument("--depot-port", type=int, default=24421)
    parser.add_argument("--fill-bytes", type=int, default=1024 * 1024)
    parser.add_argument("--natural-retention-ms", type=int, default=2_000)
    parser.add_argument("--timeout-seconds", type=float, default=420)
    parser.add_argument("--preserve-on-failure", action="store_true")
    parser.add_argument(
        "--scenarios",
        default="natural,put-response-loss,published-restart,cold-only-restart,retry-429,retry-503",
    )
    return parser.parse_args()


def kubectl(kubeconfig, *command, timeout=300):
    return subprocess.run(
        ["kubectl", "--kubeconfig", kubeconfig, *command],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
    ).stdout


def raw_request(method, url, body=None, headers=None, timeout=30):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class ColdLifecycleQualification:
    def __init__(self, args):
        self.args = args
        self.engine = f"http://127.0.0.1:{args.engine_port}"
        self.depot = f"http://127.0.0.1:{args.depot_port}"
        self.namespace_id = None
        self.engine_forward = helpers.PortForward(
            args.kubeconfig,
            NAMESPACE,
            f"{args.cell}-engine",
            [f"{args.engine_port}:6420", f"{args.depot_port}:6421"],
        )
        self.admin_forward = None
        self.admin_url = None
        self.admin_headers = None
        self.actors = set()
        self.cold_bucket = None
        self.diagnostics = {}
        self.failed = False

    def start(self):
        self.engine_forward.start()
        namespaces = helpers.request_json("GET", f"{self.depot}/namespaces?name=default")
        self.namespace_id = namespaces["namespaces"][0]["namespace_id"]
        if self.args.endpoint_kind == "local-s3":
            if not self.args.hub_kubeconfig:
                raise ValueError("--hub-kubeconfig is required for local-s3 qualification")
            port = free_port()
            self.admin_forward = helpers.PortForward(
                self.args.hub_kubeconfig,
                "runtime-cold-tier-system",
                "runtime-cold-tier",
                [f"{port}:8080"],
            )
            self.admin_forward.start()
            token = base64.b64decode(
                kubectl(
                    self.args.hub_kubeconfig,
                    "-n",
                    "runtime-cold-tier-system",
                    "get",
                    "secret",
                    "runtime-cold-tier-admin",
                    "-o",
                    "jsonpath={.data.token}",
                )
            ).decode()
            self.admin_url = f"http://127.0.0.1:{port}"
            self.admin_headers = {"X-Local-S3-Admin-Token": token}
            self.admin("DELETE", "/__admin/fault")
            self.admin("DELETE", "/__admin/gate?point=put_after_commit")
            self.admin("DELETE", "/__admin/stats")

    def stop(self):
        if self.admin_url:
            try:
                self.admin("DELETE", "/__admin/fault", expected=(204,))
                self.admin("DELETE", "/__admin/gate?point=put_after_commit", expected=(204,))
            except Exception as error:
                self.diagnostics["admin_cleanup_error"] = str(error)
        if not self.failed or not self.args.preserve_on_failure:
            for actor_id in list(self.actors):
                self.cleanup_actor(actor_id)
        self.engine_forward.stop()
        if self.admin_forward:
            self.admin_forward.stop()

    def admin(self, method, path, expected=(200, 204)):
        status, body = raw_request(
            method,
            self.admin_url + path,
            headers=self.admin_headers,
            timeout=30,
        )
        if status not in expected:
            raise RuntimeError(f"local S3 admin {method} {path} returned {status}: {body!r}")
        return json.loads(body or b"{}")

    def stats(self):
        if not self.admin_url:
            return None
        return self.admin("GET", "/__admin/stats")

    def runtime_config(self):
        document = json.loads(
            kubectl(
                self.args.kubeconfig,
                "-n",
                NAMESPACE,
                "get",
                "configmap",
                f"{self.args.cell}-runtime-config",
                "-o",
                "json",
            )
        )
        return json.loads(document["data"]["config.jsonc"])

    def actor_url(self, actor_id, suffix):
        return f"{self.engine}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

    def state(self, actor_id):
        return helpers.request_json(
            "GET",
            f"{self.depot}/depot/inspect/buckets/{self.namespace_id}/databases/"
            f"{actor_id}/bottomless-state",
            timeout=15,
        )

    def checkpoint(self, actor_id, *, force_reclaim=True):
        return helpers.request_json(
            "POST",
            f"{self.depot}/depot/checkpoints/buckets/{self.namespace_id}/databases/{actor_id}",
            {"force_reclaim": force_reclaim},
            timeout=30,
        )

    def set_retention(self, actor_id, retention_ms):
        payload = helpers.request_json(
            "PUT",
            f"{self.depot}/depot/qualification/buckets/{self.namespace_id}/databases/"
            f"{actor_id}/shard-cache-policy",
            {"retention_ms": retention_ms},
        )
        if int(payload["retention_ms"]) != retention_ms:
            raise RuntimeError("Depot did not apply the requested qualification retention")

    def create_actor(self, scenario):
        query = urllib.parse.urlencode({"namespace": "default"})
        created = helpers.request_json(
            "POST",
            f"{self.engine}/actors?{query}",
            {
                "name": "workerd-counter",
                "key": f"cold-lifecycle-{scenario}-{time.time_ns()}",
                "runner_name_selector": "workerd",
                "crash_policy": "restart",
            },
        )
        actor_id = created["actor"]["actor_id"]
        self.actors.add(actor_id)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                ready = helpers.request_json("GET", self.actor_url(actor_id, "/counter"), timeout=10)
                if ready.get("actorId") == actor_id:
                    return actor_id, ready
            except Exception:
                pass
            time.sleep(0.25)
        raise TimeoutError(f"Actor {actor_id} did not become ready")

    def fill(self, actor_id):
        chunk_bytes = 256 * 1024
        for chunk, offset in enumerate(range(0, self.args.fill_bytes, chunk_bytes)):
            size = min(chunk_bytes, self.args.fill_bytes - offset)
            helpers.request_json(
                "POST",
                self.actor_url(actor_id, f"/bottomless-fill?chunk={chunk}&bytes={size}"),
                timeout=60,
            )

    def sleep_actor(self, actor_id):
        query = urllib.parse.urlencode({"namespace": "default"})
        helpers.request_json(
            "POST",
            f"{self.engine}/actors/{urllib.parse.quote(actor_id, safe='')}/sleep?{query}",
            {},
        )
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            actors = helpers.request_json(
                "GET", f"{self.engine}/actors?{query}&actor_id={actor_id}"
            ).get("actors", [])
            if len(actors) == 1 and (
                actors[0].get("sleep_ts") is not None
                or actors[0].get("sleepTs") is not None
            ):
                return
            time.sleep(0.25)
        raise TimeoutError(f"Actor {actor_id} did not sleep")

    def wait_state(self, actor_id, predicate, timeout=None):
        deadline = time.monotonic() + (timeout or self.args.timeout_seconds)
        last = None
        while time.monotonic() < deadline:
            last = self.state(actor_id)
            if predicate(last):
                return last
            time.sleep(0.5)
        raise TimeoutError(f"Actor {actor_id} did not reach expected cold state: {last}")

    def wait_cold(self, actor_id):
        return self.wait_state(
            actor_id,
            lambda state: state.get("cold_ready") is True
            and state["row_counts"]["hot_shards"]["count"] == 0
            and state["row_counts"]["staged_hot_shards"]["count"] == 0,
        )

    def verify_wake(self, actor_id, generation_before):
        started = time.perf_counter()
        wake = helpers.request_json("GET", self.actor_url(actor_id, "/counter"), timeout=60)
        wake_ms = (time.perf_counter() - started) * 1_000
        verified = helpers.request_json(
            "GET", self.actor_url(actor_id, "/bottomless-verify"), timeout=120
        )
        expected_chunks = (self.args.fill_bytes + 256 * 1024 - 1) // (256 * 1024)
        if int(verified.get("bottomlessBytes", -1)) != self.args.fill_bytes:
            raise RuntimeError("cold wake returned the wrong byte count")
        if int(verified.get("bottomlessChunks", -1)) != expected_chunks:
            raise RuntimeError("cold wake returned the wrong chunk count")
        if int(verified.get("bottomlessCorruptChunks", -1)) != 0:
            raise RuntimeError("cold wake detected corrupt bytes")
        if int(wake.get("generation", 0)) <= generation_before:
            raise RuntimeError("cold wake did not advance Actor generation")
        return {
            "wake_ms": wake_ms,
            "generation_before": generation_before,
            "generation_after": int(wake["generation"]),
            "bytes": int(verified["bottomlessBytes"]),
            "chunks": int(verified["bottomlessChunks"]),
            "corrupt_chunks": int(verified["bottomlessCorruptChunks"]),
        }

    def cleanup_actor(self, actor_id):
        try:
            helpers.request_json(
                "DELETE",
                f"{self.depot}/depot/qualification/buckets/{self.namespace_id}/databases/"
                f"{actor_id}/shard-cache-policy",
                timeout=10,
            )
        except Exception:
            pass
        query = urllib.parse.urlencode({"namespace": "default"})
        try:
            helpers.request_json(
                "DELETE",
                f"{self.engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}",
                timeout=15,
            )
        except Exception:
            pass
        self.actors.discard(actor_id)

    def engine_uid(self):
        payload = json.loads(
            kubectl(
                self.args.kubeconfig,
                "-n",
                NAMESPACE,
                "get",
                "pods",
                "-l",
                f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=engine",
                "-o",
                "json",
            )
        )
        running = [
            item
            for item in payload["items"]
            if item.get("status", {}).get("phase") == "Running"
            and item["metadata"].get("deletionTimestamp") is None
        ]
        if len(running) != 1:
            raise RuntimeError(f"expected one running Engine Pod, got {len(running)}")
        return running[0]["metadata"]["uid"]

    def restart_engine(self):
        before = self.engine_uid()
        self.engine_forward.stop()
        kubectl(
            self.args.kubeconfig,
            "-n",
            NAMESPACE,
            "rollout",
            "restart",
            f"deployment/{self.args.cell}-engine",
        )
        kubectl(
            self.args.kubeconfig,
            "-n",
            NAMESPACE,
            "rollout",
            "status",
            f"deployment/{self.args.cell}-engine",
            "--timeout=5m",
            timeout=330,
        )
        after = self.engine_uid()
        if before == after:
            raise RuntimeError("Engine restart did not replace its Pod UID")
        self.engine_forward.start()
        return {"pod_uid_before": before, "pod_uid_after": after}

    def natural(self):
        actor_id, ready = self.create_actor("natural")
        succeeded = False
        try:
            self.set_retention(actor_id, self.args.natural_retention_ms)
            self.fill(actor_id)
            started = time.monotonic()
            self.sleep_actor(actor_id)
            milestones = {}
            peaks = {"hot_shards": 0, "staged_hot_shards": 0, "write_debt_bytes": 0}
            deadline = started + self.args.timeout_seconds
            settled = None
            while time.monotonic() < deadline:
                state = self.state(actor_id)
                self.diagnostics["natural_actor_id"] = actor_id
                self.diagnostics["natural_last_state"] = state
                elapsed_ms = (time.monotonic() - started) * 1_000
                rows = state["row_counts"]
                peaks["hot_shards"] = max(peaks["hot_shards"], rows["hot_shards"]["count"])
                peaks["staged_hot_shards"] = max(
                    peaks["staged_hot_shards"], rows["staged_hot_shards"]["count"]
                )
                peaks["write_debt_bytes"] = max(
                    peaks["write_debt_bytes"], int(state["fdb_write_debt_bytes"])
                )
                if rows["cold_publish_markers"]["count"] > 0:
                    milestones.setdefault("cold_marker_ms", elapsed_ms)
                if state.get("cold_ready") is True:
                    milestones.setdefault("cold_ready_ms", elapsed_ms)
                if (
                    state.get("cold_ready") is True
                    and rows["hot_shards"]["count"] == 0
                    and rows["staged_hot_shards"]["count"] == 0
                ):
                    milestones.setdefault("hot_reclaimed_ms", elapsed_ms)
                    settled = state
                    break
                time.sleep(0.5)
            if settled is None:
                raise TimeoutError("natural cooling did not settle without a checkpoint")
            result = {
                "verdict": "passed",
                "actor_id": actor_id,
                "trigger": "depot-periodic-planner-after-write-quiescence",
                "external_checkpoint_requests": 0,
                "force_reclaim_requests": 0,
                "sleep_checkpoint_expected": False,
                "retention_ms": self.args.natural_retention_ms,
                "milestones": milestones,
                "peaks": peaks,
                "cold_state": {
                    "head_txid": settled["head"]["head_txid"],
                    "cold_watermark_txid": settled["compaction_root"]["cold_watermark_txid"],
                    "hot_shards": settled["row_counts"]["hot_shards"]["count"],
                    "staged_hot_shards": settled["row_counts"]["staged_hot_shards"]["count"],
                },
                "recovery": self.verify_wake(actor_id, int(ready["generation"])),
            }
            succeeded = True
            return result
        finally:
            if succeeded or not self.args.preserve_on_failure:
                self.cleanup_actor(actor_id)

    def prepare_forced(self, scenario, retention_ms=1):
        actor_id, ready = self.create_actor(scenario)
        self.set_retention(actor_id, retention_ms)
        self.fill(actor_id)
        self.sleep_actor(actor_id)
        return actor_id, ready

    def put_response_loss(self):
        if not self.admin_url:
            return {"verdict": "not_applicable", "reason": "endpoint has no deterministic gate"}
        actor_id, ready = self.prepare_forced("put-response-loss")
        try:
            self.admin("PUT", "/__admin/gate?point=put_after_commit")
            self.checkpoint(actor_id)
            deadline = time.monotonic() + self.args.timeout_seconds
            while time.monotonic() < deadline:
                stats = self.stats()
                if stats["gates"].get("put_after_commit", {}).get("waiting", 0) > 0:
                    break
                time.sleep(0.1)
            else:
                raise TimeoutError("cold PUT did not reach the durable response-loss gate")
            restart = self.restart_engine()
            self.admin("DELETE", "/__admin/gate?point=put_after_commit")
            checkpoint = self.checkpoint(actor_id)
            settled = self.wait_cold(actor_id)
            return {
                "verdict": "passed",
                "actor_id": actor_id,
                "boundary": "object durable before PUT response",
                "engine_restart": restart,
                "checkpoint_contract_version": checkpoint["checkpoint_contract_version"],
                "cold_watermark_txid": settled["compaction_root"]["cold_watermark_txid"],
                "recovery": self.verify_wake(actor_id, int(ready["generation"])),
            }
        finally:
            self.admin("DELETE", "/__admin/gate?point=put_after_commit")
            self.cleanup_actor(actor_id)

    def published_restart(self):
        actor_id, ready = self.prepare_forced("published-restart", retention_ms=600_000)
        try:
            checkpoint = self.checkpoint(actor_id, force_reclaim=False)
            published = self.wait_state(
                actor_id,
                lambda state: state["row_counts"]["cold_publish_markers"]["count"] > 0
                and state["row_counts"]["hot_shards"]["count"] > 0,
            )
            restart = self.restart_engine()
            self.set_retention(actor_id, 1)
            self.checkpoint(actor_id)
            settled = self.wait_cold(actor_id)
            return {
                "verdict": "passed",
                "actor_id": actor_id,
                "boundary": "cold marker committed while FDB hot rows remain",
                "engine_restart": restart,
                "published_hot_shards": published["row_counts"]["hot_shards"]["count"],
                "checkpoint_target_txid": checkpoint["target_head_txid"],
                "cold_watermark_txid": settled["compaction_root"]["cold_watermark_txid"],
                "recovery": self.verify_wake(actor_id, int(ready["generation"])),
            }
        finally:
            self.cleanup_actor(actor_id)

    def cold_only_restart(self):
        actor_id, ready = self.prepare_forced("cold-only-restart")
        try:
            self.checkpoint(actor_id)
            settled = self.wait_cold(actor_id)
            restart = self.restart_engine()
            return {
                "verdict": "passed",
                "actor_id": actor_id,
                "boundary": "FDB hot rows cleared after atomic cold publish",
                "engine_restart": restart,
                "hot_shards_before_restart": settled["row_counts"]["hot_shards"]["count"],
                "staged_hot_shards_before_restart": settled["row_counts"]["staged_hot_shards"]["count"],
                "recovery": self.verify_wake(actor_id, int(ready["generation"])),
            }
        finally:
            self.cleanup_actor(actor_id)

    def bounded_retry(self, status):
        if not self.admin_url:
            return {"verdict": "not_applicable", "reason": "real endpoint fault injection is external"}
        actor_id, ready = self.prepare_forced(f"retry-{status}")
        try:
            before = self.stats()
            self.admin(
                "PUT",
                f"/__admin/fault?operation=put&status={status}&count=2&delay_ms=25",
            )
            started = time.monotonic()
            self.checkpoint(actor_id)
            settled = self.wait_cold(actor_id)
            elapsed_ms = (time.monotonic() - started) * 1_000
            after = self.stats()
            if not self.cold_bucket:
                raise RuntimeError("runtime cold bucket was not loaded")
            bucket = self.cold_bucket
            before_put = before.get("requests", {}).get(bucket, {}).get("put", {})
            after_put = after.get("requests", {}).get(bucket, {}).get("put", {})
            failed_delta = int(after_put.get("failed", 0)) - int(before_put.get("failed", 0))
            request_delta = int(after_put.get("requests", 0)) - int(before_put.get("requests", 0))
            if failed_delta < 2 or request_delta < 3:
                raise RuntimeError(
                    f"HTTP {status} did not exercise bounded SDK retry: "
                    f"requests={request_delta}, failed={failed_delta}"
                )
            return {
                "verdict": "passed",
                "actor_id": actor_id,
                "status": status,
                "injected_failures": failed_delta,
                "put_attempts": request_delta,
                "elapsed_ms": elapsed_ms,
                "max_put_concurrency": int(after_put.get("max_active", 0)),
                "cold_watermark_txid": settled["compaction_root"]["cold_watermark_txid"],
                "recovery": self.verify_wake(actor_id, int(ready["generation"])),
            }
        finally:
            self.admin("DELETE", "/__admin/fault?operation=put")
            self.cleanup_actor(actor_id)


def main():
    args = parse_args()
    requested = [value.strip() for value in args.scenarios.split(",") if value.strip()]
    allowed = {
        "natural",
        "put-response-loss",
        "published-restart",
        "cold-only-restart",
        "retry-429",
        "retry-503",
    }
    unknown = sorted(set(requested) - allowed)
    if unknown:
        raise SystemExit(f"unknown scenarios: {', '.join(unknown)}")
    if args.fill_bytes <= 0 or args.natural_retention_ms <= 0 or args.timeout_seconds <= 0:
        raise SystemExit("fill, retention, and timeout values must be positive")

    qualification = ColdLifecycleQualification(args)
    receipt = {
        "schema": SCHEMA,
        "verdict": "failed",
        "cell": args.cell,
        "endpoint_kind": args.endpoint_kind,
        "requested_scenarios": requested,
        "scenarios": {},
        "scale_coverage": {
            "actor_count": 1,
            "actor_1000": "not_run",
            "actor_10000": "not_run",
            "reason": "lifecycle qualification is a correctness gate, not a scale claim",
        },
    }
    failure = None
    try:
        qualification.start()
        config = qualification.runtime_config()
        cold = config["sqlite"]["workflow_cold_storage"]["s3"]
        qualification.cold_bucket = cold["bucket"]
        receipt["effective_policy"] = {
            "fill_bytes": args.fill_bytes,
            "natural_retention_ms": args.natural_retention_ms,
            "write_debt_target_bytes": config["sqlite"]["workflow_write_debt"]["target_bytes"],
            "write_debt_limit_bytes": config["sqlite"]["workflow_write_debt"]["limit_bytes"],
            "max_object_size_bytes": cold["max_object_size_bytes"],
            "max_concurrent_requests": cold["max_concurrent_requests"],
            "recovery_window_ms": cold["recovery_window_ms"],
            "bucket": cold["bucket"],
            "region": cold["region"],
        }
        handlers = {
            "natural": qualification.natural,
            "put-response-loss": qualification.put_response_loss,
            "published-restart": qualification.published_restart,
            "cold-only-restart": qualification.cold_only_restart,
            "retry-429": lambda: qualification.bounded_retry(429),
            "retry-503": lambda: qualification.bounded_retry(503),
        }
        for scenario in requested:
            started = time.monotonic()
            result = handlers[scenario]()
            result["duration_ms"] = (time.monotonic() - started) * 1_000
            receipt["scenarios"][scenario] = result
        receipt["object_store_stats"] = qualification.stats()
        receipt["verdict"] = "passed"
    except Exception as error:
        failure = error
        qualification.failed = True
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        receipt["diagnostics"] = qualification.diagnostics
    finally:
        qualification.stop()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, args.output)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if failure:
        raise failure


if __name__ == "__main__":
    main()
