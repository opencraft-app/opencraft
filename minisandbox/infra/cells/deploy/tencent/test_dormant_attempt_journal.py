from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

from test_qualify_dormant_actors import (
    PublicWorkersHandler,
    ThreadingHTTPServer,
    dormant,
)
import test_qualify_dormant_actors as fixtures


class JournalHandler(PublicWorkersHandler):
    lost_method = None
    mutations = []
    deleted_ids = []
    manifest_path = None
    observed_intents = []
    hold_put = False
    committed = None
    release = None

    def do_POST(self):
        type(self).mutations.append(("POST", self.parts()))
        super().do_POST()

    def do_PUT(self):
        object_id = self.parts()[-1]
        with sqlite3.connect(self.manifest_path) as db:
            try:
                row = db.execute(
                    "SELECT state FROM public_attempts WHERE object_id=?", (object_id,),
                ).fetchone()
            except sqlite3.OperationalError:
                row = None
        type(self).observed_intents.append(row[0] if row else None)
        super().do_PUT()

    def do_DELETE(self):
        type(self).deleted_ids.append(self.parts()[-1])
        super().do_DELETE()

    def reply(self, value, status=200):
        if self.command == "PUT" and type(self).hold_put:
            type(self).hold_put = False
            type(self).committed.set()
            type(self).release.wait(10)
        if self.command == type(self).lost_method and (
                self.command in ("PUT", "DELETE") or self.parts()[-1] == "fetch"):
            type(self).lost_method = None
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        try:
            super().reply(value, status)
        except (BrokenPipeError, ConnectionResetError):
            if not type(self).committed.is_set():
                raise

    def end_headers(self):
        if self.command == "DELETE" and type(self).lost_method == "DELETE":
            type(self).lost_method = None
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        super().end_headers()


class AttemptJournalTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        JournalHandler.objects = {}
        JournalHandler.tombstones = set()
        JournalHandler.transient_failures = 0
        JournalHandler.mutations = []
        JournalHandler.deleted_ids = []
        JournalHandler.observed_intents = []
        JournalHandler.lost_method = None
        JournalHandler.hold_put = False
        JournalHandler.committed = threading.Event()
        JournalHandler.release = threading.Event()
        JournalHandler.manifest_path = str(Path(self.temporary.name) / "manifest.sqlite")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), JournalHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.args = fixtures.DormantQualificationTests.args(self, "populate")
        self.args.api_mode = "workers-v1"
        self.args.workers_url = f"http://127.0.0.1:{self.server.server_port}"
        self.args.target_actors = 4
        self.args.probe_actors = 2
        self.args.batch_size = 2
        self.args.concurrency = 1
        self.args.max_idempotent_retries = 0

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def test_intent_is_durable_before_every_first_request(self):
        result = dormant.run(self.args)
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(JournalHandler.observed_intents, ["pending"] * 4)
        with sqlite3.connect(self.args.manifest) as db:
            self.assertEqual(db.execute(
                "SELECT state,COUNT(*) FROM public_attempts GROUP BY state",
            ).fetchall(), [("confirmed", 4)])

    def test_lost_create_or_committed_advance_response_is_cleaned(self):
        for method in ("PUT", "POST"):
            with self.subTest(method=method):
                JournalHandler.objects = {}
                self.args.manifest = Path(self.temporary.name) / f"{method}.sqlite"
                self.args.run_id = f"lost-{method.lower()}"
                JournalHandler.manifest_path = str(self.args.manifest)
                JournalHandler.lost_method = method
                self.args.mode = "populate"
                with self.assertRaisesRegex(RuntimeError, "population operation"):
                    dormant.run(self.args)
                self.assertEqual(len(JournalHandler.objects), 2)
                mutations_before = list(JournalHandler.mutations)
                self.args.mode = "cleanup"
                result = dormant.run(self.args)
                self.assertEqual(JournalHandler.objects, {})
                self.assertEqual(JournalHandler.mutations, mutations_before)
                self.assertEqual(result["verdict"], "passed")
                self.assertEqual(result["public_attempt_states"], {"deleted": 2})

    def test_population_resume_preserves_exact_committed_state_and_attempts(self):
        JournalHandler.lost_method = "POST"
        with self.assertRaisesRegex(RuntimeError, "population operation"):
            dormant.run(self.args)
        result = dormant.run(self.args)
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(list(JournalHandler.objects.values()), [1] * 4)
        self.assertEqual(result["public_attempt_states"], {"confirmed": 4})
        self.assertEqual(result["public_scheduled_operations"], 5)

    def test_process_kill_after_create_commit_preserves_exact_cleanup(self):
        JournalHandler.hold_put = True
        process = subprocess.Popen([
            sys.executable, str(fixtures.MODULE_PATH), "populate",
            "--api-mode", "workers-v1", "--workers-url", self.args.workers_url,
            "--cell-id", self.args.cell_id,
            "--runner-name", "workerd-a", "--runner-name", "workerd-b",
            "--target-actors", "4", "--probe-actors", "2", "--batch-size", "2",
            "--concurrency", "1", "--run-id", self.args.run_id,
            "--manifest", str(self.args.manifest), "--max-idempotent-retries", "0",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.assertTrue(JournalHandler.committed.wait(5), "real create commit was not observed")
            before = list(JournalHandler.mutations)
            self.args.mode = "cleanup"
            with self.assertRaisesRegex(RuntimeError, "already in use"):
                dormant.run(self.args)
            self.assertEqual(JournalHandler.mutations, before)
            self.assertEqual(JournalHandler.deleted_ids, [])
            process.kill()
            process.wait(timeout=5)
            JournalHandler.release.set()
            self.assertEqual(len(JournalHandler.objects), 1)
            with sqlite3.connect(self.args.manifest) as db:
                self.assertEqual(db.execute(
                    "SELECT state,COUNT(*) FROM public_attempts GROUP BY state",
                ).fetchall(), [("pending", 2)])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM actors").fetchone()[0], 0)
            self.args.mode = "cleanup"
            result = dormant.run(self.args)
            self.assertEqual(result["verdict"], "passed")
            self.assertEqual(result["public_attempt_states"], {"deleted": 2})
            self.assertEqual(JournalHandler.objects, {})
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            JournalHandler.release.set()

    def test_lost_delete_response_resumes_without_recreating_objects(self):
        dormant.run(self.args)
        JournalHandler.lost_method = "DELETE"
        self.args.mode = "cleanup"
        with self.assertRaisesRegex(RuntimeError, "public cleanup"):
            dormant.run(self.args)
        before = list(JournalHandler.mutations)
        result = dormant.run(self.args)
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["public_attempt_states"], {"deleted": 4})
        self.assertEqual(JournalHandler.objects, {})
        self.assertEqual(JournalHandler.mutations, before)

    def test_corrupt_journal_identity_cannot_expand_deletion_scope(self):
        dormant.run(self.args)
        owned = set(JournalHandler.objects)
        with sqlite3.connect(self.args.manifest) as db:
            db.execute("UPDATE public_attempts SET object_id='foreign-object' WHERE ordinal=0")
        self.args.mode = "cleanup"
        with self.assertRaisesRegex(RuntimeError, "exact run identity"):
            dormant.run(self.args)
        self.assertNotIn("foreign-object", JournalHandler.deleted_ids)
        # Earlier valid batches may commit before the corrupt row is reached.
        self.assertTrue(set(JournalHandler.deleted_ids).issubset(owned))
        self.assertTrue(set(JournalHandler.objects).issubset(owned))

    def test_pending_queues_use_explicit_indexes(self):
        dormant.run(self.args)
        with sqlite3.connect(self.args.manifest) as db:
            cleanup = db.execute(
                "EXPLAIN QUERY PLAN SELECT ordinal,object_id,kind,prefix FROM public_attempts "
                "WHERE state!='deleted' ORDER BY object_id LIMIT 2",
            ).fetchall()
            epoch = db.execute(
                "EXPLAIN QUERY PLAN SELECT DISTINCT prefix FROM public_attempts "
                "WHERE kind='probes' AND state!='deleted'",
            ).fetchall()
        self.assertTrue(any("public_attempts_cleanup" in row[3] for row in cleanup), cleanup)
        self.assertTrue(any("public_attempts_probe_epoch" in row[3] for row in epoch), epoch)
        self.assertFalse(any("TEMP B-TREE" in row[3] for row in cleanup + epoch))

    def test_probe_response_loss_keeps_the_original_epoch_for_cleanup(self):
        dormant.run(self.args)
        self.args.mode = "probe"
        JournalHandler.lost_method = "PUT"
        with self.assertRaisesRegex(RuntimeError, "create probe"):
            dormant.run(self.args)
        self.assertEqual(len(JournalHandler.objects), 6)
        before = list(JournalHandler.deleted_ids)
        self.args.probe_epoch = "replacement"
        with self.assertRaisesRegex(RuntimeError, "unfinished probe epoch"):
            dormant.run(self.args)
        self.assertEqual(JournalHandler.deleted_ids, before)
        self.args.mode = "cleanup"
        result = dormant.run(self.args)
        self.assertEqual(result["public_attempt_states"], {"deleted": 6})
        self.assertEqual(JournalHandler.objects, {})

    def test_manifest_mismatch_precedes_code_plane_mutation(self):
        dormant.run(self.args)
        before = list(JournalHandler.mutations)
        self.args.worker_name = "wrong-worker"
        with self.assertRaisesRegex(RuntimeError, "manifest configuration mismatch"):
            dormant.run(self.args)
        self.assertEqual(JournalHandler.mutations, before)

    def test_cleanup_and_summary_never_republish_code(self):
        dormant.run(self.args)
        before = list(JournalHandler.mutations)
        self.args.mode = "summary"
        dormant.run(self.args)
        self.args.mode = "cleanup"
        result = dormant.run(self.args)
        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(JournalHandler.objects, {})
        self.assertEqual(JournalHandler.mutations, before)


if __name__ == "__main__":
    unittest.main()
