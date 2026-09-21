import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / "scripts").is_dir())


def load_script(name: str):
    path = REPO_ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


migrate = load_script("migrate_user_to_velagw.py")
reset = load_script("reset_velagw_user_quota.py")
batch = load_script("dry_run_velagw_user_quotas.py")


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()


class QueueOpener:
    def __init__(self, payloads: list[dict]) -> None:
        self.payloads = list(payloads)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.payloads:
            raise AssertionError("unexpected HTTP request")
        return FakeResponse(self.payloads.pop(0))


class VelaGWUserOpsTests(unittest.TestCase):
    def test_batch_dry_run_normalizes_deduplicates_and_reports_invalid_users(self) -> None:
        valid, invalid = batch.parse_user_ids([
            "\u2005usr\\_abc\n",
            "usr_abc\n",
            "usr_def &#x20;\n",
            "invalid-user\n",
        ])
        self.assertEqual(valid, ["usr_abc", "usr_def"])
        self.assertEqual(invalid, ["invalid-user"])

    def test_batch_dry_run_continues_after_non_resettable_user_and_never_posts(self) -> None:
        ready_binding = {"success": True, "data": {"row": {"values": {
            "set_id": "set-a", "upstream_user_id": 20, "last_plan_id": "plan-launch",
        }}}}
        ready_plan = {"success": True, "data": [{
            "set_id": "set-a", "status": "ready", "upstream_plan_id": 1,
        }]}
        ready_sub = {"success": True, "data": [{"subscription": {
            "id": 31, "status": "active", "plan_id": 1, "amount_used": 10,
            "next_reset_time": 1800000000, "end_time": 1900000000,
        }}]}
        empty_sub = {"success": True, "data": []}
        opener = QueueOpener([
            ready_binding, ready_plan, ready_sub,
            ready_binding, ready_plan, empty_sub,
        ])
        output = io.StringIO()

        result = batch.run_audit(
            "https://velagw.test", "secret", ["usr_ready", "usr_empty"], [],
            opener=opener, output=output,
        )

        rows = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(result, 0)
        self.assertEqual(rows[0]["user_id"], "usr_ready")
        self.assertEqual(rows[0]["status"], "ready")
        self.assertEqual(rows[1]["user_id"], "usr_empty")
        self.assertEqual(rows[1]["status"], "not_resettable")
        self.assertEqual(rows[-1], {
            "status": "summary", "total": 2, "ready": 1,
            "legacy_active": 0, "not_resettable": 1, "failed": 0,
        })
        self.assertTrue(all(request.get_method() == "GET" for request, _ in opener.requests))
        self.assertNotIn("secret", output.getvalue())

    def test_batch_dry_run_can_probe_legacy_gateway_subscription(self) -> None:
        opener = QueueOpener([{"code": "OK", "data": {
            "id": "legacy-sub-1",
            "user_id": "1501f071-ab5d-4d1b-9a46-05319cc289a2",
            "plan_id": "legacy-plan",
            "status": "active",
            "token_balance": 120000,
            "period_start": "2026-09-01T00:00:00Z",
            "period_end": "2026-10-01T00:00:00Z",
        }}])

        row = batch.probe_legacy_gateway(
            "https://legacy.test", "legacy-secret", "usr_legacy", opener=opener, timeout=30,
        )

        self.assertEqual(row["gateway"], "ai_gateway")
        self.assertEqual(row["status"], "legacy_active")
        self.assertEqual(row["token_balance"], 120000)
        self.assertEqual(opener.requests[0][0].get_method(), "GET")
        self.assertTrue(opener.requests[0][0].full_url.endswith("/api/internal/users/usr_legacy/subscriptions"))

    def test_migration_defaults_to_server_side_dry_run(self) -> None:
        opener = QueueOpener([{"code": "OK", "data": {
            "user_id": "usr_abc", "instance_id": "ins-1", "dry_run": True,
            "previous_gateway": "ai_gateway", "target_gateway": "llm_gateway",
        }}])
        output = io.StringIO()

        result = migrate.run_migration(
            "https://ctl.test", "secret", "usr_abc", "ins-1",
            execute=False, confirm_user_id="", opener=opener, output=output,
        )

        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 1)
        request = opener.requests[0][0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {"user_id": "usr_abc", "dry_run": True})
        self.assertNotIn("secret", output.getvalue())

    def test_migration_execute_requires_matching_confirmation_and_preflights_first(self) -> None:
        with self.assertRaisesRegex(ValueError, "confirmation"):
            migrate.run_migration(
                "https://ctl.test", "secret", "usr_abc", "ins-1",
                execute=True, confirm_user_id="usr_other", opener=QueueOpener([]), output=io.StringIO(),
            )

        opener = QueueOpener([
            {"code": "OK", "data": {"user_id": "usr_abc", "instance_id": "ins-1", "dry_run": True}},
            {"code": "OK", "data": {
                "user_id": "usr_abc", "instance_id": "ins-1", "migrated": True,
                "key_id": "key-1", "key_prefix": "sk-abc", "legacy_key_revoked": True,
            }},
        ])
        result = migrate.run_migration(
            "https://ctl.test", "secret", "usr_abc", "ins-1",
            execute=True, confirm_user_id="usr_abc", opener=opener, output=io.StringIO(),
        )
        self.assertEqual(result, 0)
        self.assertEqual([json.loads(item[0].data)["dry_run"] for item in opener.requests], [True, False])

    def test_quota_reset_is_scoped_and_preserves_subscription_schedule(self) -> None:
        binding = {"success": True, "data": {"row": {"values": {
            "set_id": "set-a", "upstream_user_id": 20, "last_plan_id": "plan-launch",
        }}}}
        plans = {"success": True, "data": [{
            "set_id": "set-a", "status": "ready", "upstream_plan_id": 1,
        }]}
        before = {"success": True, "data": [{"subscription": {
            "id": 31, "status": "active", "plan_id": 1, "amount_used": 6635881,
            "next_reset_time": 1800000000, "end_time": 1900000000,
        }}]}
        reset_result = {"success": True, "data": {
            "reset_count": 1, "user_count": 1, "advance_reset_time": False,
        }}
        after = {"success": True, "data": [{"subscription": {
            "id": 31, "status": "active", "plan_id": 1, "amount_used": 0,
            "next_reset_time": 1800000000, "end_time": 1900000000,
        }}]}
        opener = QueueOpener([binding, plans, before, reset_result, after])
        output = io.StringIO()

        result = reset.run_reset(
            "https://velagw.test", "secret", "usr_abc",
            execute=True, confirm_user_id="usr_abc", opener=opener, output=output,
        )

        self.assertEqual(result, 0)
        self.assertEqual(len(opener.requests), 5)
        reset_request = opener.requests[3][0]
        self.assertEqual(
            json.loads(reset_request.data),
            {"plan_id": 1, "advance_reset_time": False},
        )
        summary = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(summary["amount_used_before"], 6635881)
        self.assertEqual(summary["amount_used_after"], 0)
        self.assertTrue(summary["schedule_unchanged"])
        self.assertNotIn("secret", output.getvalue())

    def test_quota_reset_refuses_ambiguous_active_subscriptions(self) -> None:
        opener = QueueOpener([
            {"success": True, "data": {"row": {"values": {
                "set_id": "set-a", "upstream_user_id": 20, "last_plan_id": "plan-launch",
            }}}},
            {"success": True, "data": [{"set_id": "set-a", "status": "ready", "upstream_plan_id": 1}]},
            {"success": True, "data": [
                {"subscription": {"id": 31, "status": "active", "plan_id": 1, "amount_used": 3}},
                {"subscription": {"id": 32, "status": "active", "plan_id": 2, "amount_used": 4}},
            ]},
        ])

        with self.assertRaisesRegex(reset.SafetyError, "exactly one active subscription"):
            reset.run_reset(
                "https://velagw.test", "secret", "usr_abc",
                execute=False, confirm_user_id="", opener=opener, output=io.StringIO(),
            )

    def test_quota_reset_refuses_missing_schedule_before_write(self) -> None:
        opener = QueueOpener([
            {"success": True, "data": {"row": {"values": {
                "set_id": "set-a", "upstream_user_id": 20, "last_plan_id": "plan-launch",
            }}}},
            {"success": True, "data": [{"set_id": "set-a", "status": "ready", "upstream_plan_id": 1}]},
            {"success": True, "data": [{"subscription": {
                "id": 31, "status": "active", "plan_id": 1, "amount_used": 9,
            }}]},
        ])

        with self.assertRaisesRegex(reset.SafetyError, "next_reset_time"):
            reset.run_reset(
                "https://velagw.test", "secret", "usr_abc",
                execute=True, confirm_user_id="usr_abc", opener=opener, output=io.StringIO(),
            )
        self.assertEqual(len(opener.requests), 3)


if __name__ == "__main__":
    unittest.main()
