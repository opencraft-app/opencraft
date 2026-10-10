"""Focused tests for the operator-only quota reset batch script."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlparse


SCRIPT = Path(__file__).resolve().parents[1] / "reset_gateway_user_quota.py"


class QuotaFixture:
    def __init__(self):
        self.amount = {"usr_alpha": 100, "usr_beta": 0, "usr_gamma": 50}
        self.bots = ["usr_alpha", "usr_alpha", "usr_beta", "usr_gamma"]
        self.reset_calls: list[str] = []
        self.preview_calls: list[str] = []
        self.fail_user = ""
        self.fail_execute_user = ""
        self.guard_user = ""
        self.guard_code = "PASS_ISOLATING"
        self.transient_preview_remaining = 0
        self.additive: dict[str, str] = {}
        self.lock = threading.Lock()


def handler_for(fixture: QuotaFixture):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status: int, value: dict):
            raw = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.headers.get("Authorization") != "Bearer test-token":
                return self.reply(401, {"code": "UNAUTHORIZED"})
            url = urlparse(self.path)
            prefix = "/api/internal/users/"
            suffix = "/subscriptions/active"
            if url.path.startswith(prefix) and url.path.endswith(suffix):
                user_id = url.path[len(prefix):-len(suffix)]
                subscriptions = [{"user_id": user_id, "name": f"package:{user_id}", "status": "active"}]
                if user_id in fixture.additive:
                    subscriptions.append({"user_id": user_id, "name": fixture.additive[user_id], "status": "active"})
                return self.reply(200, {"success": True, "data": {"user_id": user_id,
                                                                      "subscriptions": subscriptions}})
            if url.path != "/internal/bots":
                return self.reply(404, {})
            params = parse_qs(url.query)
            if params.get("status") != ["Running"]:
                return self.reply(400, {})
            page = int(params["page"][0])
            size = int(params["page_size"][0])
            subset = fixture.bots[(page - 1) * size : page * size]
            self.reply(200, {"total": len(fixture.bots), "page": page, "page_size": size,
                             "items": [{"user_id": user_id} for user_id in subset]})

        def do_POST(self):
            if self.headers.get("Authorization") != "Bearer test-token":
                return self.reply(401, {"code": "UNAUTHORIZED"})
            prefix = "/internal/users/"
            suffix = "/gateway/quota/reset"
            if not self.path.startswith(prefix) or not self.path.endswith(suffix):
                return self.reply(404, {})
            user_id = self.path[len(prefix):-len(suffix)]
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if body["dry_run"] and fixture.transient_preview_remaining > 0:
                fixture.transient_preview_remaining -= 1
                return self.reply(503, {"code": "UNAVAILABLE"})
            if user_id == fixture.fail_user:
                return self.reply(500, {"code": "FAILED"})
            if user_id == fixture.guard_user:
                return self.reply(403, {"code": fixture.guard_code})
            if user_id == fixture.fail_execute_user and not body["dry_run"]:
                return self.reply(500, {"code": "UNKNOWN_RESULT"})
            with fixture.lock:
                before = fixture.amount[user_id]
                dry_run = body["dry_run"]
                if dry_run:
                    fixture.preview_calls.append(user_id)
                else:
                    fixture.reset_calls.append(user_id)
                    fixture.amount[user_id] = 0
            result = {
                "user_id": user_id, "gateway": "llm_gateway", "set_id": "set-a",
                "subscription_id": f"sub-{user_id}", "status": "ready" if dry_run else "reset",
                "dry_run": dry_run, "amount_used_before": before,
                "amount_used_after": before if dry_run else 0,
                "next_reset_time": 1800000000, "end_time": 1900000000,
                "schedule_unchanged": not dry_run,
            }
            self.reply(200, {"code": "OK", "message": "success", "data": result})

    return Handler


class BatchResetTests(unittest.TestCase):
    def setUp(self):
        self.fixture = QuotaFixture()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.fixture))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "checkpoint.jsonl"
        self.base = ["--base-url", f"http://127.0.0.1:{self.server.server_port}",
                     "--state-file", str(self.state), "--environment", "test", "--interval", "0"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def invoke(self, *args: str):
        env = {**os.environ, "CTL_INTERNAL_TOKEN": "test-token",
               "LLMGATEWAY_INTERNAL_TOKEN": "test-token"}
        result = subprocess.run([sys.executable, str(SCRIPT), *self.base, *args],
                                capture_output=True, text=True, env=env, timeout=10)
        self.assertNotIn("test-token", result.stdout + result.stderr)
        return result

    def test_default_dry_run_deduplicates_and_limit_then_resumes(self):
        first = self.invoke("--all-running-bots", "--limit", "2")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_beta"])
        self.assertEqual(self.fixture.reset_calls, [])
        self.assertEqual(self.fixture.amount["usr_alpha"], 100)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

        second = self.invoke("--all-running-bots", "--limit", "all")
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_beta", "usr_gamma"])
        self.assertEqual(json.loads(second.stdout.splitlines()[-1])["processed"], 1)

    def test_execute_requires_confirmation_and_does_not_repeat_completed_user(self):
        refused = self.invoke("--user-id", "usr_alpha", "--execute")
        self.assertEqual(refused.returncode, 2)
        self.assertEqual(self.fixture.reset_calls, [])

        args = ("--user-id", "usr_alpha", "--user-id", "usr_beta", "--limit", "all",
                "--execute", "--confirm", "RESET-USER-QUOTAS")
        first = self.invoke(*args)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_alpha", "usr_beta"])
        self.assertEqual(self.fixture.reset_calls, ["usr_alpha"])
        self.assertEqual(self.fixture.amount["usr_alpha"], 0)
        self.assertEqual([json.loads(line)["status"] for line in self.state.read_text().splitlines()],
                         ["inflight", "reset", "already_reset"])

        second = self.invoke(*args)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.fixture.reset_calls, ["usr_alpha"])
        self.assertEqual(json.loads(second.stdout.splitlines()[-1])["processed"], 0)

    def test_http_failure_stops_before_next_user_and_is_not_checkpointed(self):
        self.fixture.fail_user = "usr_alpha"
        result = self.invoke("--user-id", "usr_alpha", "--user-id", "usr_gamma", "--limit", "all")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.fixture.preview_calls, [])
        self.assertEqual(self.fixture.reset_calls, [])
        self.assertEqual(self.state.read_text(), "")

    def test_transient_preview_retries_but_real_write_runs_once(self):
        self.fixture.transient_preview_remaining = 2
        result = self.invoke("--user-id", "usr_alpha", "--execute", "--confirm", "RESET-USER-QUOTAS")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_alpha"])
        self.assertEqual(self.fixture.reset_calls, ["usr_alpha"])

    def test_checkpoint_cannot_be_reused_across_environments(self):
        first = self.invoke("--user-id", "usr_alpha")
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        second = self.invoke("--user-id", "usr_alpha", "--environment", "other")
        self.assertEqual(second.returncode, 1)
        self.assertIn("another environment", second.stdout)

    def test_users_file_skips_comments_and_duplicate_ids(self):
        users = Path(self.temp.name) / "users.txt"
        users.write_text("# campaign\nusr_alpha\nusr_alpha # duplicate\nusr_gamma\n", encoding="utf-8")
        result = self.invoke("--users-file", str(users), "--limit", "all")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_gamma"])

    def test_execute_unknown_result_stops_without_retrying(self):
        self.fixture.fail_execute_user = "usr_alpha"
        result = self.invoke("--user-id", "usr_alpha", "--user-id", "usr_gamma",
                             "--limit", "all", "--execute", "--confirm", "RESET-USER-QUOTAS")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.fixture.preview_calls, ["usr_alpha", "usr_alpha"])
        self.assertEqual(self.fixture.reset_calls, [])
        self.assertEqual([json.loads(line)["status"] for line in self.state.read_text().splitlines()], ["inflight"])
        resumed = self.invoke("--user-id", "usr_alpha", "--user-id", "usr_gamma",
                              "--limit", "all", "--execute", "--confirm", "RESET-USER-QUOTAS")
        self.assertEqual(resumed.returncode, 1)
        self.assertIn("unresolved reset outcome", resumed.stdout)
        self.assertEqual(self.fixture.reset_calls, [])

    def test_additive_credit_is_skipped_and_recorded_separately(self):
        self.fixture.additive["usr_beta"] = "credit-package:paid-1"
        skip_path = Path(self.temp.name) / "credit-skips.jsonl"
        args = ("--user-id", "usr_alpha", "--user-id", "usr_beta", "--user-id", "usr_gamma",
                "--skip-additive-credit", "--llmgateway-base-url", f"http://127.0.0.1:{self.server.server_port}",
                "--credit-skip-file", str(skip_path), "--limit", "3",
                "--execute", "--confirm", "RESET-USER-QUOTAS")
        first = self.invoke(*args)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.fixture.reset_calls, ["usr_alpha", "usr_gamma"])
        self.assertEqual(json.loads(skip_path.read_text())["user_id"], "usr_beta")
        self.assertEqual(skip_path.stat().st_mode & 0o777, 0o600)
        self.assertIn("skipped_additive_credit", [json.loads(line)["status"] for line in self.state.read_text().splitlines()])
        second = self.invoke(*args)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(self.fixture.reset_calls, ["usr_alpha", "usr_gamma"])
        self.assertEqual(len(skip_path.read_text().splitlines()), 1)

    def test_known_pass_guard_is_recorded_and_other_user_continues(self):
        self.fixture.guard_user = "usr_alpha"
        skip_path = Path(self.temp.name) / "ineligible.jsonl"
        args = ("--user-id", "usr_alpha", "--user-id", "usr_gamma", "--limit", "all",
                "--skip-ineligible-pass", "--ineligible-pass-file", str(skip_path),
                "--execute", "--confirm", "RESET-USER-QUOTAS")
        first = self.invoke(*args)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        self.assertEqual(self.fixture.reset_calls, ["usr_gamma"])
        self.assertEqual(json.loads(skip_path.read_text())["reason"], "PASS_ISOLATING")
        self.assertEqual(skip_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual([json.loads(line)["status"] for line in self.state.read_text().splitlines()],
                         ["skipped_ineligible_pass", "inflight", "reset"])
        again = self.invoke(*args)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.fixture.reset_calls, ["usr_gamma"])

    def test_unknown_403_still_stops_without_checkpoint(self):
        self.fixture.guard_user = "usr_alpha"
        self.fixture.guard_code = "UNAUTHORIZED"
        skip_path = Path(self.temp.name) / "ineligible.jsonl"
        result = self.invoke("--user-id", "usr_alpha", "--user-id", "usr_gamma", "--limit", "all",
                             "--skip-ineligible-pass", "--ineligible-pass-file", str(skip_path),
                             "--execute", "--confirm", "RESET-USER-QUOTAS")
        self.assertEqual(result.returncode, 1)
        self.assertIn("UNAUTHORIZED", result.stdout)
        self.assertEqual(self.state.read_text(), "")
        self.assertEqual(skip_path.read_text(), "")


if __name__ == "__main__":
    unittest.main()
