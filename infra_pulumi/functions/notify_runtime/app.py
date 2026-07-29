import json
import hashlib
import logging
import os
import re
import time as time_module
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo


BEIJING = ZoneInfo("Asia/Shanghai")
UTC = timezone.utc
CURRENT_SECRET_VERSION = "SSM_Current"
DEFAULT_ENVIRONMENT = "test"
DEDUPE_TTL_SECONDS = 60 * 24 * 60 * 60
MAX_ATTEMPTS = 5
RECLAIM_IDLE_MILLISECONDS = 5 * 60 * 1000
SMS_TEMPLATE_ID = "2699772"
LOG = logging.getLogger()
LOG.setLevel(logging.INFO)


@dataclass(frozen=True)
class QueueKeys:
    stream: str
    group: str
    dedupe_prefix: str
    state_prefix: str
    retry: str
    token_bucket: str
    scan_lock: str
    scan_watermark: str


def queue_keys(environment=None):
    value = environment or os.environ.get("NOTIFY_ENV", DEFAULT_ENVIRONMENT)
    if not re.fullmatch(r"[a-z0-9-]+", value):
        raise ValueError("NOTIFY_ENV must contain only lowercase letters, numbers, and hyphens")
    hash_tag = f"{{notify-v1-{value}}}"
    prefix = f"lightvela:notify:v1:{value}:{hash_tag}"
    return QueueKeys(
        stream=f"{prefix}:stream",
        group=f"lightvela_notify_v1_{value}_worker",
        dedupe_prefix=f"{prefix}:dedupe:",
        state_prefix=f"{prefix}:state:",
        retry=f"{prefix}:retry",
        token_bucket=f"{prefix}:sms-token-bucket",
        scan_lock=f"{prefix}:scanner-lock",
        scan_watermark=f"{prefix}:scanner-watermark",
    )


_DEFAULT_KEYS = queue_keys(DEFAULT_ENVIRONMENT)
STREAM_KEY = _DEFAULT_KEYS.stream
GROUP_NAME = _DEFAULT_KEYS.group
DEDUPE_PREFIX = _DEFAULT_KEYS.dedupe_prefix
STATE_PREFIX = _DEFAULT_KEYS.state_prefix
RETRY_KEY = _DEFAULT_KEYS.retry

ENQUEUE_LUA = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  local id = redis.call('XADD', KEYS[2], '*', 'payload', ARGV[2])
  redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
  return {1, id}
end
return {0, ''}
"""

PROMOTE_RETRIES_LUA = """
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local ids = {}
for _, payload in ipairs(items) do
  local id = redis.call('XADD', KEYS[2], '*', 'payload', payload)
  if redis.call('ZREM', KEYS[1], payload) == 1 then
    table.insert(ids, id)
  end
end
return ids
"""

START_DELIVERY_LUA = """
local current = redis.call('GET', KEYS[1])
if current then
  local ok, state = pcall(cjson.decode, current)
  if ok then
    if state.status == 'sent' or state.status == 'failed' or state.status == 'unknown' or state.status == 'cancelled' then
      return {0, current}
    end
    if state.status == 'sending' then
      return {2, current}
    end
    if state.status == 'retry_wait' and tonumber(state.attempt or 0) > tonumber(ARGV[2]) then
      return {0, current}
    end
  end
end
local now = redis.call('TIME')
local state = cjson.encode({
  status = 'sending',
  attempt = tonumber(ARGV[2]) + 1,
  started_at = tonumber(now[1]),
  lease_id = ARGV[3]
})
redis.call('SETEX', KEYS[1], ARGV[1], state)
return {1, state}
"""

COMPLETE_DELIVERY_LUA = """
redis.call('SETEX', KEYS[1], ARGV[1], ARGV[2])
local acked = redis.call('XACK', KEYS[2], ARGV[3], ARGV[4])
if ARGV[5] == '1' then
  redis.call('XDEL', KEYS[2], ARGV[4])
