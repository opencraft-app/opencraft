import json
import os
import unittest
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import patch

from app import (
    COMPLETE_DELIVERY_LUA,
    DEDUPE_TTL_SECONDS,
    DEDUPE_PREFIX,
    FAILURE_DELIVERY_LUA,
    MAX_ATTEMPTS,
    RETRY_KEY,
    START_DELIVERY_LUA,
    STATE_PREFIX,
    STREAM_KEY,
    TOKEN_BUCKET_LUA,
    acquire_scan_lock,
    build_event_key,
    build_notification_payload,
    classify_sms_exception,
    classify_sms_result,
    destination_allowed,
    enqueue_notification,
    expiry_windows,
    fetch_expiring_page,
    normalize_cn_phone,
    pending_scan_dates,
    process_message,
    promote_due_retries,
    queue_keys,
    read_worker_messages,
    release_scan_lock,
    scanner_handler,
    sms_template_id,
    transition_failure,
    utc_expiry_bounds,
    validate_delivery,
    validate_test_destination,
    wait_for_sms_token,
)


class FakeRedis:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def eval(self, script, key_count, *args):
        self.calls.append((script, key_count, args))
        return self.result


class SMSConfigurationTest(unittest.TestCase):
    def test_template_id_is_required_without_a_default(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(KeyError):
                sms_template_id()


class FakeWorkerRedis:
    def __init__(self):
        self.calls = []

    def xautoclaim(self, *args, **kwargs):
        self.calls.append(("xautoclaim", args, kwargs))
        return ["0-0", [("1-0", {"payload": "stale"})], []]

    def xreadgroup(self, *args, **kwargs):
        self.calls.append(("xreadgroup", args, kwargs))
        return [("stream", [("2-0", {"payload": "new"})])]


class FakeRetryRedis:
    def __init__(self, eval_result=None, state=None):
        self.eval_result = eval_result or []
        self.state = state
        self.calls = []

    def eval(self, script, key_count, *args):
        self.calls.append(("eval", script, key_count, args))
        return self.eval_result

    def zadd(self, key, mapping):
        self.calls.append(("zadd", key, mapping))
        return 1

    def setex(self, key, ttl, value):
        self.calls.append(("setex", key, ttl, value))
        return True

    def get(self, key):
        self.calls.append(("get", key))
        return self.state


class FakeLockRedis:
    def __init__(self, acquired=True, values=None):
        self.acquired = acquired
        self.values = values or {}
        self.calls = []

    def set(self, *args, **kwargs):
        self.calls.append(("set", args, kwargs))
        return self.acquired

    def eval(self, script, key_count, *args):
        self.calls.append(("eval", script, key_count, args))
        return 1

    def get(self, key):
        self.calls.append(("get", key))
        return self.values.get(key)


class FakeSequenceRedis(FakeRetryRedis):
    def __init__(self, results):
        super().__init__()
        self.results = iter(results)

    def eval(self, script, key_count, *args):
        self.calls.append(("eval", script, key_count, args))
        return next(self.results)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.executions = []

    def execute(self, sql, params):
        self.executions.append((sql, params))

    def fetchall(self):
        return self.rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class FakeConnection:
    def __init__(self, cursor):
        self.fake_cursor = cursor
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self):
        self.closed = True


