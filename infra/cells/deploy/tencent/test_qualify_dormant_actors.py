import argparse
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_dormant_actors.py")
SPEC = importlib.util.spec_from_file_location("qualify_dormant_actors", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
dormant = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dormant
SPEC.loader.exec_module(dormant)


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class DormantHandler(BaseHTTPRequestHandler):
    actors_by_key = {}
    actors = {}
    next_id = 0
    fresh_creates = 0
    lock = threading.Lock()

    def do_PUT(self):
        if not self.path.startswith("/actors?"):
            self.send_error(404)
            return
        body = self.read_json()
        with self.lock:
            actor_id = type(self).actors_by_key.get(body["key"])
            created = actor_id is None
            if created:
                type(self).next_id += 1
                type(self).fresh_creates += 1
                actor_id = "actor-{}".format(type(self).next_id)
                type(self).actors_by_key[body["key"]] = actor_id
                type(self).actors[actor_id] = {
                    "key": body["key"],
                    "count": 0,
                    "generation": 0,
                    "active": False,
                }
        self.reply({"actor": {"actor_id": actor_id}, "created": created})

    def do_GET(self):
        actor_id = self.gateway_actor("/counter")
        if actor_id is None:
            self.send_error(404)
            return
        with self.lock:
            record = type(self).actors[actor_id]
            if not record["active"]:
                record["generation"] += 1
                record["active"] = True
            response = {
                "actorId": actor_id,
                "generation": record["generation"],
                "count": record["count"],
            }
        self.reply(response)

    def do_POST(self):
        parsed = dormant.urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/actors/") or not parsed.path.endswith("/sleep"):
            self.send_error(404)
            return
        actor_id = parsed.path[len("/actors/") : -len("/sleep")]
        with self.lock:
            type(self).actors[actor_id]["active"] = False
        self.reply({})

    def do_DELETE(self):
        parsed = dormant.urllib.parse.urlparse(self.path)
        actor_id = parsed.path.split("/actors/", 1)[1]
        with self.lock:
            record = type(self).actors.pop(actor_id, None)
            if record is None:
                self.send_error(404)
                return
            type(self).actors_by_key.pop(record["key"])
        self.reply({})

    def gateway_actor(self, suffix):
        prefix = "/gateway/"
        parsed = dormant.urllib.parse.urlparse(self.path)
        if not parsed.path.startswith(prefix) or not parsed.path.endswith(suffix):
            return None
        return parsed.path[len(prefix) : -len(suffix)]

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

    def reply(self, value):
        encoded = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


class PublicWorkersHandler(BaseHTTPRequestHandler):
    objects = {}
    tombstones = set()
    version_id = "version-fixed"
    deployment_id = "deployment-fixed"
    transient_failures = 0
    lock = threading.Lock()

    def parts(self):
        return dormant.urllib.parse.urlparse(self.path).path.strip("/").split("/")

    def do_POST(self):
        parts = self.parts()
        if len(parts) == 4 and parts[:2] == ["v1", "workers"] and parts[3] == "versions":
            self.read_json()
            self.reply({"object": "version", "id": self.version_id}, 201)
            return
        if len(parts) == 4 and parts[:2] == ["v1", "workers"] and parts[3] == "deployments":
            self.read_json()
            self.reply({"object": "deployment", "id": self.deployment_id}, 201)
            return
        if len(parts) == 7 and parts[:2] == ["v1", "workers"] and parts[5] and parts[6] == "fetch":
            object_id = dormant.urllib.parse.unquote(parts[5])
            operation = dormant.urllib.parse.urlparse(
                self.headers["X-Workers-Original-URL"]
            )
            with self.lock:
                if object_id not in type(self).objects:
                    self.send_error(404)
                    return
                if operation.path == "/advance":
                    expected = int(dormant.urllib.parse.parse_qs(operation.query)["expected"][0])
                    current = type(self).objects[object_id]
                    if current == expected:
                        type(self).objects[object_id] += 1
                    elif current != expected + 1:
                        self.reply({"error": "state_conflict"}, 409)
                        return
                value = type(self).objects[object_id]
            self.reply({"value": value})
            return
        self.send_error(404)

    def do_PUT(self):
        parts = self.parts()
        if len(parts) != 6 or parts[:2] != ["v1", "workers"] or parts[3] != "objects":
            self.send_error(404)
            return
        worker, class_name, object_id = map(dormant.urllib.parse.unquote, (parts[2], parts[4], parts[5]))
        with self.lock:
            if type(self).transient_failures:
                type(self).transient_failures -= 1
                self.reply({"error": "capacity_pending"}, 503)
                return
            if object_id in type(self).tombstones:
                self.reply({"error": {"code": "object_deleted"}}, 410)
                return
            created = object_id not in type(self).objects
            type(self).objects.setdefault(object_id, 0)
        self.reply(
            {"object": "object", "id": object_id, "worker": worker, "class_name": class_name},
            201 if created else 200,
        )

    def do_DELETE(self):
        parts = self.parts()
        if len(parts) != 6 or parts[:2] != ["v1", "workers"] or parts[3] != "objects":
            self.send_error(404)
            return
        object_id = dormant.urllib.parse.unquote(parts[5])
        with self.lock:
            existed = type(self).objects.pop(object_id, None) is not None
            if existed:
                type(self).tombstones.add(object_id)
        if not existed:
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()

    def read_json(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

    def reply(self, value, status=200):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


class DormantQualificationTests(unittest.TestCase):
    def setUp(self):
        DormantHandler.actors_by_key = {}
        DormantHandler.actors = {}
        DormantHandler.next_id = 0
        DormantHandler.fresh_creates = 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), DormantHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def args(self, mode):
        return argparse.Namespace(
            mode=mode,
            api_mode="actor",
            engine_url="http://127.0.0.1:{}".format(self.server.server_port),
            workers_url="http://127.0.0.1:1",
            worker_name="q01-fdb-autoscale-gate",
            class_name="Agent",
            namespace="default",
            cell_id="actor-bj-b01",
            actor_name="workerd-counter",
            runner_name=["workerd-a", "workerd-b"],
            target_actors=8,
            probe_actors=4,
            concurrency=4,
            batch_size=3,
            batch_settle_seconds=0,
            operation_rate=0,
            max_idempotent_retries=3,
            retry_base_delay_seconds=0.001,
            request_timeout_seconds=5,
            run_id="unit-test",
            probe_epoch="expanded",
            manifest=pathlib.Path(self.temporary.name, "manifest.sqlite"),
            execution_site_file=None,
            auth_token_env=None,
            output=None,
        )

    def test_populate_resume_probe_and_exact_cleanup(self):
        result = dormant.run(self.args("populate"))
        self.assertEqual(result["actor_states"], {"dormant": 8})
        self.assertEqual(result["created_fresh"], 8)
        self.assertEqual(len(result["manifest_sha256"]), 64)
        self.assertEqual(DormantHandler.fresh_creates, 8)
        self.assertTrue(all(not value["active"] for value in DormantHandler.actors.values()))

        resumed = dormant.run(self.args("populate"))
        self.assertEqual(resumed["actor_states"], {"dormant": 8})
        self.assertEqual(DormantHandler.fresh_creates, 8)

        probed = dormant.run(self.args("probe"))
        self.assertEqual(probed["probe_states"], {"deleted": 4})
        self.assertEqual(probed["latency"]["cardinality_dormant_reopen"]["count"], 4)
        self.assertEqual(probed["latency"]["cardinality_get_or_create"]["count"], 4)
        self.assertEqual(probed["latency"]["cardinality_fresh_create"]["count"], 4)
        self.assertEqual(probed["latency"]["cardinality_delete"]["count"], 4)
        self.assertEqual(len(DormantHandler.actors), 8)
        self.assertTrue(all(not value["active"] for value in DormantHandler.actors.values()))

        # Model a process crash after DELETE committed remotely but before the local manifest
        # transaction. Retrying exact deletion must converge on HTTP 404, not strand cleanup.
        vanished_id = sorted(DormantHandler.actors)[0]
        vanished = DormantHandler.actors.pop(vanished_id)
        DormantHandler.actors_by_key.pop(vanished["key"])
        cleaned = dormant.run(self.args("cleanup"))
        self.assertEqual(cleaned["actor_states"], {"deleted": 8})
        self.assertEqual(cleaned["idempotent_delete_retries"]["cleanup"], 1)
        self.assertEqual(cleaned["latency"]["cleanup_delete"]["count"], 7)
        self.assertEqual(DormantHandler.actors, {})

    def test_large_run_requires_matching_beijing_site_proof(self):
        args = self.args("summary")
        args.target_actors = 4_097
        args.probe_actors = 1
        with self.assertRaisesRegex(ValueError, "execution-site-file"):
            dormant.run(args)

        site = pathlib.Path(self.temporary.name, "cell-id")
        site.write_text("actor-sh-a01\n")
        args.execution_site_file = site
        with self.assertRaisesRegex(ValueError, "does not match"):
            dormant.run(args)

        site.write_text("actor-bj-b01\n")
        result = dormant.run(args)
        self.assertEqual(result["target_actors"], 4_097)

    def test_actor_key_hash_precedes_ordinal(self):
        first = dormant.actor_key("run", 1)
        second = dormant.actor_key("run", 2)
        self.assertRegex(first, r"^dormant-[0-9a-f]{16}-000000001$")
        self.assertNotEqual(first.split("-")[1], second.split("-")[1])
        self.assertRegex(dormant.public_object_id("run", 1), r"^[0-9a-f]{64}$")

    def test_public_workers_v1_populate_probe_and_cleanup(self):
        PublicWorkersHandler.objects = {}
        PublicWorkersHandler.tombstones = set()
        PublicWorkersHandler.transient_failures = 0
        server = ThreadingHTTPServer(("127.0.0.1", 0), PublicWorkersHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            args = self.args("populate")
            args.api_mode = "workers-v1"
            args.workers_url = "http://127.0.0.1:{}".format(server.server_port)
            PublicWorkersHandler.transient_failures = 2
            populated = dormant.run(args)
            self.assertTrue(populated["public_api_only"])
            self.assertEqual(populated["api_mode"], "workers-v1")
            self.assertEqual(populated["worker_release"], {
                "worker": args.worker_name,
                "version_ids": [PublicWorkersHandler.version_id],
                "deployment_id": PublicWorkersHandler.deployment_id,
                "version_pool_size": 1,
            })
            self.assertEqual(populated["actor_states"], {"dormant": 8})
            self.assertEqual(populated["transport_or_overload_retries"], 2)
            self.assertTrue(all(value == 1 for value in PublicWorkersHandler.objects.values()))

            populate_one, open_one, _ = dormant.make_public_client(args)
            retried_create = populate_one(0)
            self.assertEqual(retried_create["generation"], 1)
            manifest = dormant.connect_manifest(args.manifest)
            try:
                first_record = dormant.sample_records(
                    manifest, args.target_actors, args.probe_actors
                )[0]
            finally:
                manifest.close()
            first_advance = open_one(first_record)
            retried_advance = open_one(first_record)
            self.assertEqual(first_advance["generation"], 2)
            self.assertEqual(retried_advance["generation"], 2)

            args.mode = "probe"
            probed = dormant.run(args)
            self.assertTrue(probed["public_api_only"])
            main_values = list(PublicWorkersHandler.objects.values())
            self.assertEqual(sorted(main_values), [1, 1, 1, 1, 2, 2, 2, 2])
            self.assertTrue(all(len(key) == 64 for key in PublicWorkersHandler.objects))

            first_epoch_tombstones = set(PublicWorkersHandler.tombstones)
            self.assertEqual(len(first_epoch_tombstones), args.probe_actors)
            args.probe_epoch = "contracted"
            reprobed = dormant.run(args)
            self.assertEqual(reprobed["probe_states"], {"deleted": args.probe_actors})
            self.assertEqual(
                len(PublicWorkersHandler.tombstones), args.probe_actors * 2
            )
            self.assertTrue(first_epoch_tombstones < PublicWorkersHandler.tombstones)

            args.mode = "cleanup"
            cleaned = dormant.run(args)
            self.assertEqual(cleaned["actor_states"], {"deleted": 8})
            self.assertEqual(PublicWorkersHandler.objects, {})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_public_batch_settle_is_explicit_and_actor_mode_never_sleeps(self):
        args = self.args("populate")
        args.batch_settle_seconds = 45
        with mock.patch.object(dormant.time, "sleep") as sleep:
            dormant.settle_public_batch(args)
            sleep.assert_not_called()

        args.api_mode = "workers-v1"
        with mock.patch.object(dormant.time, "sleep") as sleep:
            dormant.settle_public_batch(args)
            sleep.assert_called_once_with(45)

    def test_idempotent_retry_is_bounded_and_status_classified(self):
        args = self.args("populate")
        attempts = []

        def eventually_succeeds():
            attempts.append(1)
            if len(attempts) < 3:
                raise dormant.PublicRequestFailure("PUT", "http://worker", 503, {})
            return {"ordinal": 1}

        pacer = mock.Mock()
        with mock.patch.object(dormant.time, "sleep") as sleep:
            result = dormant.retry_idempotent_public_operation(
                args, pacer, eventually_succeeds
            )
        self.assertEqual(result["operation_retries"], 2)
        self.assertEqual(pacer.wait.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

        attempts.clear()
        with self.assertRaises(dormant.PublicRequestFailure):
            dormant.retry_idempotent_public_operation(
                args,
                pacer,
                lambda: (_ for _ in ()).throw(
                    dormant.PublicRequestFailure("POST", "http://worker", 409, {})
                ),
            )


if __name__ == "__main__":
    unittest.main()