end
return acked
"""

FAILURE_DELIVERY_LUA = """
if ARGV[1] ~= '' then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
end
redis.call('SETEX', KEYS[2], ARGV[3], ARGV[4])
local acked = redis.call('XACK', KEYS[3], ARGV[5], ARGV[6])
if ARGV[7] == '1' then
  redis.call('XDEL', KEYS[3], ARGV[6])
end
return acked
"""

DISCARD_MESSAGE_LUA = """
local acked = redis.call('XACK', KEYS[1], ARGV[1], ARGV[3])
if ARGV[2] == '1' then
  redis.call('XDEL', KEYS[1], ARGV[3])
end
return acked
"""

TOKEN_BUCKET_LUA = """
local now = redis.call('TIME')
local now_ms = (now[1] * 1000) + math.floor(now[2] / 1000)
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local values = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens = tonumber(values[1]) or capacity
local updated_ms = tonumber(values[2]) or now_ms
tokens = math.min(capacity, tokens + ((now_ms - updated_ms) * rate / 1000))
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated_ms', now_ms)
  redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 2000))
  return 0
end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated_ms', now_ms)
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 2000))
return math.ceil((1 - tokens) * 1000 / rate)
"""

RELEASE_LOCK_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def expiry_windows():
    raw = os.environ.get("EXPIRY_WINDOWS_DAYS", "7,0")
    windows = [int(value.strip()) for value in raw.split(",") if value.strip()]
    if windows != [7, 0]:
        raise ValueError("EXPIRY_WINDOWS_DAYS must be exactly 7,0")
    return windows


def utc_expiry_bounds(today, days_before):
    target = today + timedelta(days=days_before)
    local_start = datetime.combine(target, time.min, tzinfo=BEIJING)
    return (
        local_start.astimezone(UTC).replace(tzinfo=None),
        (local_start + timedelta(days=1)).astimezone(UTC).replace(tzinfo=None),
    )


def build_event_key(pass_id, expired_time, window):
    return f"pass:{pass_id}:{expired_time.isoformat()}:{window}"


def event_reference(event_key):
    return hashlib.sha256(event_key.encode("utf-8")).hexdigest()[:16]


def build_notification_payload(row, window, scan_date):
    event_key = build_event_key(row["pass_id"], row["expired_time"], window)
    local_expiry = row["expired_time"].replace(tzinfo=UTC).astimezone(BEIJING)
    grace_days = 2 if window == "d7" else 1
    local_valid_until = datetime.combine(scan_date + timedelta(days=grace_days), time.min, tzinfo=BEIJING)
    return {
        "event_key": event_key,
        "pass_id": row["pass_id"],
        "user_id": row["user_id"],
        "phone": destination_allowed(row["phone"]),
        "window": window,
        "scan_date": scan_date.isoformat(),
        "expected_expired_time": row["expired_time"].isoformat(),
        "valid_until": local_valid_until.astimezone(UTC).replace(tzinfo=None).isoformat(),
        "expiry_time": local_expiry.strftime("%Y-%m-%d %H:%M"),
        "attempt": 0,
    }


def acquire_scan_lock(client):
    ttl = int(os.environ.get("SCANNER_LOCK_TTL_SECONDS", "900"))
    if ttl < 900:
        raise ValueError("SCANNER_LOCK_TTL_SECONDS must be at least 900")
    token = uuid.uuid4().hex
    return token if client.set(queue_keys().scan_lock, token, nx=True, ex=ttl) else ""


def release_scan_lock(client, token):
    if not token:
        return 0
    return client.eval(RELEASE_LOCK_LUA, 1, queue_keys().scan_lock, token)


def pending_scan_dates(client, today, explicit_date=None):
    if explicit_date is not None:
        return [explicit_date]
    max_catchup = int(os.environ.get("SCANNER_MAX_CATCHUP_DAYS", "7"))
    if not 1 <= max_catchup <= 31:
        raise ValueError("SCANNER_MAX_CATCHUP_DAYS must be between 1 and 31")
    raw = client.get(queue_keys().scan_watermark)
    if not raw:
        return [today]
    watermark = date.fromisoformat(raw.decode() if isinstance(raw, bytes) else raw)
    if watermark >= today:
        return []
    first = max(watermark + timedelta(days=1), today - timedelta(days=max_catchup - 1))
    return [first + timedelta(days=offset) for offset in range((today - first).days + 1)]


def mark_scan_date(client, scan_date):
    client.set(queue_keys().scan_watermark, scan_date.isoformat())


def enqueue_notification(client, payload):
    keys = queue_keys()
    event_key = payload["event_key"]
    result = client.eval(
        ENQUEUE_LUA,
        2,
        f"{keys.dedupe_prefix}{event_key}",
        keys.stream,
        DEDUPE_TTL_SECONDS,
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True),
    )
    message_id = result[1].decode() if isinstance(result[1], bytes) else str(result[1])
    return int(result[0]) == 1, message_id


def promote_due_retries(client, now=None, limit=200):
    keys = queue_keys()
    result = client.eval(
        PROMOTE_RETRIES_LUA,
        2,
        keys.retry,
        keys.stream,
        str(now if now is not None else time_module.time()),
        str(limit),
    )
    return len(result)


def read_worker_messages(client, consumer_name, count=200):
    keys = queue_keys()
    claimed = client.xautoclaim(
        keys.stream,
        keys.group,
        consumer_name,
        min_idle_time=RECLAIM_IDLE_MILLISECONDS,
        start_id="0-0",
        count=count,
    )
    messages = list(claimed[1] if claimed else [])
    remaining = max(0, count - len(messages))
    if remaining:
        records = client.xreadgroup(
            keys.group,
            consumer_name,
            {keys.stream: ">"},
            count=remaining,
            block=1000,
        )
        for _, stream_messages in records:
            messages.extend(stream_messages)
    return messages


def retry_delay_seconds(attempt):
    return min(3600, 60 * (2 ** max(0, attempt - 1)))


def normalize_cn_phone(phone):
    value = str(phone or "").strip()
    if re.fullmatch(r"1\d{10}", value):
        return "+86" + value
    if re.fullmatch(r"\+861\d{10}", value):
        return value
    raise ValueError("unsupported phone format")


def destination_allowed(phone):
    normalized = normalize_cn_phone(phone)
    environment = os.environ.get("NOTIFY_ENV", DEFAULT_ENVIRONMENT)
    configured = {item.strip().lower() for item in os.environ.get("SMS_TEST_ALLOWLIST_SHA256", "").split(",") if item.strip()}
    if environment != "shprod":
        if any(not re.fullmatch(r"[0-9a-f]{64}", item) for item in configured):
            raise RuntimeError("SMS test allowlist contains an invalid SHA-256 digest")
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        if not configured or digest not in configured:
            raise RuntimeError("destination is outside the approved SMS test allowlist")
    return normalized


def validate_test_destination(phone):
    return destination_allowed(phone)


def classify_sms_result(code):
    if code == "Ok":
        return "sent"
    if code in {"InternalError.Timeout", "InternalError.SendAndRecvFail", "InternalError.UnknownError"}:
        return "unknown"
    if code.startswith("LimitExceeded.") or code.startswith("InternalError.") or code == "RequestLimitExceeded":
        return "retry"
    return "failed"


def classify_sms_exception(exc):
    get_code = getattr(exc, "get_code", None)
    code = get_code() if callable(get_code) else type(exc).__name__
    code = code or type(exc).__name__
    if code == "RequestLimitExceeded" or code.startswith("LimitExceeded."):
        return "retry", code
    terminal_prefixes = (
        "AuthFailure.",
        "FailedOperation.Signature",
        "FailedOperation.Template",
        "InvalidParameter",
        "UnauthorizedOperation",
    )
    if code.startswith(terminal_prefixes):
        return "failed", code
    return "unknown", code


def runtime_credential():
    from tencentcloud.common import credential

    values = [os.environ.get("TENCENTCLOUD_SECRETID"), os.environ.get("TENCENTCLOUD_SECRETKEY"), os.environ.get("TENCENTCLOUD_SESSIONTOKEN")]
    if not all(values):
        raise RuntimeError("SCF runtime role credentials are unavailable")
    return credential.Credential(*values)


def load_secret(name):
    from tencentcloud.ssm.v20190923 import models, ssm_client

    client = ssm_client.SsmClient(runtime_credential(), os.environ.get("SSM_REGION", "ap-beijing"))
    request = models.GetSecretValueRequest()
    request.SecretName = name
    request.VersionId = CURRENT_SECRET_VERSION
    return json.loads(client.GetSecretValue(request).SecretString)


def redis_client():
    import redis

    secret = load_secret(os.environ["REDIS_SECRET_NAME"])
    return redis.Redis(host=os.environ["REDIS_HOST"], port=int(os.environ.get("REDIS_PORT", "6379")), password=secret["password"], socket_connect_timeout=5, socket_timeout=5, decode_responses=True)


def db_connection():
    import pymysql

    secret = load_secret(os.environ["DB_SECRET_NAME"])
    return pymysql.connect(host=os.environ["DB_HOST"], port=int(os.environ.get("DB_PORT", "3306")), user=secret.get("user") or os.environ["DB_USER"], password=secret["password"], database="ctl", connect_timeout=5, read_timeout=10, write_timeout=10, autocommit=True, cursorclass=pymysql.cursors.DictCursor)


def fetch_expiring_page(cursor, today, days_before, last_expired, last_id, page_size):
    start, end = utc_expiry_bounds(today, days_before)
    statuses = ["active"] if days_before > 0 else ["active", "isolating", "isolated"]
    placeholders = ",".join(["%s"] * len(statuses))
    sql = f"""
        SELECT p.id, p.pass_id, p.user_id, p.expired_time, u.phone
        FROM ctl.pass AS p
        JOIN lightclaw_auth.users AS u ON u.id = p.user_id
        WHERE p.status IN ({placeholders}) AND p.expired_time >= %s AND p.expired_time < %s
          AND u.phone IS NOT NULL AND u.phone <> ''
          AND (p.expired_time > %s OR (p.expired_time = %s AND p.id > %s))
    """
    params = [*statuses, start, end, last_expired, last_expired, last_id]
    sql += " ORDER BY p.expired_time, p.id LIMIT %s"
    params.append(page_size)
    cursor.execute(sql, params)
    return cursor.fetchall()


def scanner_handler(event, context):
    raw_date = (event or {}).get("date")
    explicit_date = date.fromisoformat(raw_date) if raw_date else None
    dry_run = (event or {}).get("dry_run") is True
    today = datetime.now(BEIJING).date()
    client = redis_client()
    lock_token = acquire_scan_lock(client)
    if not lock_token:
        LOG.info("notify_scan skipped=lock_busy date=%s", today.isoformat())
        return {"skipped": "lock_busy"}
    page_size = int(os.environ.get("SCAN_PAGE_SIZE", "500"))
    if not 1 <= page_size <= 1000:
        raise ValueError("SCAN_PAGE_SIZE must be between 1 and 1000")
    totals = {"scanned": 0, "dry_run": 0, "enqueued": 0, "duplicate": 0, "invalid_contact": 0}
    date_totals = {}
    connection = None
    try:
        connection = db_connection()
        with connection.cursor() as cursor:
            scan_dates = pending_scan_dates(client, today, explicit_date)
            for scan_date in scan_dates:
                window_totals = {}
                for days_before in expiry_windows():
                    start, _ = utc_expiry_bounds(scan_date, days_before)
                    last_expired, last_id = start, 0
                    window = f"d{days_before}"
                    counts = {"scanned": 0, "dry_run": 0, "enqueued": 0, "duplicate": 0, "invalid_contact": 0}
                    while True:
                        rows = fetch_expiring_page(cursor, scan_date, days_before, last_expired, last_id, page_size)
                        if not rows:
                            break
                        for row in rows:
                            counts["scanned"] += 1
                            totals["scanned"] += 1
                            if dry_run:
                                counts["dry_run"] += 1
                                totals["dry_run"] += 1
                                continue
                            try:
                                payload = build_notification_payload(row, window, scan_date)
                            except (ValueError, RuntimeError):
                                counts["invalid_contact"] += 1
                                totals["invalid_contact"] += 1
                                LOG.warning("notify_scan invalid_phone event_window=%s user_id_hash=%s", window, uuid.uuid5(uuid.NAMESPACE_OID, row["user_id"]).hex[:12])
                                continue
                            created, _ = enqueue_notification(client, payload)
                            outcome = "enqueued" if created else "duplicate"
                            counts[outcome] += 1
                            totals[outcome] += 1
                        last_expired, last_id = rows[-1]["expired_time"], rows[-1]["id"]
                        if len(rows) < page_size:
                            break
                    window_totals[window] = counts
                date_totals[scan_date.isoformat()] = window_totals
                if explicit_date is None and not dry_run:
                    mark_scan_date(client, scan_date)
    finally:
        if connection is not None:
            connection.close()
        release_scan_lock(client, lock_token)
    result = {**totals, "dates": date_totals}
    LOG.info("notify_scan result=%s", json.dumps(result, separators=(",", ":")))
    return result


def send_sms(phone, expiry_time, event_key):
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.sms.v20210111 import models, sms_client

    profile = ClientProfile()
    profile.httpProfile = HttpProfile(endpoint=os.environ.get("SMS_ENDPOINT", "sms.internal.tencentcloudapi.com"))
    client = sms_client.SmsClient(runtime_credential(), os.environ.get("SMS_REGION", "ap-guangzhou"), profile)
    request = models.SendSmsRequest()
    request.from_json_string(json.dumps({
        "SmsSdkAppId": os.environ["SMS_SDK_APP_ID"],
        "SignName": os.environ.get("SMS_SIGN_NAME", "\u817e\u8baf\u4e91"),
        "TemplateId": os.environ.get("SMS_TEMPLATE_ID", SMS_TEMPLATE_ID),
        "TemplateParamSet": [expiry_time],
        "PhoneNumberSet": [phone],
        "SessionContext": event_reference(event_key),
    }))
    return client.SendSms(request)


def ensure_group(client):
    keys = queue_keys()
    try:
        client.xgroup_create(keys.stream, keys.group, id="0-0", mkstream=True)
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def delete_acked_messages():
    return os.environ.get("DELETE_ACKED_MESSAGES", "true").lower() == "true"


def begin_delivery(client, message_id, payload):
    keys = queue_keys()
    result = client.eval(
        START_DELIVERY_LUA,
        1,
        f"{keys.state_prefix}{payload['event_key']}",
        DEDUPE_TTL_SECONDS,
        int(payload.get("attempt", 0)),
        message_id,
    )
    raw_state = result[1].decode() if isinstance(result[1], bytes) else result[1]
    return int(result[0]), json.loads(raw_state)


def complete_delivery(client, message_id, payload, state):
    keys = queue_keys()
    state_json = json.dumps(state, separators=(",", ":"), ensure_ascii=True)
    return client.eval(
        COMPLETE_DELIVERY_LUA,
        2,
        f"{keys.state_prefix}{payload['event_key']}",
        keys.stream,
        DEDUPE_TTL_SECONDS,
        state_json,
        keys.group,
        message_id,
        "1" if delete_acked_messages() else "0",
    )


def discard_message(client, message_id):
    keys = queue_keys()
    return client.eval(
        DISCARD_MESSAGE_LUA,
        1,
        keys.stream,
        keys.group,
        "1" if delete_acked_messages() else "0",
        message_id,
    )


def transition_failure(client, message_id, payload, outcome, request_id="", code=""):
    keys = queue_keys()
    next_attempt = int(payload.get("attempt", 0)) + 1
    retry_payload = ""
    retry_at = 0
    final_outcome = outcome
    if outcome == "retry" and next_attempt < MAX_ATTEMPTS:
        final_outcome = "retry_wait"
        retry_at = time_module.time() + retry_delay_seconds(next_attempt)
        retry_payload = json.dumps({**payload, "attempt": next_attempt}, separators=(",", ":"), ensure_ascii=True)
    elif outcome == "retry":
        final_outcome = "failed"
    state = {
        "status": final_outcome,
        "attempt": next_attempt,
        "request_id": request_id,
        "code": code,
    }
    if retry_at:
        state["retry_at"] = retry_at
    client.eval(
        FAILURE_DELIVERY_LUA,
        3,
        keys.retry,
        f"{keys.state_prefix}{payload['event_key']}",
        keys.stream,
        retry_payload,
        retry_at,
        DEDUPE_TTL_SECONDS,
        json.dumps(state, separators=(",", ":"), ensure_ascii=True),
        keys.group,
        message_id,
        "1" if delete_acked_messages() else "0",
    )
    return final_outcome


def wait_for_sms_token(client, sleeper=time_module.sleep):
    keys = queue_keys()
    rate = float(os.environ.get("SMS_QPS", "15"))
    capacity = float(os.environ.get("SMS_BURST", "15"))
    if rate <= 0 or capacity < 1:
        raise ValueError("SMS_QPS must be positive and SMS_BURST must be at least 1")
    while True:
        wait_ms = int(client.eval(TOKEN_BUCKET_LUA, 1, keys.token_bucket, rate, capacity))
        if wait_ms <= 0:
            return
        sleeper(wait_ms / 1000)


def validate_delivery(connection, payload, now=None):
    now = now or datetime.now(UTC).replace(tzinfo=None)
    valid_until = datetime.fromisoformat(payload["valid_until"])
    if now >= valid_until:
        return False, "NotificationExpired"
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT expired_time, status FROM ctl.pass WHERE pass_id = %s LIMIT 1",
            [payload["pass_id"]],
        )
        rows = cursor.fetchall()
    if not rows:
        return False, "PassNotFound"
    row = rows[0]
    expected = datetime.fromisoformat(payload["expected_expired_time"])
    if row["expired_time"] != expected:
        return False, "PassChanged"
    allowed_statuses = {"active"} if payload["window"] == "d7" else {"active", "isolating", "isolated"}
    if row["status"] not in allowed_statuses:
        return False, "PassStatusChanged"
    return True, ""


def process_message(client, message_id, fields, sender=send_sms, token_waiter=wait_for_sms_token, delivery_validator=None):
    try:
        payload = json.loads(fields["payload"])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        LOG.error("notify_sms invalid_payload message_id=%s error_type=%s", message_id, type(exc).__name__)
        discard_message(client, message_id)
        return "invalid"
    if not isinstance(payload, dict) or not isinstance(payload.get("event_key"), str) or not payload["event_key"]:
        LOG.error("notify_sms invalid_payload message_id=%s error_type=MissingEventKey", message_id)
        discard_message(client, message_id)
        return "invalid"
    if not isinstance(payload.get("phone"), str) or not isinstance(payload.get("expiry_time"), str):
        LOG.error("notify_sms invalid_payload event_ref=%s error_type=MissingRequiredField", event_reference(payload["event_key"]))
        return transition_failure(client, message_id, payload, "failed", code="InvalidPayload")
    try:
        phone = destination_allowed(payload["phone"])
    except (ValueError, RuntimeError) as exc:
        LOG.error("notify_sms blocked_destination event_ref=%s error_type=%s", event_reference(payload["event_key"]), type(exc).__name__)
        return transition_failure(client, message_id, payload, "failed", code="DestinationBlocked")
    if delivery_validator is not None:
        try:
            current, reason = delivery_validator(payload)
        except Exception as exc:
            LOG.exception("notify_sms validation_retry event_ref=%s error_type=%s", event_reference(payload["event_key"]), type(exc).__name__)
            return transition_failure(client, message_id, payload, "retry", code="PassValidationError")
        if not current:
            complete_delivery(client, message_id, payload, {
                "status": "cancelled",
                "attempt": int(payload.get("attempt", 0)),
                "code": reason,
            })
            return "cancelled"
    token_waiter(client)
    start_result, existing = begin_delivery(client, message_id, payload)
    if start_result == 0:
        complete_delivery(client, message_id, payload, existing)
        return "skipped"
    if start_result == 2:
        return transition_failure(client, message_id, payload, "unknown", code="PreviousAttemptUncertain")
    try:
        response = sender(phone, payload["expiry_time"], payload["event_key"])
    except Exception as exc:
        outcome, code = classify_sms_exception(exc)
        LOG.exception("notify_sms send_error event_ref=%s outcome=%s error_type=%s", event_reference(payload["event_key"]), outcome, type(exc).__name__)
        return transition_failure(client, message_id, payload, outcome, code=code)
    statuses = response.SendStatusSet or []
    if len(statuses) != 1:
        return transition_failure(client, message_id, payload, "unknown", request_id=response.RequestId, code="MalformedSendStatusSet")
    status = statuses[0]
    outcome = classify_sms_result(status.Code)
    if outcome == "sent":
        complete_delivery(client, message_id, payload, {
            "status": "sent",
            "attempt": int(payload.get("attempt", 0)) + 1,
            "request_id": response.RequestId,
            "serial_no": status.SerialNo,
            "code": status.Code,
        })
        return "sent"
    return transition_failure(client, message_id, payload, outcome, request_id=response.RequestId, code=status.Code)


def worker_handler(event, context):
    client = redis_client()
    ensure_group(client)
    connection = db_connection()
    deadline = time_module.monotonic() + int(os.environ.get("WORKER_MAX_RUNTIME_SECONDS", "840"))
    max_messages = int(os.environ.get("WORKER_MAX_MESSAGES", "10000"))
    batch_size = int(os.environ.get("WORKER_BATCH_SIZE", "200"))
    if not 1 <= batch_size <= 200 or max_messages < 1:
        raise ValueError("WORKER_BATCH_SIZE must be 1..200 and WORKER_MAX_MESSAGES must be positive")
    consumer = f"worker-{uuid.uuid4().hex[:12]}"
    totals = {"promoted": 0, "sent": 0, "retry_wait": 0, "failed": 0, "unknown": 0, "cancelled": 0, "skipped": 0, "invalid": 0}
    processed = 0
    try:
        while time_module.monotonic() < deadline - 5 and processed < max_messages:
            totals["promoted"] += promote_due_retries(client, limit=batch_size)
            messages = read_worker_messages(client, consumer, count=min(batch_size, max_messages - processed))
            if not messages:
                break
            for message_id, fields in messages:
                outcome = process_message(
                    client,
                    message_id,
                    fields,
                    delivery_validator=lambda payload: validate_delivery(connection, payload),
                )
                totals[outcome] += 1
                processed += 1
                if processed >= max_messages or time_module.monotonic() >= deadline - 5:
                    break
    finally:
        connection.close()
    totals["processed"] = processed
    LOG.info("notify_worker result=%s", json.dumps(totals, separators=(",", ":")))
    return totals
