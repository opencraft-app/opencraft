#!/usr/bin/env python3
"""Qualify FDB-hot continuity and exact cold recovery across a real COS outage."""

import argparse
import json
import os
import pathlib
import re
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def request_json(method, url, body=None, timeout=30):
    encoded = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=encoded,
        method=method,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return json.loads(payload or b"{}")


class PortForward:
    def __init__(self, kubeconfig, namespace, service, mappings):
        self.command = [
            "kubectl",
            "--kubeconfig",
            kubeconfig,
            "-n",
            namespace,
            "port-forward",
            f"service/{service}",
            *mappings,
        ]
        self.process = None

    def start(self):
        self.stop()
        self.process = subprocess.Popen(
            self.command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if "Forwarding from" in line:
                return
            if self.process.poll() is not None:
                raise RuntimeError(f"port-forward exited early: {line.strip()}")
        raise TimeoutError("port-forward did not become ready")

    def stop(self):
        if self.process is None:
            return
        self.process.send_signal(signal.SIGINT)
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process = None


def kubectl(args, *command, input_text=None, timeout=300):
    return subprocess.run(
        ["kubectl", "--kubeconfig", args.kubeconfig, *command],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        timeout=timeout,
    ).stdout


def metric_sum(text, name, labels=None):
    labels = labels or {}
    total = 0.0
    found = False
    pattern = re.compile(rf"^{re.escape(name)}(?:\{{([^}}]*)\}})?\s+([^\s]+)$")
    for line in text.splitlines():
        match = pattern.match(line)
        if not match:
            continue
        encoded_labels = match.group(1) or ""
        parsed = dict(re.findall(r'(\w+)="([^"]*)"', encoded_labels))
        if any(parsed.get(key) != value for key, value in labels.items()):
            continue
        total += float(match.group(2))
        found = True
    if not found:
        raise RuntimeError(f"metric {name} with labels {labels} was absent")
    return total


def validate_recovered_state(checkpoint_result, outage_state, recovered_state):
    if recovered_state.get("cold_ready") is not True:
        raise RuntimeError("recovered state is not cold-ready")
    if recovered_state.get("branch_id") != outage_state.get("branch_id"):
        raise RuntimeError("database branch identity changed across Engine restart")
    root = recovered_state.get("compaction_root")
    if root is None:
        raise RuntimeError("cold-ready state has no compaction root")
    checkpoint_txid = int(checkpoint_result["target_head_txid"])
    outage_txid = int(outage_state["head"]["head_txid"])
    recovered_txid = int(recovered_state["head"]["head_txid"])
    cold_txid = int(root["cold_watermark_txid"])
    hot_txid = int(root["hot_watermark_txid"])
    if outage_txid <= checkpoint_txid:
        raise RuntimeError("outage workload did not advance beyond the checkpoint")
    if recovered_txid < outage_txid:
        raise RuntimeError("recovery rolled the database head backwards")
    if cold_txid < outage_txid:
        raise RuntimeError("cold recovery omitted acknowledged post-checkpoint writes")
    if cold_txid != recovered_txid or hot_txid != recovered_txid:
        raise RuntimeError("cold/hot watermarks do not exactly cover the recovered head")


def engine_pod_uid(args, namespace):
    payload = json.loads(
        kubectl(
            args,
            "-n",
            namespace,
            "get",
            "pods",
            "-l",
            f"fleet.actor.dev/cell-name={args.cell},fleet.actor.dev/component=engine",
            "-o",
            "json",
        )
    )
    running = [
        item
        for item in payload.get("items", [])
        if item.get("status", {}).get("phase") == "Running"
        and item.get("metadata", {}).get("deletionTimestamp") is None
    ]
    if len(running) != 1:
        raise RuntimeError(f"expected exactly one running Engine Pod, found {len(running)}")
    return running[0]["metadata"]["uid"]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kubeconfig", required=True)
    parser.add_argument("--cell", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--engine-port", type=int, default=21420)
    parser.add_argument("--depot-port", type=int, default=21421)
    parser.add_argument("--metrics-port", type=int, default=21430)
    parser.add_argument("--fill-bytes", type=int, default=4 * 1024 * 1024)
    parser.add_argument("--outage-seconds", type=float, default=20)
    parser.add_argument("--recovery-timeout-seconds", type=float, default=300)
    parser.add_argument("--storage-profile-id")
    parser.add_argument("--expected-fdb-cluster")
    parser.add_argument("--expected-cold-bucket")
    parser.add_argument("--expected-cold-endpoint")
    parser.add_argument("--expected-max-object-size-bytes", type=int)
    parser.add_argument("--expected-recovery-window-ms", type=int)
    parser.add_argument(
        "--evidence-schema", default="rivet-local-real-cos-outage/v1"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    namespace = "actor-fdb-cell-system"
    engine = f"http://127.0.0.1:{args.engine_port}"
    depot = f"http://127.0.0.1:{args.depot_port}"
    metrics = f"http://127.0.0.1:{args.metrics_port}/"
    query = urllib.parse.urlencode({"namespace": "default"})
    policy_name = f"{args.cell}-deny-public-egress"
    actor_id = None
    namespace_id = None
    policy_applied = False
    failure = None
    stop_writer = threading.Event()
    writer = None
    writer_state = {"succeeded": 0, "failed": 0, "latency_ms": []}
    api_forward = PortForward(
        args.kubeconfig,
        namespace,
        f"{args.cell}-engine",
        [f"{args.engine_port}:6420", f"{args.depot_port}:6421"],
    )
    metrics_forward = PortForward(
        args.kubeconfig,
        namespace,
        f"{args.cell}-engine-metrics",
        [f"{args.metrics_port}:6430"],
    )

    def actor_url(suffix):
        return f"{engine}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

    def bottomless_state(namespace_id):
        return request_json(
            "GET",
            f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
        )

    def checkpoint(namespace_id):
        return request_json(
            "POST",
            f"{depot}/depot/checkpoints/buckets/{namespace_id}/databases/{actor_id}",
            {"force_reclaim": True},
        )

    def write_loop():
        while not stop_writer.is_set():
            started = time.perf_counter()
            try:
                payload = request_json("POST", actor_url("/increment"), timeout=10)
                if payload.get("actorId") != actor_id:
                    raise RuntimeError("increment returned the wrong Actor")
                writer_state["succeeded"] += 1
                writer_state["latency_ms"].append(
                    (time.perf_counter() - started) * 1000
                )
            except Exception:
                writer_state["failed"] += 1
            stop_writer.wait(0.1)

    network_policy = {
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": {"name": policy_name, "namespace": namespace},
        "spec": {
            "podSelector": {
                "matchLabels": {
                    "fleet.actor.dev/cell-name": args.cell,
                    "fleet.actor.dev/component": "engine",
                }
            },
            "policyTypes": ["Egress"],
            "egress": [{"to": [{"namespaceSelector": {}}]}],
        },
    }

    evidence = {"schema": args.evidence_schema, "cell": args.cell}
    try:
        runtime_configmap = json.loads(
            kubectl(
                args,
                "-n",
                namespace,
                "get",
                "configmap",
                f"{args.cell}-runtime-config",
                "-o",
                "json",
            )
        )
        runtime_config = json.loads(runtime_configmap["data"]["config.jsonc"])
        cold_config = runtime_config["sqlite"]["workflow_cold_storage"]["s3"]
        engine_deployment = json.loads(
            kubectl(
                args,
                "-n",
                namespace,
                "get",
                "deployment",
                f"{args.cell}-engine",
                "-o",
                "json",
            )
        )
        fdb_volume = next(
            volume
            for volume in engine_deployment["spec"]["template"]["spec"]["volumes"]
            if volume["name"] == "fdb-config"
        )
        fdb_configmap = fdb_volume["configMap"]["name"]
        fdb_cluster = fdb_configmap.removesuffix("-config")
        profile_id = runtime_configmap.get("metadata", {}).get("annotations", {}).get(
            "rivet.dev/storage-profile"
        )
        if args.storage_profile_id and profile_id != args.storage_profile_id:
            raise RuntimeError("runtime ConfigMap has the wrong StorageProfile")
        if args.expected_fdb_cluster and fdb_cluster != args.expected_fdb_cluster:
            raise RuntimeError("runtime Engine has the wrong FDB cluster")
        if args.expected_cold_bucket and cold_config["bucket"] != args.expected_cold_bucket:
            raise RuntimeError("runtime Engine has the wrong cold bucket")
        if (
            args.expected_cold_endpoint
            and cold_config.get("endpoint") != args.expected_cold_endpoint
        ):
            raise RuntimeError("runtime Engine has the wrong cold endpoint")
        if (
            args.expected_max_object_size_bytes
            and cold_config["max_object_size_bytes"] != args.expected_max_object_size_bytes
        ):
            raise RuntimeError("runtime Engine has the wrong cold object size")
        if (
            args.expected_recovery_window_ms
            and cold_config["recovery_window_ms"] != args.expected_recovery_window_ms
        ):
            raise RuntimeError("runtime Engine has the wrong cold recovery window")
        evidence["storage_binding"] = {
            "profile_id": profile_id,
            "fdb_cluster": fdb_cluster,
            "cold_bucket": cold_config["bucket"],
            "cold_endpoint": cold_config.get("endpoint"),
            "object_layout": "cold/v2",
            "max_object_size_bytes": cold_config["max_object_size_bytes"],
            "recovery_window_ms": cold_config["recovery_window_ms"],
        }
        api_forward.start()
        metrics_forward.start()
        namespace_payload = request_json("GET", f"{depot}/namespaces?name=default")
        namespace_id = namespace_payload["namespaces"][0]["namespace_id"]
        created = request_json(
            "POST",
            f"{engine}/actors?{query}",
            {
                "name": "workerd-counter",
                "key": f"cos-outage-{int(time.time() * 1000)}",
                "runner_name_selector": "workerd",
                "crash_policy": "restart",
            },
        )
        actor_id = created["actor"]["actor_id"]
        evidence["actor_id"] = actor_id
        deadline = time.monotonic() + 180
        while True:
            try:
                ready = request_json("GET", actor_url("/counter"), timeout=10)
                if int(ready.get("generation", 0)) > 0:
                    break
            except Exception:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Actor did not become ready")
            time.sleep(0.25)
        evidence["generation_before_outage"] = int(ready["generation"])

        chunk_bytes = 256 * 1024
        for chunk, offset in enumerate(range(0, args.fill_bytes, chunk_bytes)):
            size = min(chunk_bytes, args.fill_bytes - offset)
            request_json(
                "POST", actor_url(f"/bottomless-fill?chunk={chunk}&bytes={size}")
            )
        request_json(
            "PUT",
            f"{depot}/depot/qualification/buckets/{namespace_id}/databases/{actor_id}/shard-cache-policy",
            {"retention_ms": 1},
        )
        writer = threading.Thread(target=write_loop, name="cos-outage-writer", daemon=True)
        writer.start()
        while writer_state["succeeded"] < 5:
            time.sleep(0.1)
        baseline_state = bottomless_state(namespace_id)
        baseline_backlog_shards = sum(
            baseline_state["row_counts"][name]["count"]
            for name in ("hot_shards", "staged_hot_shards")
        )

        kubectl(args, "apply", "-f", "-", input_text=json.dumps(network_policy))
        policy_applied = True
        blocked_at_successes = writer_state["succeeded"]
        checkpoint_result = checkpoint(namespace_id)
        evidence["checkpoint"] = checkpoint_result
        backlog_bytes_max = 0.0
        backlog_objects_max = 0.0
        outage_deadline = time.monotonic() + args.outage_seconds
        while time.monotonic() < outage_deadline:
            metrics_text = urllib.request.urlopen(metrics, timeout=10).read().decode()
            backlog_bytes_max = max(
                backlog_bytes_max,
                metric_sum(metrics_text, "rivet_sqlite_compaction_backlog_bytes"),
            )
            backlog_objects_max = max(
                backlog_objects_max,
                metric_sum(metrics_text, "rivet_sqlite_compaction_backlog_objects"),
            )
            time.sleep(0.1)
        outage_state = bottomless_state(namespace_id)
        outage_successes = writer_state["succeeded"] - blocked_at_successes
        if outage_successes <= 0:
            raise RuntimeError("no Actor writes succeeded while COS was blocked")
        if outage_state["row_counts"]["hot_shards"]["count"] <= 0:
            raise RuntimeError("hot shards disappeared while COS was blocked")
        compaction_root = outage_state.get("compaction_root")
        cold_watermark_txid = (
            -1
            if compaction_root is None
            else int(compaction_root["cold_watermark_txid"])
        )
        if cold_watermark_txid >= int(outage_state["head"]["head_txid"]):
            raise RuntimeError("cold watermark falsely covered the live head during outage")
        durable_backlog_shards = sum(
            outage_state["row_counts"][name]["count"]
            for name in ("hot_shards", "staged_hot_shards")
        )
        evidence["outage"] = {
            "successful_writes": outage_successes,
            "failed_writes": writer_state["failed"],
            "state": outage_state,
            "backlog_bytes_max": backlog_bytes_max,
            "backlog_objects_max": backlog_objects_max,
            "durable_backlog_shards_before": baseline_backlog_shards,
            "durable_backlog_shards_after": durable_backlog_shards,
        }
        if durable_backlog_shards <= baseline_backlog_shards:
            raise RuntimeError("COS outage did not grow durable hot/staged backlog")

        stop_writer.set()
        writer.join(timeout=15)
        if writer.is_alive():
            raise RuntimeError("continuous writer did not stop before Engine restart")
        expected_count = writer_state["succeeded"]
        engine_uid_before_restart = engine_pod_uid(args, namespace)

        api_forward.stop()
        metrics_forward.stop()
        kubectl(
            args,
            "-n",
            namespace,
            "rollout",
            "restart",
            f"deployment/{args.cell}-engine",
        )
        kubectl(
            args,
            "-n",
            namespace,
            "rollout",
            "status",
            f"deployment/{args.cell}-engine",
            "--timeout=5m",
        )
        engine_uid_after_restart = engine_pod_uid(args, namespace)
        if engine_uid_after_restart == engine_uid_before_restart:
            raise RuntimeError("Engine rollout did not replace the Pod UID")
        evidence["engine_restart"] = {
            "pod_uid_before": engine_uid_before_restart,
            "pod_uid_after": engine_uid_after_restart,
        }
        kubectl(
            args,
            "-n",
            namespace,
            "delete",
            "networkpolicy",
            policy_name,
            "--ignore-not-found",
        )
        policy_applied = False
        api_forward.start()
        metrics_forward.start()
        checkpoint(namespace_id)

        recovery_started = time.monotonic()
        settled_samples = 0
        while time.monotonic() - recovery_started < args.recovery_timeout_seconds:
            state = bottomless_state(namespace_id)
            metrics_text = urllib.request.urlopen(metrics, timeout=10).read().decode()
            backlog_bytes = metric_sum(
                metrics_text, "rivet_sqlite_compaction_backlog_bytes"
            )
            backlog_objects = metric_sum(
                metrics_text, "rivet_sqlite_compaction_backlog_objects"
            )
            cold_ready = (
                state.get("cold_ready") is True
                and state["row_counts"]["hot_shards"]["count"] == 0
                and state["row_counts"]["staged_hot_shards"]["count"] == 0
            )
            settled_samples = settled_samples + 1 if cold_ready and backlog_bytes == 0 and backlog_objects == 0 else 0
            if settled_samples >= 2:
                break
            time.sleep(2)
        else:
            raise TimeoutError("COS backlog did not drain after recovery")
        recovery_duration_ms = (time.monotonic() - recovery_started) * 1000
        validate_recovered_state(checkpoint_result, outage_state, state)

        before_sleep = request_json("GET", actor_url("/counter"))
        if int(before_sleep["count"]) != expected_count:
            raise RuntimeError("Actor count diverged from acknowledged writes")
        request_json(
            "POST",
            f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}/sleep?{query}",
            {},
        )
        sleep_deadline = time.monotonic() + 30
        while True:
            actor_list = request_json(
                "GET",
                f"{engine}/actors?{query}&actor_id={urllib.parse.quote(actor_id, safe='')}",
            )
            actors = actor_list.get("actors", [])
            if len(actors) == 1 and (
                actors[0].get("sleep_ts") is not None
                or actors[0].get("sleepTs") is not None
            ):
                break
            if time.monotonic() >= sleep_deadline:
                raise TimeoutError("Actor did not reach durable sleeping state")
            time.sleep(0.25)
        wake_started = time.perf_counter()
        after_wake = request_json("GET", actor_url("/counter"), timeout=30)
        wake_ms = (time.perf_counter() - wake_started) * 1000
        if int(after_wake["count"]) != expected_count:
            raise RuntimeError("cold wake returned the wrong acknowledged count")
        if int(after_wake.get("bottomlessBytes", -1)) != args.fill_bytes:
            raise RuntimeError("cold wake returned the wrong Bottomless byte count")
        expected_chunks = (args.fill_bytes + chunk_bytes - 1) // chunk_bytes
        if int(after_wake.get("bottomlessChunks", -1)) != expected_chunks:
            raise RuntimeError("cold wake returned the wrong Bottomless chunk count")
        verify_started = time.perf_counter()
        verified = request_json(
            "GET",
            actor_url("/bottomless-verify"),
            timeout=args.recovery_timeout_seconds,
        )
        verify_ms = (time.perf_counter() - verify_started) * 1000
        if int(verified.get("bottomlessChunks", -1)) != expected_chunks:
            raise RuntimeError("full verification returned the wrong Bottomless chunk count")
        if int(verified.get("bottomlessBytes", -1)) != args.fill_bytes:
            raise RuntimeError("full verification returned the wrong Bottomless byte count")
        if int(verified.get("bottomlessCorruptChunks", -1)) != 0:
            raise RuntimeError("cold wake detected corrupt Bottomless payload bytes")
        if int(after_wake["generation"]) <= int(before_sleep["generation"]):
            raise RuntimeError("cold wake did not advance Actor generation")
        evidence["recovery"] = {
            "duration_ms": recovery_duration_ms,
            "state": state,
            "backlog_bytes": backlog_bytes,
            "backlog_objects": backlog_objects,
            "acknowledged_writes": expected_count,
            "cold_wake_ms": wake_ms,
            "generation_before_sleep": int(before_sleep["generation"]),
            "generation_after_wake": int(after_wake["generation"]),
            "bottomless_bytes": int(after_wake["bottomlessBytes"]),
            "bottomless_chunks": int(after_wake["bottomlessChunks"]),
            "bottomless_corrupt_chunks": int(verified["bottomlessCorruptChunks"]),
            "full_content_verify_ms": verify_ms,
        }
        evidence["verdict"] = "passed"
    except Exception as exc:
        failure = exc
        evidence["verdict"] = "failed"
        evidence["error"] = {"type": type(exc).__name__, "message": str(exc)}
    finally:
        stop_writer.set()
        if writer is not None:
            writer.join(timeout=5)
        if policy_applied:
            subprocess.run(
                [
                    "kubectl",
                    "--kubeconfig",
                    args.kubeconfig,
                    "-n",
                    namespace,
                    "delete",
                    "networkpolicy",
                    policy_name,
                    "--ignore-not-found",
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        if actor_id is not None and namespace_id is not None:
            try:
                request_json(
                    "DELETE",
                    f"{depot}/depot/qualification/buckets/{namespace_id}/databases/{actor_id}/shard-cache-policy",
                    timeout=10,
                )
            except Exception:
                pass
        if actor_id is not None:
            try:
                request_json(
                    "DELETE",
                    f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}",
                    timeout=10,
                )
            except Exception:
                pass
        api_forward.stop()
        metrics_forward.stop()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    os.replace(temporary, args.output)
    print(json.dumps(evidence, indent=2, sort_keys=True))
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