class NotifyRuntimeTest(unittest.TestCase):
    TEST_PHONE_HASH = "ec61f3c620a98bdead8c1f1f0ae747abd1b62a0c2dba4fd4bc22cf0d1d8653e5"
    def test_d7_uses_the_exact_beijing_calendar_day_in_utc(self):
        start, end = utc_expiry_bounds(date(2026, 7, 29), days_before=7)

        self.assertEqual(start, datetime(2026, 8, 4, 16, 0))
        self.assertEqual(end, datetime(2026, 8, 5, 16, 0))

    def test_event_key_changes_when_the_expiry_changes(self):
        first = build_event_key("p-1", datetime(2026, 8, 5, 4, 0), "d7")
        second = build_event_key("p-1", datetime(2026, 9, 5, 4, 0), "d7")

        self.assertNotEqual(first, second)
        self.assertEqual(first, "pass:p-1:2026-08-05T04:00:00:d7")

    def test_enqueue_atomically_uses_dedupe_and_stream_keys(self):
        client = FakeRedis([1, "123-0"])
        payload = {"event_key": "pass:p-1:x:d7", "phone": "+8613800138000"}

        created, message_id = enqueue_notification(client, payload)

        self.assertTrue(created)
        self.assertEqual(message_id, "123-0")
        _, key_count, args = client.calls[0]
        self.assertEqual(key_count, 2)
        self.assertEqual(args[0], "lightvela:notify:v1:test:{notify-v1-test}:dedupe:pass:p-1:x:d7")
        self.assertEqual(args[1], "lightvela:notify:v1:test:{notify-v1-test}:stream")
        self.assertEqual(int(args[2]), DEDUPE_TTL_SECONDS)
        self.assertEqual(json.loads(args[3]), payload)
        self.assertNotIn("MAXLEN", client.calls[0][0])

    def test_duplicate_event_is_not_enqueued_again(self):
        client = FakeRedis([0, ""])

        created, message_id = enqueue_notification(client, {"event_key": "pass:p-1:x:d7"})

        self.assertFalse(created)
        self.assertEqual(message_id, "")

    def test_all_atomic_queue_keys_share_one_redis_cluster_hash_tag(self):
        for key in (STREAM_KEY, DEDUPE_PREFIX, STATE_PREFIX, RETRY_KEY):
            self.assertIn("{notify-v1-test}", key)

    def test_non_production_worker_only_accepts_the_configured_destination(self):
        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            self.assertEqual(destination_allowed("+8613800138000"), "+8613800138000")
            with self.assertRaisesRegex(RuntimeError, "allowlist"):
                destination_allowed("+8613900139000")

    def test_non_production_refuses_to_start_without_an_allowlist(self):
        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": ""}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "allowlist"):
                destination_allowed("+8613800138000")

    def test_non_production_scanner_does_not_enqueue_a_destination_outside_allowlist(self):
        row = {
            "pass_id": "p-1",
            "user_id": "u-1",
            "phone": "+8613900139000",
            "expired_time": datetime(2026, 8, 5, 4, 0),
        }

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "allowlist"):
                build_notification_payload(row, "d7", date(2026, 7, 29))

    def test_production_accepts_valid_cn_destinations_without_test_allowlist(self):
        with patch.dict(os.environ, {"NOTIFY_ENV": "shprod", "SMS_TEST_ALLOWLIST_SHA256": ""}, clear=False):
            self.assertEqual(destination_allowed("+8613800138000"), "+8613800138000")

    def test_normalizes_domestic_phone_for_tencent_sms(self):
        self.assertEqual(normalize_cn_phone("13800138000"), "+8613800138000")
        self.assertEqual(normalize_cn_phone("+8613800138000"), "+8613800138000")

    def test_promotes_due_retries_back_to_the_stream_atomically(self):
        client = FakeRetryRedis(["100-0", "101-0"])

        promoted = promote_due_retries(client, now=1234.5, limit=200)

        self.assertEqual(promoted, 2)
        _, script, key_count, args = client.calls[0]
        self.assertIn("ZRANGEBYSCORE", script)
        self.assertIn("XADD", script)
        self.assertEqual(key_count, 2)
        self.assertEqual(args[0], "lightvela:notify:v1:test:{notify-v1-test}:retry")
        self.assertEqual(args[1], "lightvela:notify:v1:test:{notify-v1-test}:stream")
        self.assertEqual(args[2], "1234.5")
        self.assertEqual(args[3], "200")
        self.assertNotIn("MAXLEN", script)

    def test_reads_stale_pending_messages_before_new_messages(self):
        client = FakeWorkerRedis()

        messages = read_worker_messages(client, "worker-test", count=200)

        self.assertEqual([message_id for message_id, _ in messages], ["1-0", "2-0"])
        self.assertEqual(client.calls[0][0], "xautoclaim")
        self.assertEqual(client.calls[1][0], "xreadgroup")

    def test_configures_d7_and_expiry_day_windows(self):
        with patch.dict(os.environ, {"EXPIRY_WINDOWS_DAYS": "7,0"}, clear=False):
            self.assertEqual(expiry_windows(), [7, 0])

    def test_rejects_expiry_windows_outside_product_scope(self):
        for configured in ("7", "0", "7,3,1,0", "0,7"):
            with self.subTest(configured=configured):
                with patch.dict(os.environ, {"EXPIRY_WINDOWS_DAYS": configured}, clear=False):
                    with self.assertRaisesRegex(ValueError, "exactly 7,0"):
                        expiry_windows()

    def test_environment_scopes_all_queue_keys_to_one_cluster_slot(self):
        keys = queue_keys("shprod")

        self.assertIn("{notify-v1-shprod}", keys.stream)
        self.assertIn("{notify-v1-shprod}", keys.retry)
        self.assertIn("{notify-v1-shprod}", keys.token_bucket)

    def test_success_and_failure_transitions_ack_in_the_same_lua_script(self):
        self.assertIn("XACK", COMPLETE_DELIVERY_LUA)
        self.assertIn("SETEX", COMPLETE_DELIVERY_LUA)
        self.assertIn("XACK", FAILURE_DELIVERY_LUA)
        self.assertIn("ZADD", FAILURE_DELIVERY_LUA)

    def test_token_bucket_uses_redis_time_and_atomic_state(self):
        self.assertIn("redis.call('TIME')", TOKEN_BUCKET_LUA)
        self.assertIn("HMSET", TOKEN_BUCKET_LUA)

    def test_sms_timeouts_are_unknown_and_never_automatically_retried(self):
        for code in ("InternalError.Timeout", "InternalError.SendAndRecvFail", "InternalError.UnknownError"):
            self.assertEqual(classify_sms_result(code), "unknown")

    def test_rate_limits_are_retryable_but_configuration_errors_are_terminal(self):
        self.assertEqual(classify_sms_result("LimitExceeded.DeliveryFrequencyLimit"), "retry")
        self.assertEqual(classify_sms_result("InternalError.OtherError"), "retry")
        self.assertEqual(classify_sms_result("InvalidParameterValue.IncorrectPhoneNumber"), "failed")
        self.assertEqual(classify_sms_result("FailedOperation.TemplateUnapprovedOrNotExist"), "failed")

    def test_expiry_scan_uses_expiry_and_id_keyset_pagination(self):
        cursor = FakeCursor([{"id": 42}])
        last_expired = datetime(2026, 8, 5, 3, 0)

        rows = fetch_expiring_page(cursor, date(2026, 7, 29), 7, last_expired, 41, 500)

        self.assertEqual(rows, [{"id": 42}])
        sql, params = cursor.executions[0]
        self.assertIn("p.expired_time > %s OR (p.expired_time = %s AND p.id > %s)", " ".join(sql.split()))
        self.assertIn("ORDER BY p.expired_time, p.id", sql)
        self.assertEqual(params[-4:], [last_expired, last_expired, 41, 500])

    def test_expiry_scan_cannot_be_silently_restricted_by_an_e2e_prefix(self):
        cursor = FakeCursor([])
        last_expired = datetime(2026, 8, 5, 0, 0)

        with patch.dict(os.environ, {"E2E_USER_PREFIX": "hidden-filter"}, clear=False):
            fetch_expiring_page(cursor, date(2026, 7, 29), 7, last_expired, 0, 500)

        sql, _ = cursor.executions[0]
        self.assertNotIn("LIKE", sql)

    def test_expiry_day_includes_active_isolating_and_isolated_passes(self):
        cursor = FakeCursor([])
        last_expired = datetime(2026, 7, 29, 0, 0)

        fetch_expiring_page(cursor, date(2026, 7, 29), 0, last_expired, 0, 500)

        sql, params = cursor.executions[0]
        self.assertIn("p.statusIN(%s,%s,%s)", "".join(sql.split()))
        self.assertEqual(params[:3], ["active", "isolating", "isolated"])

    def test_transport_exception_becomes_unknown_and_is_atomically_acked(self):
        client = FakeSequenceRedis([[1, '{"status":"sending"}'], 1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}

        def timeout_sender(phone, expiry_time, event_key):
            raise TimeoutError("request outcome is unknown")

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            with self.assertLogs(level="ERROR"):
                outcome = process_message(client, "1-0", fields, sender=timeout_sender, token_waiter=lambda client: None)

        self.assertEqual(outcome, "unknown")
        eval_call = next(call for call in client.calls if call[0] == "eval" and call[1] == FAILURE_DELIVERY_LUA)
        self.assertEqual(eval_call[1], FAILURE_DELIVERY_LUA)
        self.assertEqual(eval_call[3][3], "")
        self.assertEqual(json.loads(eval_call[3][6])["status"], "unknown")

    def test_delivery_is_marked_sending_before_calling_sms(self):
        client = FakeSequenceRedis([[1, '{"status":"sending"}'], 1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "pass_id": "p-1",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        response = SimpleNamespace(
            RequestId="request-1",
            SendStatusSet=[SimpleNamespace(Code="Ok", SerialNo="serial-1")],
        )

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            outcome = process_message(
                client,
                "1-0",
                fields,
                sender=lambda *args: response,
                token_waiter=lambda client: None,
                delivery_validator=lambda payload: (True, ""),
            )

        self.assertEqual(outcome, "sent")
        eval_calls = [call for call in client.calls if call[0] == "eval"]
        self.assertEqual(eval_calls[0][1], START_DELIVERY_LUA)
        self.assertEqual(eval_calls[1][1], COMPLETE_DELIVERY_LUA)

    def test_reclaimed_sending_delivery_becomes_unknown_without_resending(self):
        existing = json.dumps({"status": "sending", "attempt": 1, "lease_id": "old-message"})
        client = FakeSequenceRedis([[2, existing], 1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "pass_id": "p-1",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        sends = []

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            outcome = process_message(
                client,
                "1-0",
                fields,
                sender=lambda *args: sends.append(args),
                token_waiter=lambda client: None,
                delivery_validator=lambda payload: (True, ""),
            )

        self.assertEqual(outcome, "unknown")
        self.assertEqual(sends, [])
        eval_calls = [call for call in client.calls if call[0] == "eval"]
        self.assertEqual(eval_calls[0][1], START_DELIVERY_LUA)
        self.assertEqual(json.loads(eval_calls[1][3][6])["code"], "PreviousAttemptUncertain")

    def test_changed_pass_is_cancelled_before_sending(self):
        client = FakeRetryRedis([1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "pass_id": "p-1",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        sends = []

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            outcome = process_message(
                client,
                "1-0",
                fields,
                sender=lambda *args: sends.append(args),
                token_waiter=lambda client: None,
                delivery_validator=lambda payload: (False, "PassChanged"),
            )

        self.assertEqual(outcome, "cancelled")
        self.assertEqual(sends, [])
        eval_call = next(call for call in client.calls if call[0] == "eval")
        self.assertEqual(json.loads(eval_call[3][3])["status"], "cancelled")

    def test_d7_payload_allows_only_one_day_of_catchup(self):
        row = {
            "pass_id": "p-1",
            "user_id": "u-1",
            "phone": "+8613800138000",
            "expired_time": datetime(2026, 8, 5, 4, 0),
        }

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            payload = build_notification_payload(row, "d7", date(2026, 7, 29))

        self.assertEqual(payload["expected_expired_time"], "2026-08-05T04:00:00")
        self.assertEqual(payload["valid_until"], "2026-07-30T16:00:00")

    def test_expiry_day_payload_is_only_valid_on_the_scan_day(self):
        row = {
            "pass_id": "p-1",
            "user_id": "u-1",
            "phone": "+8613800138000",
            "expired_time": datetime(2026, 7, 29, 4, 0),
        }

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            payload = build_notification_payload(row, "d0", date(2026, 7, 29))

        self.assertEqual(payload["valid_until"], "2026-07-29T16:00:00")

    def test_validate_delivery_rejects_renewed_pass(self):
        connection = FakeConnection(FakeCursor([{
            "expired_time": datetime(2026, 9, 5, 4, 0),
            "status": "active",
        }]))
        payload = {
            "pass_id": "p-1",
            "window": "d7",
            "expected_expired_time": "2026-08-05T04:00:00",
            "valid_until": "2026-07-30T16:00:00",
        }

        current, reason = validate_delivery(payload=payload, connection=connection, now=datetime(2026, 7, 29, 9, 0))

        self.assertFalse(current)
        self.assertEqual(reason, "PassChanged")
        sql, params = connection.fake_cursor.executions[0]
        self.assertIn("WHERE pass_id = %s", sql)
        self.assertEqual(params, ["p-1"])

    def test_sdk_rate_limit_exception_is_retryable_but_unknown_transport_is_not(self):
        class SDKError(Exception):
            def __init__(self, code):
                super().__init__(code)
                self.code = code

            def get_code(self):
                return self.code

        self.assertEqual(classify_sms_exception(SDKError("RequestLimitExceeded")), ("retry", "RequestLimitExceeded"))
        self.assertEqual(classify_sms_exception(SDKError("InvalidParameterValue.IncorrectPhoneNumber")), ("failed", "InvalidParameterValue.IncorrectPhoneNumber"))
        self.assertEqual(classify_sms_exception(TimeoutError("timeout")), ("unknown", "TimeoutError"))

    def test_malformed_stream_payload_is_terminally_acked(self):
        client = FakeRetryRedis([1])

        with self.assertLogs(level="ERROR"):
            outcome = process_message(client, "1-0", {"payload": "not-json"})

        self.assertEqual(outcome, "invalid")
        eval_call = next(call for call in client.calls if call[0] == "eval")
        self.assertIn("XACK", eval_call[1])
        self.assertEqual(eval_call[3][-1], "1-0")

    def test_non_allowlisted_stream_destination_is_failed_without_sending(self):
        client = FakeRetryRedis([1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "phone": "+8613900139000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        sends = []

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            with self.assertLogs(level="ERROR"):
                outcome = process_message(
                    client,
                    "1-0",
                    fields,
                    sender=lambda *args: sends.append(args),
                    token_waiter=lambda client: None,
                )

        self.assertEqual(outcome, "failed")
        self.assertEqual(sends, [])
        eval_call = next(call for call in client.calls if call[0] == "eval")
        self.assertEqual(eval_call[1], FAILURE_DELIVERY_LUA)
        self.assertEqual(json.loads(eval_call[3][6])["code"], "DestinationBlocked")

    def test_transport_exception_log_does_not_contain_raw_event_key(self):
        client = FakeSequenceRedis([[1, '{"status":"sending"}'], 1])
        event_key = "pass:sensitive-pass-id:2026-08-05T04:00:00:d7"
        fields = {"payload": json.dumps({
            "event_key": event_key,
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            with self.assertLogs(level="ERROR") as captured:
                process_message(
                    client,
                    "1-0",
                    fields,
                    sender=lambda *args: (_ for _ in ()).throw(TimeoutError("timeout")),
                    token_waiter=lambda client: None,
                )

        self.assertNotIn(event_key, "\n".join(captured.output))

    def test_stale_pending_retry_wait_is_acked_without_sending_early(self):
        existing = json.dumps({"status": "retry_wait", "attempt": 1, "retry_at": 9999999999})
        client = FakeSequenceRedis([[0, existing], 1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        sends = []

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            outcome = process_message(
                client,
                "1-0",
                fields,
                sender=lambda *args: sends.append(args),
                token_waiter=lambda client: None,
            )

        self.assertEqual(outcome, "skipped")
        self.assertEqual(sends, [])
        eval_call = next(call for call in client.calls if call[0] == "eval" and call[1] == COMPLETE_DELIVERY_LUA)
        self.assertEqual(eval_call[1], COMPLETE_DELIVERY_LUA)

    def test_success_is_recorded_and_acked_by_one_lua_call(self):
        client = FakeSequenceRedis([[1, '{"status":"sending"}'], 1])
        fields = {"payload": json.dumps({
            "event_key": "pass:p-1:x:d7",
            "phone": "+8613800138000",
            "expiry_time": "2026-08-05 12:00",
            "attempt": 0,
        })}
        response = SimpleNamespace(
            RequestId="request-1",
            SendStatusSet=[SimpleNamespace(Code="Ok", SerialNo="serial-1")],
        )
        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SMS_TEST_ALLOWLIST_SHA256": self.TEST_PHONE_HASH}, clear=False):
            outcome = process_message(client, "1-0", fields, sender=lambda *args: response, token_waiter=lambda client: None)

        self.assertEqual(outcome, "sent")
        eval_call = next(call for call in client.calls if call[0] == "eval" and call[1] == COMPLETE_DELIVERY_LUA)
        self.assertEqual(eval_call[1], COMPLETE_DELIVERY_LUA)
        self.assertEqual(json.loads(eval_call[3][3])["status"], "sent")

    def test_fifth_retry_is_terminal_and_not_returned_to_retry_zset(self):
        client = FakeRetryRedis([1])
        payload = {"event_key": "pass:p-1:x:d7", "attempt": 4}

        outcome = transition_failure(client, "1-0", payload, "retry", code="LimitExceeded.DeliveryFrequencyLimit")

        self.assertEqual(outcome, "failed")
        eval_call = next(call for call in client.calls if call[0] == "eval")
        self.assertEqual(eval_call[3][3], "")
        self.assertEqual(json.loads(eval_call[3][6])["status"], "failed")

    def test_token_bucket_waits_for_redis_computed_delay(self):
        client = FakeSequenceRedis([100, 0])
        sleeps = []

        wait_for_sms_token(client, sleeper=sleeps.append)

        self.assertEqual(sleeps, [0.1])

    def test_scanner_lock_is_owned_by_a_random_token_and_released_atomically(self):
        client = FakeLockRedis()

        token = acquire_scan_lock(client)
        released = release_scan_lock(client, token)

        self.assertTrue(token)
        set_call = client.calls[0]
        self.assertEqual(set_call[0], "set")
        self.assertTrue(set_call[2]["nx"])
        self.assertGreaterEqual(set_call[2]["ex"], 900)
        eval_call = client.calls[1]
        self.assertEqual(eval_call[0], "eval")
        self.assertIn("redis.call('GET'", eval_call[1])

    def test_scanner_watermark_catches_up_dates_missed_since_last_success(self):
        key = queue_keys("beijing-sandbox").scan_watermark
        client = FakeLockRedis(values={key: "2026-07-27"})

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox"}, clear=False):
            dates = pending_scan_dates(client, date(2026, 7, 29))

        self.assertEqual(dates, [date(2026, 7, 28), date(2026, 7, 29)])

    def test_scanner_without_watermark_only_scans_today(self):
        client = FakeLockRedis()

        dates = pending_scan_dates(client, date(2026, 7, 29))

        self.assertEqual(dates, [date(2026, 7, 29)])

    def test_scanner_catchup_is_bounded(self):
        key = queue_keys("beijing-sandbox").scan_watermark
        client = FakeLockRedis(values={key: "2026-07-01"})

        with patch.dict(os.environ, {"NOTIFY_ENV": "beijing-sandbox", "SCANNER_MAX_CATCHUP_DAYS": "7"}, clear=False):
            dates = pending_scan_dates(client, date(2026, 7, 29))

        self.assertEqual(dates[0], date(2026, 7, 23))
        self.assertEqual(dates[-1], date(2026, 7, 29))
        self.assertEqual(len(dates), 7)

    def test_scanner_dry_run_counts_without_enqueueing_or_advancing_watermark(self):
        client = FakeLockRedis()
        connection = FakeConnection(FakeCursor([]))
        row = {
            "id": 1,
            "pass_id": "p-1",
            "user_id": "u-1",
            "phone": "+8613900139000",
            "expired_time": datetime(2026, 8, 5, 4, 0),
        }
        pages = iter([[row], []])

        with patch("app.redis_client", return_value=client), \
             patch("app.db_connection", return_value=connection), \
             patch("app.expiry_windows", return_value=[7]), \
             patch("app.fetch_expiring_page", side_effect=lambda *args: next(pages)), \
             patch("app.enqueue_notification") as enqueue, \
             patch("app.mark_scan_date") as mark_watermark:
            result = scanner_handler({"dry_run": True, "date": "2026-07-29"}, None)

        self.assertEqual(result["dry_run"], 1)
        self.assertEqual(result["enqueued"], 0)
        enqueue.assert_not_called()
        mark_watermark.assert_not_called()
        self.assertTrue(connection.closed)


if __name__ == "__main__":
    unittest.main()
