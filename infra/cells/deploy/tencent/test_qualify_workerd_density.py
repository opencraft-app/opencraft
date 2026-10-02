import argparse
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import unittest
import uuid
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_workerd_density.py")
SPEC = importlib.util.spec_from_file_location("qualify_workerd_density", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
density = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = density
SPEC.loader.exec_module(density)


class ActorHandler(BaseHTTPRequestHandler):
    actors = {}
    bottomless_chunks = {}
    cold_policies = {}
    checkpoint_requests = {}
    checkpoint_force_reclaim = {}
    checkpoint_targets = {}
    branch_ids = {}
    head_txids = {}
    active = set()
    generations = {}
    next_id = 0
    fail_create_after = None
    generation = 1
    counter_gets = 0
    stuck_sleep = set()
    lock = threading.Lock()
    host_modulus = 1
    host_remainder = 0
    policy_delete_delay_seconds = 0
    policy_deletes_in_flight = 0
    policy_delete_peak = 0
    cold_requires_sleep = False

    @classmethod
    def owns(cls, actor_id):
        try:
            ordinal = int(actor_id.rsplit("-", 1)[1])
        except (IndexError, ValueError):
            return True
        return ordinal % cls.host_modulus == cls.host_remainder

    def do_POST(self):
        if self.path == "/v1/sqlite/registry-lookup":
            if self.headers.get("x-rivet-workerd-token") != "test-workerd-token":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            identities = request.get("actors", [])
            if len(identities) > 4_096:
                self.send_error(413)
                return
            with self.lock:
                entries = [
                    {
                        "actor_id": identity["actor_id"],
                        "generation": identity["generation"],
                        "host_active": (
                            identity["actor_id"] in type(self).active
                            and type(self).owns(identity["actor_id"])
                            and type(self).generations.get(identity["actor_id"])
                            == identity["generation"]
                        ),
                        "bridge_active": (
                            identity["actor_id"] in type(self).active
                            and type(self).owns(identity["actor_id"])
                            and type(self).generations.get(identity["actor_id"])
                            == identity["generation"]
                        ),
                    }
                    for identity in identities
                ]
            self.reply({"actors": entries})
            return
        if self.path.startswith("/actors?"):
            with self.lock:
                type(self).next_id += 1
                actor_id = f"actor-{type(self).next_id}"
                if (
                    type(self).fail_create_after is not None
                    and type(self).next_id > type(self).fail_create_after
                ):
                    self.send_error(503, "injected Actor creation failure")
                    return
                type(self).actors[actor_id] = 0
                type(self).head_txids[actor_id] = 1
                type(self).branch_ids[actor_id] = str(
                    uuid.uuid5(uuid.NAMESPACE_URL, actor_id)
                )
            self.reply({"actor": {"actor_id": actor_id}})
            return
        parsed = self.parsed_path()
        if parsed.path.startswith("/depot/checkpoints/buckets/"):
            actor_id = urllib.parse.unquote(parsed.path.split("/")[-1])
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            with self.lock:
                if actor_id not in type(self).actors:
                    self.send_error(404)
                    return
                target = type(self).head_txids[actor_id]
                type(self).checkpoint_targets[actor_id] = target
                type(self).checkpoint_requests[actor_id] = (
                    type(self).checkpoint_requests.get(actor_id, 0) + 1
                )
                type(self).checkpoint_force_reclaim[actor_id] = request.get(
                    "force_reclaim"
                )
                branch_id = type(self).branch_ids[actor_id]
            self.reply(
                {
                    "checkpoint_contract_version": 2,
                    "request_id": f"checkpoint-{actor_id}-{target}",
                    "bucket_id": "namespace-id",
                    "database_id": actor_id,
                    "branch_id": branch_id,
                    "target_head_txid": target,
                    "target_db_size_pages": 1,
                    "target_post_apply_checksum": 0,
                    "service_interrupted": False,
                    "force_reclaim_accepted": True,
                }
            )
            return
        if parsed.path.startswith("/actors/") and parsed.path.endswith("/sleep"):
            actor_id = parsed.path[len("/actors/") : -len("/sleep")]
            with self.lock:
                if actor_id not in type(self).actors:
                    self.send_error(404)
                    return
                if actor_id not in type(self).stuck_sleep:
                    type(self).active.discard(actor_id)
            self.reply({})
            return
        actor_id = self.gateway_actor("/bottomless-fill", parsed.path)
        if actor_id is not None:
            query = urllib.parse.parse_qs(parsed.query)
            chunk = int(query["chunk"][0])
            chunk_bytes = int(query["bytes"][0])
            with self.lock:
                if actor_id not in type(self).actors:
                    self.send_error(404)
                    return
                chunks = type(self).bottomless_chunks.setdefault(actor_id, {})
                chunks[chunk] = chunk_bytes
                total = sum(chunks.values())
                type(self).head_txids[actor_id] += 1
            self.reply(
                {
                    "actorId": actor_id,
                    "generation": type(self).generations[actor_id],
                    "count": type(self).actors[actor_id],
                    "bottomlessBytes": total,
                }
            )
            return
        actor_id = self.gateway_actor("/increment")
        if actor_id is not None:
            with self.lock:
                type(self).actors[actor_id] += 1
                count = type(self).actors[actor_id]
                type(self).head_txids[actor_id] += 1
            self.reply(
                {
                    "actorId": actor_id,
                    "generation": type(self).generations[actor_id],
                    "count": count,
                    "bottomlessBytes": sum(
                        type(self).bottomless_chunks.get(actor_id, {}).values()
                    ),
                }
            )
            return
        self.send_error(404)

    def do_GET(self):
        parsed = self.parsed_path()
        if parsed.path == "/namespaces":
            self.reply(
                {
                    "namespaces": [
                        {"namespace_id": "namespace-id", "name": "default"}
                    ]
                }
            )
            return
        if parsed.path.startswith("/depot/inspect/buckets/") and parsed.path.endswith(
            "/bottomless-state"
        ):
            components = parsed.path.split("/")
            actor_id = urllib.parse.unquote(components[-2])
            with self.lock:
                if actor_id not in type(self).actors:
                    self.send_error(404)
                    return
                payload_bytes = sum(
                    type(self).bottomless_chunks.get(actor_id, {}).values()
                )
                head_txid = type(self).head_txids[actor_id]
                cold_watermark = type(self).checkpoint_targets.get(actor_id, 0)
                branch_id = type(self).branch_ids[actor_id]
            self.reply(
                {
                    "database_id": actor_id,
                    "branch_id": branch_id,
                    "found": True,
                    "bottomless_contract_version": 1,
                    "logical_storage_limit_bytes": None,
                    "logical_size_bytes": payload_bytes + 4096,
                    "fdb_write_debt_bytes": 0,
                    "fdb_write_debt_target_bytes": 10 * 1024 * 1024,
                    "fdb_write_debt_limit_bytes": 12 * 1024 * 1024,
                    "counts_exact": True,
                    "head": {"head_txid": head_txid},
                    "compaction_root": {
                        "hot_watermark_txid": cold_watermark,
                        "cold_watermark_txid": cold_watermark,
                    },
                    "row_counts": {
                        "cold_publish_markers": {"count": 1, "truncated": False},
                        "cold_shards": {"count": 1, "truncated": False},
                        "hot_shards": {"count": 0, "truncated": False},
                        "pitr_intervals": {"count": 1, "truncated": False},
                        "staged_hot_shards": {"count": 0, "truncated": False},
                    },
                    "cold_ready": (
                        actor_id in type(self).cold_policies
                        and cold_watermark >= head_txid
                        and (
                            not type(self).cold_requires_sleep
                            or actor_id not in type(self).active
                        )
                    ),
                }
            )
            return
        if parsed.path == "/v1/sqlite/stats":
            if self.headers.get("x-rivet-workerd-token") != "test-workerd-token":
                self.send_error(404)
                return
            with self.lock:
                active = sum(
                    1
                    for actor_id in type(self).active
                    if type(self).owns(actor_id)
                )
            self.reply(
                {
                    "host_active_actors": active,
                    "bridge_active_actors": active,
                    "quiescent": active == 0,
                }
            )
            return
        actor_id = self.gateway_actor("/counter")
        if actor_id is None:
            self.send_error(404)
            return
        with self.lock:
            count = type(self).actors[actor_id]
            if actor_id not in type(self).active:
                prior = type(self).generations.get(actor_id)
                type(self).generations[actor_id] = (
                    type(self).generation if prior is None else prior + 1
                )
                type(self).active.add(actor_id)
            type(self).counter_gets += 1
        self.reply(
            {
                "actorId": actor_id,
                "generation": type(self).generations[actor_id],
                "count": count,
                "bottomlessBytes": sum(
                    type(self).bottomless_chunks.get(actor_id, {}).values()
                ),
            }
        )

    def do_PUT(self):
        parsed = self.parsed_path()
        if parsed.path.startswith("/depot/qualification/buckets/") and parsed.path.endswith(
            "/shard-cache-policy"
        ):
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            actor_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            with self.lock:
                type(self).cold_policies[actor_id] = request["retention_ms"]
            self.reply({"retention_ms": request["retention_ms"]})
            return
        self.send_error(404)

    def do_DELETE(self):
        parsed = self.parsed_path()
        if parsed.path.startswith("/depot/qualification/buckets/") and parsed.path.endswith(
            "/shard-cache-policy"
        ):
            actor_id = urllib.parse.unquote(parsed.path.split("/")[-2])
            with self.lock:
                type(self).policy_deletes_in_flight += 1
                type(self).policy_delete_peak = max(
                    type(self).policy_delete_peak,
                    type(self).policy_deletes_in_flight,
                )
            try:
                time.sleep(type(self).policy_delete_delay_seconds)
                with self.lock:
                    type(self).cold_policies.pop(actor_id, None)
            finally:
                with self.lock:
                    type(self).policy_deletes_in_flight -= 1
            self.reply({})
            return
        actor_id = self.path.split("/actors/", 1)[1].split("?", 1)[0]
        with self.lock:
            type(self).actors.pop(actor_id, None)
            type(self).active.discard(actor_id)
            type(self).generations.pop(actor_id, None)
            type(self).bottomless_chunks.pop(actor_id, None)
            type(self).checkpoint_targets.pop(actor_id, None)
            type(self).branch_ids.pop(actor_id, None)
            type(self).head_txids.pop(actor_id, None)
        self.reply({})

    def parsed_path(self):
        return density.urllib.parse.urlparse(self.path)

    def gateway_actor(self, suffix, path=None):
        path = self.path if path is None else path
        prefix = "/gateway/"
        if not path.startswith(prefix) or not path.endswith(suffix):
            return None
        return urllib.parse.unquote(path[len(prefix) : -len(suffix)])

    def reply(self, value):
        encoded = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


class DensityQualificationTests(unittest.TestCase):
    def setUp(self):
        ActorHandler.actors = {}
        ActorHandler.bottomless_chunks = {}
        ActorHandler.cold_policies = {}
        ActorHandler.checkpoint_requests = {}
        ActorHandler.checkpoint_force_reclaim = {}
        ActorHandler.checkpoint_targets = {}
        ActorHandler.branch_ids = {}
        ActorHandler.head_txids = {}
        ActorHandler.active = set()
        ActorHandler.generations = {}
        ActorHandler.next_id = 0
        ActorHandler.fail_create_after = None
        ActorHandler.generation = 1
        ActorHandler.counter_gets = 0
        ActorHandler.stuck_sleep = set()
        ActorHandler.policy_delete_delay_seconds = 0
        ActorHandler.policy_deletes_in_flight = 0
        ActorHandler.policy_delete_peak = 0
        ActorHandler.cold_requires_sleep = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ActorHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def test_percentile_uses_nearest_rank(self):
        self.assertEqual(density.percentile([1, 2, 3, 4], 0.50), 2)
        self.assertEqual(density.percentile([1, 2, 3, 4], 0.99), 4)
        self.assertIsNone(density.percentile([], 0.99))

    def test_cold_state_progress_is_bounded_and_aggregated(self):
        progress = density.cold_state_progress(
            3,
            {"actor-secret-b", "actor-secret-c"},
            {
                "actor-secret-a": {
                    "cold_ready": True,
                    "row_counts": {
                        "hot_shards": {"count": 0},
                        "cold_shards": {"count": 4},
                    },
                },
                "actor-secret-b": {
                    "cold_ready": False,
                    "row_counts": {
                        "hot_shards": {"count": 2},
                        "cold_shards": {"count": 3},
                        "staged_hot_shards": {"count": 152},
                    },
                },
            },
            12_345.6789,
            2,
        )
        self.assertEqual(
            progress,
            {
                "actor_count": 3,
                "pending_actors": 2,
                "cold_ready_actors": 1,
                "hot_shards": 2,
                "cold_shards": 7,
                "staged_hot_rows": 152,
                "elapsed_ms": 12_345.679,
                "read_error_count": 2,
            },
        )
        self.assertNotIn("actor-secret-a", json.dumps(progress))

    def test_public_object_helpers_preserve_objectref_and_internal_identity_boundary(self):
        object_id = density.public_qualification_object_id("run", 7)
        self.assertRegex(object_id, r"^[0-9a-f]{64}$")
        self.assertEqual(object_id, density.public_qualification_object_id("run", 7))
        self.assertNotEqual(object_id, density.public_qualification_object_id("run", 8))
        self.assertEqual(
            density.public_object_url(
                "https://workers.example/", "worker", "Agent", "object/id"
            ),
            "https://workers.example/v1/workers/worker/objects/Agent/object%2Fid",
        )
        expected_name = "mf-" + density.digest_parts("worker", "Agent")[:24]
        with mock.patch.object(
            density,
            "request_json",
            return_value=({"actors": [{"actor_id": "internal-1", "generation": 7}]}, 1.0),
        ) as request:
            actor = density.resolve_public_actor(
                "http://engine", "default", "worker", "Agent", "object/id", 5
            )
        self.assertEqual(actor["actor_id"], "internal-1")
        target = urllib.parse.urlparse(request.call_args.args[1])
        query = urllib.parse.parse_qs(target.query)
        self.assertEqual(query["name"], [expected_name])
        self.assertEqual(query["key"], ["object/id"])

    def test_public_worker_publish_returns_stable_version_and_deployment(self):
        with mock.patch.object(
            density,
            "request_json",
            side_effect=[({"id": "v_123"}, 1.0), ({"id": "d_456"}, 1.0)],
        ) as request:
            release = density.publish_public_worker(
                "https://workers.example", "worker", "Agent", 5
            )
        self.assertEqual(release, {"version_id": "v_123", "deployment_id": "d_456"})
        version_call, deployment_call = request.call_args_list
        self.assertEqual(version_call.args[0:2], ("POST", "https://workers.example/v1/workers/worker/versions"))
        self.assertEqual(deployment_call.args[0:2], ("POST", "https://workers.example/v1/workers/worker/deployments"))
        self.assertEqual(version_call.args[2]["durable_objects"], {"AGENT": "Agent"})

    def test_idempotent_transport_retry_is_bounded_and_counts_replays(self):
        operation = mock.Mock(
            side_effect=[
                urllib.error.URLError("tunnel reconnecting"),
                ConnectionResetError("stream reset"),
                "created",
            ]
        )
        with mock.patch.object(density.time, "sleep") as sleep:
            result, retries = density.retry_idempotent_transport(operation)
        self.assertEqual((result, retries), ("created", 2))
        self.assertEqual(operation.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.05, 0.1])

    def test_idempotent_transport_retry_does_not_replay_application_errors(self):
        operation = mock.Mock(side_effect=RuntimeError("HTTP 503"))
        with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
            density.retry_idempotent_transport(operation)
        self.assertEqual(operation.call_count, 1)

    def test_public_generation_resolution_requires_one_exact_host_and_bridge_owner(self):
        targets = [
            density.HostStatsTarget(
                "host-%d" % index,
                "http://host-%d/stats" % index,
                "http://host-%d/registry-lookup" % index,
                "token",
            )
            for index in range(3)
        ]
        responses = [
            ({"actors": [{"actor_id": "actor", "host_generation": None, "bridge_generation": None}]}, 1),
            ({"actors": [{"actor_id": "actor", "host_generation": 9, "bridge_generation": 9}]}, 1),
            ({"actors": [{"actor_id": "actor", "host_generation": None, "bridge_generation": None}]}, 1),
        ]
        with mock.patch.object(density, "request_json", side_effect=responses) as request:
            generation, owner = density.resolve_current_public_generation(targets, "actor", 5)
        self.assertEqual((generation, owner), (9, "host-1"))
        self.assertTrue(all(call.args[1].endswith("/registry-resolve") for call in request.call_args_list))

        responses[0] = (
            {"actors": [{"actor_id": "actor", "host_generation": 9, "bridge_generation": 9}]},
            1,
        )
        with mock.patch.object(density, "request_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "2 exact live generation owners"):
                density.resolve_current_public_generation(targets, "actor", 5)

    def test_bounded_recovery_proof_requires_queueing_without_overload(self):
        before = {
            "host-a": {
                "workerd_admission": {
                    "queued_total": 10,
                    "rejected_total": 2,
                    "timed_out_total": 1,
                }
            }
        }
        after = {
            "host-a": {
                "workerd_admission": {
                    "in_flight": 0,
                    "queued": 0,
                    "peak_in_flight": 16,
                    "peak_queued": 32,
                    "queued_total": 42,
                    "rejected_total": 2,
                    "timed_out_total": 1,
                    "max_in_flight": 16,
                    "max_queued": 64,
                    "queue_timeout_ms": 15_000,
                }
            }
        }

        proof = density.prove_bounded_recovery_admission(before, after)

        self.assertTrue(proof["passed"])
        self.assertEqual(proof["queued_requests"], 32)
        overloaded = json.loads(json.dumps(after))
        overloaded["host-a"]["workerd_admission"]["rejected_total"] = 3
        with self.assertRaisesRegex(RuntimeError, "overloaded"):
            density.prove_bounded_recovery_admission(before, overloaded)

        second_host_before = json.loads(json.dumps(before["host-a"]))
        second_host_after = json.loads(json.dumps(after["host-a"]))
        second_host_after["workerd_admission"]["queued_total"] = 10
        with self.assertRaisesRegex(RuntimeError, "only 1 host"):
            density.prove_bounded_recovery_admission(
                {"host-a": before["host-a"], "host-b": second_host_before},
                {"host-a": after["host-a"], "host-b": second_host_after},
                minimum_queued_hosts=2,
            )

        exceeded = json.loads(json.dumps(after))
        exceeded["host-a"]["workerd_admission"]["peak_in_flight"] = 17
        with self.assertRaisesRegex(RuntimeError, "exceeded its in-flight"):
            density.prove_bounded_recovery_admission(before, exceeded)

    def test_bounded_multi_actor_run_preserves_every_increment_and_cleans_up(self):
        args = argparse.Namespace(
            engine_url=f"http://127.0.0.1:{self.server.server_port}",
            namespace="default",
            runner_name="workerd",
            actor_name="workerd-counter",
            actors=8,
            concurrency=4,
            increments_per_actor=5,
            cold_settle_seconds=0,
            ready_timeout_seconds=5,
            ready_poll_seconds=0.01,
            request_timeout_seconds=5,
            run_id="unit-test",
            process=[],
            keep_actors=False,
            skip_final_verify=False,
        )

        result = density.run_qualification(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["writes"], 40)
        self.assertEqual(len(result["actor_records"]), 8)
        self.assertEqual(len(result["actor_manifest_sha256"]), 64)
        self.assertEqual(
            [record["key"] for record in result["actor_records"]],
            [f"workerd-density-unit-test-{index:06d}" for index in range(8)],
        )
        self.assertEqual(result["latency"]["increment"]["count"], 40)
        self.assertEqual(
            {(record["expected_count"], record["generation"]) for record in result["actor_records"]},
            {(5, 1)},
        )
        self.assertEqual(ActorHandler.actors, {})

    def test_partial_create_failure_cleans_up_every_successful_actor(self):
        ActorHandler.fail_create_after = 3
        args = argparse.Namespace(
            engine_url=f"http://127.0.0.1:{self.server.server_port}",
            namespace="default",
            runner_name="workerd",
            actor_name="workerd-counter",
            actors=8,
            concurrency=4,
            increments_per_actor=1,
            cold_settle_seconds=0,
            ready_timeout_seconds=5,
            ready_poll_seconds=0.01,
            request_timeout_seconds=5,
            run_id="injected-create-failure",
            process=[],
            keep_actors=False,
            skip_final_verify=False,
        )

        with self.assertRaisesRegex(RuntimeError, "5 Actor creation\\(s\\) failed"):
            density.run_qualification(args)

        self.assertEqual(ActorHandler.actors, {})

    def test_failed_run_persists_exact_inflight_actor_manifest(self):
        ActorHandler.fail_create_after = 3
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = pathlib.Path(temporary_directory, "density.json")
            args = argparse.Namespace(
                engine_url=f"http://127.0.0.1:{self.server.server_port}",
                namespace="default",
                runner_name="workerd",
                actor_name="workerd-counter",
                actors=8,
                concurrency=4,
                increments_per_actor=1,
                cold_settle_seconds=0,
                ready_timeout_seconds=5,
                ready_poll_seconds=0.01,
                request_timeout_seconds=5,
                run_id="inflight-create-failure",
                process=[],
                keep_actors=False,
                skip_final_verify=False,
                output=output,
            )

            with self.assertRaisesRegex(RuntimeError, r"5 Actor creation\(s\) failed"):
                density.run_qualification(args)

            inflight = json.loads(output.with_suffix(".json.inflight").read_text())
            self.assertEqual(inflight["stage"], "cleanup_attempted")
            self.assertEqual(len(inflight["actor_records"]), 3)
            self.assertEqual(
                {record["actor_id"] for record in inflight["actor_records"]},
                {"actor-1", "actor-2", "actor-3"},
            )
            self.assertFalse(output.exists())
            self.assertEqual(ActorHandler.actors, {})

    def test_skip_final_verify_does_not_read_actor_after_writes(self):
        args = argparse.Namespace(
            engine_url=f"http://127.0.0.1:{self.server.server_port}",
            namespace="default",
            runner_name="workerd",
            actor_name="workerd-counter",
            actors=1,
            concurrency=1,
            increments_per_actor=5,
            cold_settle_seconds=0,
            ready_timeout_seconds=5,
            ready_poll_seconds=0.01,
            request_timeout_seconds=5,
            run_id="skip-final-verify",
            process=[],
            keep_actors=True,
            skip_final_verify=True,
        )

        result = density.run_qualification(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertTrue(result["final_verification_skipped"])
        self.assertEqual(result["latency"]["verify"]["count"], 0)
        self.assertEqual(ActorHandler.counter_gets, 1)
        self.assertEqual(ActorHandler.actors, {"actor-1": 5})

    def test_post_restart_verification_requires_generation_advance_and_cleans_exact_ids(self):
        ActorHandler.actors = {"actor-a": 7, "actor-b": 7, "unrelated": 99}
        ActorHandler.generation = 2
        source = {
            "run_id": "restore-test",
            "increments_per_actor": 7,
            "actor_records": [
                {
                    "actor_id": "actor-a",
                    "key": "restore-a",
                    "expected_count": 7,
                    "generation": 1,
                },
                {
                    "actor_id": "actor-b",
                    "key": "restore-b",
                    "expected_count": 7,
                    "generation": 1,
                },
            ],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = pathlib.Path(temporary_directory, "density.json")
            source_path.write_text(json.dumps(source))
            args = argparse.Namespace(
                engine_url=f"http://127.0.0.1:{self.server.server_port}",
                namespace="default",
                concurrency=2,
                request_timeout_seconds=5,
                process=[],
                verify_from=source_path,
                expected_count=None,
                require_generation_advance=True,
                cleanup_verified=True,
            )

            result = density.run_post_restart_verification(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["mode"], "post_restart_verification")
        self.assertEqual(result["source_run_id"], "restore-test")
        self.assertEqual(result["latency"]["verify"]["count"], 2)
        self.assertEqual(
            {(record["prior_generation"], record["generation"]) for record in result["actor_records"]},
            {(1, 2)},
        )
        self.assertEqual(ActorHandler.actors, {"unrelated": 99})

    def test_post_restart_verification_fails_when_generation_does_not_advance(self):
        ActorHandler.actors = {"actor-a": 3}
        source = {
            "actor_records": [
                {
                    "actor_id": "actor-a",
                    "key": "restore-a",
                    "expected_count": 3,
                    "generation": 1,
                }
            ]
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = pathlib.Path(temporary_directory, "density.json")
            source_path.write_text(json.dumps(source))
            args = argparse.Namespace(
                engine_url=f"http://127.0.0.1:{self.server.server_port}",
                namespace="default",
                concurrency=1,
                request_timeout_seconds=5,
                process=[],
                verify_from=source_path,
                expected_count=None,
                require_generation_advance=True,
                cleanup_verified=False,
            )

            with self.assertRaisesRegex(RuntimeError, "generation did not advance"):
                density.run_post_restart_verification(args)

        self.assertEqual(ActorHandler.actors, {"actor-a": 3})

    def test_post_restart_verification_uses_public_objectref_for_verify_and_cleanup(self):
        object_id = "a" * 64
        source = {
            "run_id": "public-restore-test",
            "public_api_only": True,
            "application_api": {
                "path_prefix": "/v1",
                "worker": "q01-dr-physical-restore",
                "class_name": "Agent",
            },
            "actor_records": [
                {
                    "actor_id": "internal-actor-a",
                    "key": object_id,
                    "expected_count": 7,
                    "expected_bottomless_bytes": 0,
                    "generation": 1,
                }
            ],
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            source_path = pathlib.Path(temporary_directory, "density.json")
            source_path.write_text(json.dumps(source))
            args = argparse.Namespace(
                engine_url="http://engine.invalid",
                workers_api_url="http://workers.invalid",
                public_worker="q01-dr-physical-restore",
                public_class_name="Agent",
                namespace="default",
                concurrency=1,
                request_timeout_seconds=5,
                process=[],
                verify_from=source_path,
                expected_count=None,
                require_generation_advance=False,
                cleanup_verified=True,
            )
            with mock.patch.object(
                density,
                "public_fetch",
                return_value=({"count": 7, "bottomlessBytes": 0}, 12.5),
            ) as public_fetch, mock.patch.object(
                density,
                "resolve_public_actor",
                return_value={"actor_id": "internal-actor-a", "start_ts": 2},
            ), mock.patch.object(density, "request_json", return_value=({}, 1.0)) as request_json:
                result = density.run_post_restart_verification(args)

        self.assertTrue(result["public_api_only"])
        self.assertEqual(result["cleanup_errors"], [])
        public_fetch.assert_called_once_with(
            "http://workers.invalid",
            "q01-dr-physical-restore",
            "Agent",
            object_id,
            "/counter",
            5,
        )
        self.assertEqual(request_json.call_args.args[0], "DELETE")
        self.assertIn("/v1/workers/q01-dr-physical-restore/objects/Agent/", request_json.call_args.args[1])

    def test_sleep_proof_returns_to_baseline_then_wakes_with_new_generations(self):
        args = argparse.Namespace(
            engine_url=f"http://127.0.0.1:{self.server.server_port}",
            namespace="default",
            runner_name="workerd",
            actor_name="workerd-counter",
            actors=6,
            concurrency=12,
            increments_per_actor=4,
            cold_settle_seconds=0,
            ready_timeout_seconds=5,
            ready_poll_seconds=0.01,
            request_timeout_seconds=5,
            run_id="sleep-proof",
            process=[],
            keep_actors=False,
            skip_final_verify=False,
            host_stats_url=f"http://127.0.0.1:{self.server.server_port}/v1/sqlite/stats",
            host_stats_token_env="RIVET_WORKERD_TOKEN",
            prove_sleep=True,
            wake_after_sleep=True,
            wake_requests_per_actor=2,
            quiescence_timeout_seconds=5,
            quiescence_poll_seconds=0.01,
        )

        with mock.patch.dict(
            os.environ, {"RIVET_WORKERD_TOKEN": "test-workerd-token"}
        ):
            result = density.run_qualification(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertTrue(result["sleep_proved"])
        self.assertEqual(result["latency"]["sleep"]["count"], 6)
        self.assertEqual(result["latency"]["wake"]["count"], 6)
        self.assertEqual(result["latency"]["wake_requests"]["count"], 12)
        self.assertEqual(result["wake_requests_per_actor"], 2)
        self.assertEqual(
            {
                (record["generation_before_sleep"], record["generation"])
                for record in result["actor_records"]
            },
            {(1, 2)},
        )
        self.assertEqual(result["host_stats"]["post_sleep"]["host_active_actors"], 0)
        self.assertEqual(result["host_stats"]["post_wake"]["host_active_actors"], 6)
        self.assertEqual(result["host_stats"]["post_wake"]["bridge_active_actors"], 6)
        self.assertEqual(result["host_stats"]["post_cleanup"]["bridge_active_actors"], 0)
        self.assertEqual(ActorHandler.actors, {})

    def test_bottomless_contract_is_proved_before_bounded_cold_wake(self):
        logical_payload_bytes = 12 * 1024 * 1024 + 1
        ActorHandler.policy_delete_delay_seconds = 0.05
        ActorHandler.cold_requires_sleep = True
        args = argparse.Namespace(
            engine_url=f"http://127.0.0.1:{self.server.server_port}",
            depot_inspect_url=f"http://127.0.0.1:{self.server.server_port}",
            namespace="default",
            runner_name="workerd",
            actor_name="workerd-counter",
            actors=2,
            concurrency=2,
            increments_per_actor=1,
            cold_settle_seconds=0,
            ready_timeout_seconds=5,
            ready_poll_seconds=0.01,
            request_timeout_seconds=5,
            run_id="bottomless-cold-proof",
            process=[],
            keep_actors=False,
            skip_final_verify=False,
            host_stats_url=f"http://127.0.0.1:{self.server.server_port}/v1/sqlite/stats",
            host_stats_token_env="RIVET_WORKERD_TOKEN",
            prove_sleep=True,
            wake_after_sleep=True,
            quiescence_timeout_seconds=5,
            quiescence_poll_seconds=0.01,
            require_cold_before_wake=True,
            cold_state_timeout_seconds=5,
            cold_state_poll_seconds=0.01,
            cold_cache_retention_ms=1,
            bottomless_actor_count=1,
            bottomless_bytes_per_actor=logical_payload_bytes,
            max_cold_wake_p95_ms=5_000,
            max_cold_wake_p99_ms=5_000,
            max_cold_wake_ms=5_000,
        )

        with mock.patch.dict(
            os.environ, {"RIVET_WORKERD_TOKEN": "test-workerd-token"}
        ):
            result = density.run_qualification(args)

        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["bottomless"]["qualification_actor_count"], 1)
        self.assertEqual(
            result["bottomless"]["bytes_per_qualification_actor"],
            logical_payload_bytes,
        )
        self.assertEqual(len(result["bottomless"]["states"]), 2)
        self.assertTrue(
            all(
                state["cold_ready"]
                for state in result["bottomless"]["states"].values()
            )
        )
        qualification_state = next(
            state
            for state in result["bottomless"]["states"].values()
            if state["logical_size_bytes"] > state["fdb_write_debt_target_bytes"]
        )
        self.assertIsNone(qualification_state["logical_storage_limit_bytes"])
        self.assertTrue(result["logical_quota"]["passed"])
        self.assertTrue(
            next(iter(result["logical_quota"]["states"].values()))[
                "crossed_transient_write_debt_limit"
            ]
        )
        self.assertTrue(result["cold_read_slo"]["passed"])
        self.assertEqual(result["latency"]["wake"]["count"], 2)
        self.assertTrue(result["online_checkpoint"]["passed"])
        self.assertFalse(result["online_checkpoint"]["service_interrupted"])
        self.assertEqual(
            result["online_checkpoint"]["writes_accepted_after_initial_checkpoint"],
            2,
        )
        self.assertEqual(result["online_checkpoint"]["continuity_reads"], 2)
        # Initial online proof, final continuity proof, and post-sleep force reclaim.
        self.assertEqual(set(ActorHandler.checkpoint_requests.values()), {3})
        self.assertEqual(set(ActorHandler.checkpoint_force_reclaim.values()), {True})
        for actor_id, initial in result["online_checkpoint"]["initial"].items():
            self.assertGreater(
                result["online_checkpoint"]["final"][actor_id][
                    "target_head_txid"
                ],
                initial["target_head_txid"],
            )
        self.assertEqual(ActorHandler.cold_policies, {})
        self.assertEqual(ActorHandler.policy_delete_peak, 2)
        self.assertEqual(ActorHandler.actors, {})

    def test_multi_host_and_multi_pool_proof_requires_real_distribution(self):
        class OddHost(ActorHandler):
            host_modulus = 2
            host_remainder = 1

        class EvenHost(ActorHandler):
            host_modulus = 2
            host_remainder = 0

        host_servers = [
            ThreadingHTTPServer(("127.0.0.1", 0), OddHost),
            ThreadingHTTPServer(("127.0.0.1", 0), EvenHost),
        ]
        host_threads = [
            threading.Thread(target=server.serve_forever, daemon=True)
            for server in host_servers
        ]
        for thread in host_threads:
            thread.start()
        try:
            args = argparse.Namespace(
                engine_url=f"http://127.0.0.1:{self.server.server_port}",
                namespace="default",
                runner_name=["workerd-a", "workerd-b"],
                actor_name="workerd-counter",
                actors=8,
                concurrency=4,
                increments_per_actor=2,
                cold_settle_seconds=0,
                ready_timeout_seconds=5,
                ready_poll_seconds=0.01,
                request_timeout_seconds=5,
                run_id="multi-host-proof",
                process=[],
                keep_actors=False,
                skip_final_verify=False,
                host_stats_url=None,
                host_registry_url=None,
                host_stats=[
                    (
                        "odd",
                        f"http://127.0.0.1:{host_servers[0].server_port}/v1/sqlite/stats",
                        "ODD_WORKERD_TOKEN",
                    ),
                    (
                        "even",
                        f"http://127.0.0.1:{host_servers[1].server_port}/v1/sqlite/stats",
                        "EVEN_WORKERD_TOKEN",
                    ),
                ],
                min_active_hosts=2,
                prove_sleep=True,
                wake_after_sleep=True,
                quiescence_timeout_seconds=5,
                quiescence_poll_seconds=0.01,
            )
            with mock.patch.dict(
                os.environ,
                {
                    "ODD_WORKERD_TOKEN": "test-workerd-token",
                    "EVEN_WORKERD_TOKEN": "test-workerd-token",
                },
            ):
                result = density.run_qualification(args)

            self.assertEqual(result["runner_names"], ["workerd-a", "workerd-b"])
            self.assertEqual(
                [record["runner_name"] for record in result["actor_records"]],
                ["workerd-a", "workerd-b"] * 4,
            )
            self.assertEqual(set(result["host_stats"]["active_hosts"]), {"odd", "even"})
            self.assertEqual(
                result["host_stats"]["per_host"]["odd"]["active"]["host_active_actors"],
                4,
            )
            self.assertEqual(
                result["host_stats"]["per_host"]["even"]["active"]["host_active_actors"],
                4,
            )
        finally:
            for server in host_servers:
                server.shutdown()
                server.server_close()
            for thread in host_threads:
                thread.join(timeout=5)

    def test_sleep_timeout_persists_exact_bounded_registry_diagnostics(self):
        ActorHandler.stuck_sleep = {"actor-2"}
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = pathlib.Path(temporary_directory, "density.json")
            args = argparse.Namespace(
                engine_url=f"http://127.0.0.1:{self.server.server_port}",
                namespace="default",
                runner_name="workerd",
                actor_name="workerd-counter",
                actors=3,
                concurrency=3,
                increments_per_actor=1,
                cold_settle_seconds=0,
                ready_timeout_seconds=5,
                ready_poll_seconds=0.01,
                request_timeout_seconds=5,
                run_id="sleep-timeout-diagnostics",
                process=[],
                keep_actors=False,
                skip_final_verify=False,
                host_stats_url=(
                    f"http://127.0.0.1:{self.server.server_port}/v1/sqlite/stats"
                ),
                host_stats_token_env="RIVET_WORKERD_TOKEN",
                prove_sleep=True,
                wake_after_sleep=False,
                quiescence_timeout_seconds=0.1,
                quiescence_poll_seconds=0.01,
                output=output,
            )

            with mock.patch.dict(
                os.environ, {"RIVET_WORKERD_TOKEN": "test-workerd-token"}
            ):
                with self.assertRaisesRegex(
                    TimeoutError, "did not return to the pre-run baseline"
                ):
                    density.run_qualification(args)

            inflight = json.loads(output.with_suffix(".json.inflight").read_text())

        self.assertEqual(inflight["stage"], "cleanup_attempted")
        diagnostic = inflight["host_stats"]["sleep_timeout_registry"]
        self.assertEqual(diagnostic["queried"], 3)
        self.assertEqual(diagnostic["active_count"], 1)
        self.assertEqual(
            [(entry["actor_id"], entry["generation"]) for entry in diagnostic["active"]],
            [("actor-2", 1)],
        )
        self.assertEqual(ActorHandler.actors, {})


if __name__ == "__main__":
    unittest.main()
