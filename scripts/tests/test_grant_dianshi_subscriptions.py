import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path


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
            142123551192174,
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
            142123551192174,
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


if __name__ == "__main__":
    unittest.main()
