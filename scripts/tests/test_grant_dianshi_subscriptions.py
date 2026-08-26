import importlib.util
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / "scripts").is_dir())
SCRIPT_PATH = REPO_ROOT / "scripts" / "grant_dianshi_subscriptions.py"

spec = importlib.util.spec_from_file_location("grant_dianshi_subscriptions", SCRIPT_PATH)
assert spec is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
assert spec.loader is not None
spec.loader.exec_module(module)


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class QueueOpener:
    def __init__(self, payloads: list[dict]) -> None:
        self.payloads = list(payloads)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.payloads:
            raise AssertionError("unexpected HTTP request")
        return FakeResponse(self.payloads.pop(0))


class GrantDianshiSubscriptionsTests(unittest.TestCase):
    def test_parse_user_ids_deduplicates_and_reports_invalid(self) -> None:
        valid, invalid = module.parse_user_ids([
            "# campaign\n",
            "usr_abc123\n",
            "\n",
            "usr_abc123\n",
            "bad-user\n",
            "usr_def456 # inline comment\n",
        ])
        self.assertEqual(valid, ["usr_abc123", "usr_def456"])
        self.assertEqual(invalid, ["bad-user"])

    def test_process_user_registers_polls_and_grants(self) -> None:
        opener = QueueOpener([
            {"code": "OK", "data": {"status": "pending"}},
            {"code": "OK", "data": {"status": "active"}},
            {"code": "OK", "data": {"status": "granted", "deal_name": "deal-1"}},
        ])
        client = module.InternalClient("https://auth.test", "https://ctl.test", "secret-token", opener=opener)
        result = module.process_user(
            client,
            "usr_abc123",
            "bundle_launch_ai_01",
            165523570799387,
            142163399386388,
            "1m",
            "campaign-secret",
            timeout=5,
            poll_interval=0,
            sleep=lambda _seconds: None,
        )
        self.assertEqual(result["status"], "granted")
        self.assertEqual(result["deal_name"], "deal-1")
        self.assertEqual(len(opener.requests), 3)
        self.assertEqual(opener.requests[0][0].get_header("Authorization"), "Bearer secret-token")
        self.assertIn("/internal/shadow/binding/register-or-retry", opener.requests[0][0].full_url)
        self.assertIn("/internal/shadow/binding/state?external_user_id=usr_abc123", opener.requests[1][0].full_url)
        self.assertIn("/internal/ctl/subscriptions/dianshi/grant", opener.requests[2][0].full_url)
        grant_body = json.loads(opener.requests[2][0].data.decode("utf-8"))
        self.assertEqual(grant_body, {
            "external_user_id": "usr_abc123",
            "bundle_id": "bundle_launch_ai_01",
            "activity_id": 165523570799387,
            "act_id": 142163399386388,
            "time_span_unit": "1m",
            "secret_key": "campaign-secret",
        })

    def test_run_batch_continues_after_terminal_auth_failure(self) -> None:
        opener = QueueOpener([
            {"code": "OK", "data": {"status": "failed", "last_error_code": "billing_account_open_failed"}},
            {"code": "OK", "data": {"status": "active"}},
            {"code": "OK", "data": {"status": "skipped"}},
        ])
        client = module.InternalClient("https://auth.test", "https://ctl.test", "secret-token", opener=opener)
        output = io.StringIO()
        exit_code = module.run_batch(
            client,
            ["usr_bad1", "usr_good2"],
            [],
            "bundle_launch_ai_01",
            165523570799387,
            142163399386388,
            "1m",
            "campaign-secret",
            timeout=5,
            poll_interval=0,
            output=output,
            sleep=lambda _seconds: None,
        )
        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(exit_code, 1)
        self.assertEqual(rows[0]["phase"], "auth")
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[1]["status"], "skipped")

    def test_parse_args_requires_explicit_campaign_parameters(self) -> None:
        argv = [
            str(SCRIPT_PATH),
            "/tmp/users.txt",
            "--bundle-id", "bundle_launch_ai_01",
            "--activity-id", "165523570799387",
            "--act-id", "142163399386388",
            "--time-span-unit", "1m",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.dict(
            os.environ,
            {"DIANSHI_ACTIVITY_SECRET_KEY": "campaign-secret"},
        ):
            args = module.parse_args()

        self.assertEqual(args.bundle_id, "bundle_launch_ai_01")
        self.assertEqual(args.activity_id, 165523570799387)
        self.assertEqual(args.act_id, 142163399386388)
        self.assertEqual(args.time_span_unit, "1m")
        self.assertEqual(args.campaign_key, "campaign-secret")

    def test_main_rejects_missing_campaign_secret_before_opening_input(self) -> None:
        argv = [
            str(SCRIPT_PATH),
            "/path/that/must/not/be/opened.txt",
            "--bundle-id", "bundle_launch_ai_01",
            "--activity-id", "165523570799387",
            "--act-id", "142163399386388",
            "--time-span-unit", "1m",
        ]
        with mock.patch.object(sys, "argv", argv), mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, "DIANSHI_ACTIVITY_SECRET_KEY is required"):
                module.main()


if __name__ == "__main__":
    unittest.main()
