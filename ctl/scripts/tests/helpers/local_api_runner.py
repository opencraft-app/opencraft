#!/usr/bin/env python3
"""Shared local ctl API walkthrough runner.

脚本定义:
  提供本地 ctl API 走查的公共能力，包含 HTTP 请求、异步状态轮询、
  sandbox 联通性预检、实例清理和步骤级结果汇总。

参数定义:
  由 smoke/regression 两个入口脚本负责解析，本模块只定义共享运行时配置。

输出结果定义:
  - stdout: 步骤级 PASS/SKIP 日志和最终摘要
  - stderr: 失败步骤、HTTP 状态码、响应体和异常上下文
  - 返回值: 0 表示全部通过；非 0 表示至少一项失败
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import tomllib

from testenv_runtime import (
    DEFAULT_TEST_USER_ID,
    create_operation_error,
    latest_create_operation,
    resolve_test_user_id,
)


DEFAULT_BASE_URL = "http://127.0.0.1:9590"
DEFAULT_USER_ID = DEFAULT_TEST_USER_ID
# Keep the walkthrough default aligned with the current test environment's
# primary ctl template instead of the sandbox-side bj8 fallback pool.
DEFAULT_TEMPLATE_ID = "pool-c3"
DEFAULT_CONF_DIR = "ctl/conf/local"
DEFAULT_CREATE_TIMEOUT = 3600
DEFAULT_RESUME_TIMEOUT = 1800
DEFAULT_SET_TIMEOUT = 1200
DEFAULT_QUOTA_PROBE_LIMIT = 10
DEFAULT_WAIT_TIMEOUT_SECONDS = 90
DEFAULT_WAIT_INTERVAL_SECONDS = 2
DEFAULT_WEIXIN_WAIT_TIMEOUT_SECONDS = 30


class StepFailure(RuntimeError):
    """Raised when a walkthrough step fails."""


@dataclass
class RunnerConfig:
    mode: str
    base_url: str = DEFAULT_BASE_URL
    user_id: str = DEFAULT_USER_ID
    template_id: str = DEFAULT_TEMPLATE_ID
    conf_dir: str = DEFAULT_CONF_DIR
    create_timeout: int = DEFAULT_CREATE_TIMEOUT
    resume_timeout: int = DEFAULT_RESUME_TIMEOUT
    set_timeout: int = DEFAULT_SET_TIMEOUT
    quota_probe_limit: int = DEFAULT_QUOTA_PROBE_LIMIT
    request_id: str = ""
    keep_instance: bool = False
    wait_timeout_seconds: int = DEFAULT_WAIT_TIMEOUT_SECONDS
    wait_interval_seconds: int = DEFAULT_WAIT_INTERVAL_SECONDS
    http_timeout_seconds: int = 30
    verify_weixin_login: bool = False
    weixin_wait_timeout_seconds: int = DEFAULT_WEIXIN_WAIT_TIMEOUT_SECONDS
    verify_operations: bool = False
    verify_logs: bool = False
    verify_quota_exhausted: bool = True
    skip_template_config_check: bool = False
    skip_sandbox_connectivity_check: bool = False
    verify_create_operation_success: bool = False


@dataclass
class HTTPResult:
    status_code: int
    body_text: str
    data: Any


@dataclass
class LocalAPIRunner:
    cfg: RunnerConfig
    passed_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    active_instance_id: str = ""
    active_weixin_session_id: str = ""
    created_instance_ids: list[str] = field(default_factory=list)
    last_response: HTTPResult | None = None
    _request_seq: int = 0

    def log_info(self, message: str) -> None:
        print(f"INFO: {message}")

    def log_error(self, message: str) -> None:
        print(f"ERROR: {message}", file=sys.stderr)

    def record_pass(self, name: str) -> None:
        self.passed_count += 1
        self.log_info(f"[PASS] {name}")

    def record_fail(self, name: str, message: str) -> None:
        self.failed_count += 1
        self.log_error(f"[FAIL] {name}: {message}")
        if self.last_response is not None:
            self.log_error(
                f"http_status={self.last_response.status_code} body={self.last_response.body_text}"
            )

    def record_skip(self, name: str, message: str) -> None:
        self.skipped_count += 1
        self.log_info(f"[SKIP] {name}: {message}")

    def print_summary(self) -> None:
        print()
        print(
            f"{self.passed_count} passed / {self.failed_count} failed / {self.skipped_count} skipped"
        )

    def next_request_id(self) -> str:
        if self.cfg.request_id:
            return self.cfg.request_id
        self._request_seq += 1
        return f"{self.cfg.mode}-{int(time.time())}-{os.getpid()}-{self._request_seq}"

    def require_user_id(self) -> None:
        if self.cfg.user_id.strip():
            return
        raise StepFailure("user_id is required; pass --user-id with a real usr_* user id")

    def api_call(self, method: str, path: str, body: dict[str, Any] | None = None) -> HTTPResult:
        url = self.cfg.base_url.rstrip("/") + path
        payload = None
        headers = {
            "X-User-Id": self.cfg.user_id,
            "X-Request-Id": self.next_request_id(),
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url=url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.cfg.http_timeout_seconds) as response:
                body_text = response.read().decode("utf-8")
                status_code = response.getcode()
        except urllib.error.HTTPError as err:
            status_code = err.code
            body_text = err.read().decode("utf-8")
        except urllib.error.URLError as err:
            raise StepFailure(f"http request failed: {err}") from err

        try:
            data = json.loads(body_text) if body_text else {}
        except json.JSONDecodeError as err:
            raise StepFailure(f"response is not valid json: {err}") from err

        result = HTTPResult(status_code=status_code, body_text=body_text, data=data)
        self.last_response = result
        return result

    def json_path(self, data: Any, expr: str) -> Any:
        value = data
        for part in expr.split("."):
            if not part:
                continue
            if isinstance(value, list):
                value = value[int(part)]
            else:
                value = value[part]
        return value

    def expect_status(self, response: HTTPResult, expected: int) -> None:
        if response.status_code != expected:
            raise StepFailure(f"expected http {expected}, got {response.status_code}")

    def expect_success_envelope(self, response: HTTPResult) -> None:
        if self.json_path(response.data, "code") != "OK":
            raise StepFailure(f"expected envelope code OK, got {self.json_path(response.data, 'code')}")
        if self.json_path(response.data, "message") != "success":
            raise StepFailure(
                f"expected envelope message success, got {self.json_path(response.data, 'message')}"
            )

    def expect_error_code(self, response: HTTPResult, code: str) -> None:
        if self.json_path(response.data, "code") != code:
            raise StepFailure(
                f"expected error code {code}, got {self.json_path(response.data, 'code')}"
            )

    def expect_json_equals(self, response: HTTPResult, expr: str, expected: Any) -> None:
        actual = self.json_path(response.data, expr)
        if actual != expected:
            raise StepFailure(f"expected {expr}={expected}, got {actual}")

    def expect_json_non_empty(self, response: HTTPResult, expr: str) -> Any:
        actual = self.json_path(response.data, expr)
        if actual in ("", None):
            raise StepFailure(f"expected non-empty {expr}")
        return actual

    def assert_timeout_close_to_default(self, response: HTTPResult) -> None:
        raw = self.json_path(response.data, "data.timeout_at")
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        timeout_at = dt.datetime.fromisoformat(raw)
        delta = (timeout_at - dt.datetime.now(dt.timezone.utc)).total_seconds()
        if not (5 <= delta <= 40):
            raise StepFailure(f"default timeout delta out of range: {delta}")

    def load_conf_tables(self) -> list[dict[str, Any]]:
        conf_dir = Path(self.cfg.conf_dir)
        if not conf_dir.exists():
            raise StepFailure(f"conf dir not found: {conf_dir}")
        paths = [
            conf_dir / "common" / "server_conf.toml",
            conf_dir / "rewrite" / "server_conf_rewrite.toml",
        ]
        tables: list[dict[str, Any]] = []
        for path in paths:
            if not path.exists():
                continue
            with path.open("rb") as handle:
                tables.append(tomllib.load(handle))
        return tables

    def check_template_declared(self) -> None:
        if self.cfg.skip_template_config_check:
            self.record_skip("template-config-check", "skipped by runner config")
            return
        try:
            tables = self.load_conf_tables()
        except StepFailure:
            self.record_skip("template-config-check", f"conf dir not found: {self.cfg.conf_dir}")
            return

        values: list[str] = []
        for data in tables:
            instance = data.get("api", {}).get("instance", {})
            default_template = instance.get("default_template_id")
            if isinstance(default_template, str):
                values.append(default_template.strip())
            for item in instance.get("candidate_template_ids", []) or []:
                if isinstance(item, str):
                    values.append(item.strip())

        if self.cfg.template_id in values:
            self.record_pass("template-config-check")
            return
        self.record_fail(
            "template-config-check",
            f"template {self.cfg.template_id} not found in {self.cfg.conf_dir}/common or rewrite config",
        )
        raise StepFailure("template not declared")

    def check_sandbox_connectivity(self) -> None:
        if self.cfg.skip_sandbox_connectivity_check:
            self.record_skip("sandbox-connectivity-check", "skipped by runner config")
            return
        tables = self.load_conf_tables()
        base_url = ""
        for data in tables:
            sandbox = data.get("adapter", {}).get("sandbox", {})
            value = sandbox.get("baseUrl")
            if isinstance(value, str) and value.strip():
                base_url = value.strip()

        if not base_url:
            self.record_fail(
                "sandbox-connectivity-check",
                f"unable to parse sandbox baseUrl from {self.cfg.conf_dir}",
            )
            raise StepFailure("sandbox baseUrl missing")

        parsed = urllib.parse.urlparse(base_url)
        if not parsed.hostname:
            self.record_fail(
                "sandbox-connectivity-check",
                f"unable to parse sandbox baseUrl from {self.cfg.conf_dir}",
            )
            raise StepFailure("sandbox baseUrl invalid")

        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            with socket.create_connection((parsed.hostname, port), timeout=2):
                pass
        except OSError as err:
            self.record_fail(
                "sandbox-connectivity-check",
                (
                    f"sandbox endpoint unreachable: {parsed.hostname}:{port}; "
                    "run kubectl port-forward if using local rewrite config"
                ),
            )
            raise StepFailure(str(err)) from err

        self.record_pass("sandbox-connectivity-check")

    def track_instance(self, instance_id: str) -> None:
        self.created_instance_ids.append(instance_id)

    def wait_for_instance_status(self, instance_id: str, expected_status: str) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        current_status = ""
        while time.time() <= deadline:
            response = self.api_call("GET", f"/v1/instances/{instance_id}")
            if response.status_code == 200 and self.json_path(response.data, "code") == "OK":
                current_status = self.json_path(response.data, "data.status")
                if current_status == expected_status:
                    return
                if current_status == "Failed":
                    raise StepFailure(
                        f"instance {instance_id} entered Failed while waiting for {expected_status}"
                    )
            time.sleep(self.cfg.wait_interval_seconds)
        raise StepFailure(
            f"timed out waiting for instance {instance_id} status={expected_status}, last_status={current_status}"
        )

    def list_operations(self, instance_id: str) -> list[dict[str, Any]]:
        response = self.api_call(
            "GET",
            f"/v1/instances/{instance_id}/operations?page=1&page_size=20",
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        items = self.json_path(response.data, "data.items")
        if not isinstance(items, list):
            raise StepFailure("operations items is not a list")
        return [item for item in items if isinstance(item, dict)]

    def wait_for_create_operation_success(self, instance_id: str) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        consecutive_success = 0
        last_status = ""
        while time.time() <= deadline:
            op = latest_create_operation(self.list_operations(instance_id))
            if op is None:
                time.sleep(self.cfg.wait_interval_seconds)
                continue
            last_status = str(op.get("status", "")).upper()
            if last_status == "SUCCESS":
                consecutive_success += 1
                if consecutive_success >= 2:
                    return
            else:
                consecutive_success = 0
            if last_status == "FAILED":
                raise StepFailure(
                    f"instance {instance_id} CREATE failed: {create_operation_error(op)}"
                )
            time.sleep(self.cfg.wait_interval_seconds)
        raise StepFailure(
            f"timed out waiting for instance {instance_id} CREATE success, last_status={last_status or 'missing'}"
        )

    def wait_for_instance_deleted(self, instance_id: str) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        current_status = ""
        while time.time() <= deadline:
            response = self.api_call("GET", f"/v1/instances/{instance_id}")
            if response.status_code == 404:
                return
            if response.status_code == 200 and self.json_path(response.data, "code") == "OK":
                current_status = self.json_path(response.data, "data.status")
                if current_status == "Deleted":
                    return
            time.sleep(self.cfg.wait_interval_seconds)
        raise StepFailure(
            f"timed out waiting for instance {instance_id} deletion, last_status={current_status}"
        )

    def create_weixin_session(self, instance_id: str) -> str:
        response = self.api_call(
            "POST",
            f"/v1/instances/{instance_id}/channels/weixin/login-sessions",
            {},
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        session_id = str(self.expect_json_non_empty(response, "data.session_id"))
        self.expect_json_equals(response, "data.status", "starting")
        self.active_weixin_session_id = session_id
        return session_id

    def get_weixin_session(self, instance_id: str, session_id: str) -> HTTPResult:
        response = self.api_call(
            "GET",
            f"/v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}",
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        return response

    def cancel_weixin_session(self, instance_id: str, session_id: str) -> None:
        response = self.api_call(
            "POST",
            f"/v1/instances/{instance_id}/channels/weixin/login-sessions/{session_id}/cancel",
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)

    def wait_for_weixin_qr(self, instance_id: str, session_id: str) -> HTTPResult:
        deadline = time.time() + self.cfg.weixin_wait_timeout_seconds
        last_status = ""
        while time.time() <= deadline:
            response = self.get_weixin_session(instance_id, session_id)
            data = self.json_path(response.data, "data")
            last_status = str(data.get("status", ""))
            qr_url = str(data.get("qr_url") or "")
            qr_ascii = str(data.get("qr_ascii") or "")
            if last_status in ("waiting_qr", "scanned", "success") and (qr_url or qr_ascii):
                return response
            if last_status in ("failed", "expired", "cancelled", "timeout"):
                raise StepFailure(
                    f"weixin session {session_id} ended early with status={last_status}"
                )
            time.sleep(self.cfg.wait_interval_seconds)
        raise StepFailure(
            f"timed out waiting for weixin qr, last_status={last_status}, session_id={session_id}"
        )

    def destroy_instance(self, instance_id: str) -> None:
        response = self.api_call("DELETE", f"/v1/instances/{instance_id}")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.instance_id", instance_id)
        self.expect_json_equals(response, "data.status", "Deleting")
        self.wait_for_instance_deleted(instance_id)

    def cleanup_instances(self) -> None:
        if self.active_instance_id and self.active_weixin_session_id:
            try:
                self.cancel_weixin_session(self.active_instance_id, self.active_weixin_session_id)
            except Exception as err:  # noqa: BLE001
                self.log_error(
                    f"cleanup weixin session failed: {self.active_weixin_session_id}: {err}"
                )
            finally:
                self.active_weixin_session_id = ""
        if self.cfg.keep_instance:
            return
        for instance_id in reversed(self.created_instance_ids):
            if not instance_id:
                continue
            try:
                self.destroy_instance(instance_id)
            except Exception as err:  # noqa: BLE001
                self.log_error(f"cleanup instance failed: {instance_id}: {err}")

    def run_step(self, name: str, fn: Callable[[], None]) -> None:
        try:
            fn()
        except StepFailure as err:
            self.record_fail(name, str(err))
            raise
        self.record_pass(name)

    def step_health(self) -> None:
        response = self.api_call("GET", "/health")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.status", "ok")

    def step_list_soul_templates(self) -> None:
        response = self.api_call("GET", "/v1/soul-templates")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        items = self.json_path(response.data, "data.items")
        if not isinstance(items, list):
            raise StepFailure("soul templates items is not a list")
        if not items:
            raise StepFailure("soul templates list is empty")
        if not any(isinstance(item, dict) and item.get("id") == "gentle" for item in items):
            raise StepFailure("soul templates list does not include gentle")
        for item in items:
            if not isinstance(item, dict):
                raise StepFailure("soul template item is not an object")
            if not str(item.get("id", "")).strip():
                raise StepFailure("soul template id is empty")
            if not str(item.get("name", "")).strip():
                raise StepFailure(f"soul template name is empty for id={item.get('id')}")
            if not str(item.get("description", "")).strip():
                raise StepFailure(f"soul template description is empty for id={item.get('id')}")

    def step_create_primary(self) -> None:
        response = self.api_call("POST", "/v1/instances", {"timeout": self.cfg.create_timeout})
        self.expect_status(response, 201)
        self.expect_success_envelope(response)
        instance_id = self.expect_json_non_empty(response, "data.instance_id")
        self.expect_json_equals(response, "data.status", "Creating")
        self.active_instance_id = str(instance_id)
        self.track_instance(self.active_instance_id)
        self.wait_for_instance_status(self.active_instance_id, "Running")
        if self.cfg.verify_create_operation_success:
            self.wait_for_create_operation_success(self.active_instance_id)

    def step_list_instances(self) -> None:
        response = self.api_call("GET", "/v1/instances?page=1&page_size=20")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        items = self.json_path(response.data, "data.items")
        if not any(item.get("instance_id") == self.active_instance_id for item in items):
            raise StepFailure(f"instance {self.active_instance_id} not found in list response")

    def step_get_instance(self) -> None:
        response = self.api_call("GET", f"/v1/instances/{self.active_instance_id}")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.instance_id", self.active_instance_id)
        self.expect_json_equals(response, "data.status", "Running")

    def step_debug_exec_openclaw_version(self) -> None:
        response = self.api_call(
            "POST",
            f"/v1/instances/{self.active_instance_id}/debug/exec",
            {"command": "openclaw_version"},
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.status", "SUCCESS")
        self.expect_json_non_empty(response, "data.invocation_id")
        output = self.json_path(response.data, "data.output")
        if "openclaw" not in output.lower():
            raise StepFailure("debug output does not include openclaw version")

    def step_pause_instance(self) -> None:
        response = self.api_call("POST", f"/v1/instances/{self.active_instance_id}/pause")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.instance_id", self.active_instance_id)
        self.expect_json_equals(response, "data.status", "Paused")

    def step_repeat_pause(self) -> None:
        response = self.api_call("POST", f"/v1/instances/{self.active_instance_id}/pause")
        if response.status_code == 200:
            self.expect_success_envelope(response)
            self.expect_json_equals(response, "data.status", "Paused")
            return
        self.expect_status(response, 409)
        self.expect_error_code(response, "INSTANCE_STATUS_INVALID")

    def step_resume_default_timeout(self) -> None:
        response = self.api_call("POST", f"/v1/instances/{self.active_instance_id}/resume")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.instance_id", self.active_instance_id)
        self.expect_json_equals(response, "data.status", "Running")
        self.expect_json_non_empty(response, "data.timeout_at")
        self.assert_timeout_close_to_default(response)

    def step_repeat_resume(self) -> None:
        response = self.api_call(
            "POST",
            f"/v1/instances/{self.active_instance_id}/resume",
            {"timeout": self.cfg.resume_timeout},
        )
        if response.status_code == 200:
            self.expect_success_envelope(response)
            self.expect_json_equals(response, "data.status", "Running")
            return
        self.expect_status(response, 409)
        self.expect_error_code(response, "INSTANCE_STATUS_INVALID")

    def step_set_timeout(self) -> None:
        response = self.api_call(
            "POST",
            f"/v1/instances/{self.active_instance_id}/timeout",
            {"timeout": self.cfg.set_timeout},
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.instance_id", self.active_instance_id)
        self.expect_json_equals(response, "data.status", "Running")
        self.expect_json_non_empty(response, "data.timeout_at")

    def step_list_operations(self) -> None:
        response = self.api_call(
            "GET",
            f"/v1/instances/{self.active_instance_id}/operations?page=1&page_size=20",
        )
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        self.expect_json_equals(response, "data.page", 1)
        self.expect_json_equals(response, "data.page_size", 20)
        items = self.json_path(response.data, "data.items")
        if not isinstance(items, list):
            raise StepFailure("operations items is not a list")
        if not items:
            raise StepFailure("operations list is empty")
        if not any(item.get("instance_id") == self.active_instance_id for item in items):
            raise StepFailure(
                f"instance {self.active_instance_id} not found in operations response"
            )

    def step_get_logs(self) -> None:
        response = self.api_call("GET", f"/v1/instances/{self.active_instance_id}/logs?limit=50")
        self.expect_status(response, 200)
        self.expect_success_envelope(response)
        logs = self.json_path(response.data, "data.logs")
        if not isinstance(logs, list):
            raise StepFailure("logs payload is not a list")

    def step_quota_exhausted(self) -> None:
        for _ in range(self.cfg.quota_probe_limit):
            response = self.api_call("POST", "/v1/instances", {"timeout": self.cfg.create_timeout})
            if response.status_code == 201:
                self.expect_success_envelope(response)
                instance_id = str(self.expect_json_non_empty(response, "data.instance_id"))
                self.expect_json_equals(response, "data.status", "Creating")
                self.track_instance(instance_id)
                self.wait_for_instance_status(instance_id, "Running")
                if self.cfg.verify_create_operation_success:
                    self.wait_for_create_operation_success(instance_id)
                continue

            self.expect_status(response, 403)
            self.expect_error_code(response, "INSTANCE_QUOTA_EXCEEDED")
            return

        raise StepFailure(
            f"quota probe hit limit ({self.cfg.quota_probe_limit}) before seeing INSTANCE_QUOTA_EXCEEDED"
        )

    def step_destroy_created_instances(self) -> None:
        for instance_id in list(reversed(self.created_instance_ids)):
            self.destroy_instance(instance_id)
        self.created_instance_ids.clear()
        self.active_instance_id = ""

    def step_weixin_login_qr(self) -> None:
        if not self.active_instance_id:
            raise StepFailure("active instance is empty")
        session_id = self.create_weixin_session(self.active_instance_id)
        response = self.wait_for_weixin_qr(self.active_instance_id, session_id)
        data = self.json_path(response.data, "data")
        if not data.get("qr_url") and not data.get("qr_ascii"):
            raise StepFailure("weixin session returned neither qr_url nor qr_ascii")
        self.cancel_weixin_session(self.active_instance_id, session_id)
        self.active_weixin_session_id = ""

    def run_smoke(self) -> int:
        self.log_info("starting local API smoke")
        self.log_info(
            f"base_url={self.cfg.base_url} user_id={self.cfg.user_id} template_id={self.cfg.template_id}"
        )
        try:
            self.require_user_id()
            self.check_template_declared()
            self.check_sandbox_connectivity()
            self.run_step("health", self.step_health)
            self.run_step("list-soul-templates", self.step_list_soul_templates)
            self.run_step("create-instance", self.step_create_primary)
            self.run_step("get-instance", self.step_get_instance)
            self.run_step("debug-exec-openclaw-version", self.step_debug_exec_openclaw_version)
            if self.cfg.verify_weixin_login:
                self.run_step("weixin-login-qr", self.step_weixin_login_qr)
            self.run_step("destroy-created-instances", self.step_destroy_created_instances)
            return 0
        except StepFailure:
            return 1
        finally:
            self.cleanup_instances()
            self.print_summary()

    def run_regression(self) -> int:
        self.log_info("starting local API regression")
        self.log_info(
            f"base_url={self.cfg.base_url} user_id={self.cfg.user_id} template_id={self.cfg.template_id}"
        )
        try:
            self.require_user_id()
            self.check_template_declared()
            self.check_sandbox_connectivity()
            self.run_step("health", self.step_health)
            self.run_step("list-soul-templates", self.step_list_soul_templates)
            self.run_step("create-instance", self.step_create_primary)
            self.run_step("list-instances", self.step_list_instances)
            self.run_step("get-instance", self.step_get_instance)
            self.run_step("debug-exec-openclaw-version", self.step_debug_exec_openclaw_version)
            if self.cfg.verify_weixin_login:
                self.run_step("weixin-login-qr", self.step_weixin_login_qr)
            self.run_step("pause-instance", self.step_pause_instance)
            self.run_step("repeat-pause", self.step_repeat_pause)
            self.run_step("resume-default-timeout", self.step_resume_default_timeout)
            self.run_step("repeat-resume", self.step_repeat_resume)
            self.run_step("set-timeout", self.step_set_timeout)
            if self.cfg.verify_operations:
                self.run_step("list-operations", self.step_list_operations)
            if self.cfg.verify_logs:
                self.run_step("get-logs", self.step_get_logs)
            if self.cfg.verify_quota_exhausted:
                self.run_step("quota-exhausted", self.step_quota_exhausted)
            self.run_step("destroy-created-instances", self.step_destroy_created_instances)
            return 0
        except StepFailure:
            return 1
        finally:
            self.cleanup_instances()
            self.print_summary()


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help=f"ctl API 地址，默认: {DEFAULT_BASE_URL}")
    parser.add_argument(
        "--user-id",
        default=DEFAULT_USER_ID,
        help="X-User-Id 请求头；测试环境请传真实 usr_* user_id，也可通过 CTL_TEST_USER_ID 注入",
    )
    parser.add_argument(
        "--template-id",
        default=DEFAULT_TEMPLATE_ID,
        help=f"预期联调使用的 template/pool，默认: {DEFAULT_TEMPLATE_ID}",
    )
    parser.add_argument(
        "--conf-dir",
        default=DEFAULT_CONF_DIR,
        help=f"本地 ctl 配置目录，默认: {DEFAULT_CONF_DIR}",
    )
    parser.add_argument(
        "--create-timeout",
        type=int,
        default=DEFAULT_CREATE_TIMEOUT,
        help=f"创建实例 timeout，默认: {DEFAULT_CREATE_TIMEOUT}",
    )
    parser.add_argument(
        "--resume-timeout",
        type=int,
        default=DEFAULT_RESUME_TIMEOUT,
        help=f"恢复实例 timeout，默认: {DEFAULT_RESUME_TIMEOUT}",
    )
    parser.add_argument(
        "--set-timeout",
        type=int,
        default=DEFAULT_SET_TIMEOUT,
        help=f"更新实例 timeout，默认: {DEFAULT_SET_TIMEOUT}",
    )
    parser.add_argument(
        "--quota-probe-limit",
        type=int,
        default=DEFAULT_QUOTA_PROBE_LIMIT,
        help=f"配额探测最多额外创建实例数，默认: {DEFAULT_QUOTA_PROBE_LIMIT}",
    )
    parser.add_argument("--request-id", default="", help="固定请求 ID；默认自动生成")
    parser.add_argument(
        "--keep-instance",
        action="store_true",
        help="失败时不自动清理实例，便于排障",
    )
    parser.add_argument(
        "--verify-weixin-login",
        action="store_true",
        help="额外验证微信 login-session 能返回二维码字段",
    )
    parser.add_argument(
        "--weixin-wait-timeout-seconds",
        type=int,
        default=DEFAULT_WEIXIN_WAIT_TIMEOUT_SECONDS,
        help=f"等待微信二维码超时秒数，默认: {DEFAULT_WEIXIN_WAIT_TIMEOUT_SECONDS}",
    )


def config_from_args(args: argparse.Namespace, mode: str) -> RunnerConfig:
    user_id = str(args.user_id)
    if mode.startswith("testenv"):
        parser = argparse.ArgumentParser(add_help=False)
        user_id = resolve_test_user_id(parser, user_id, label=mode.replace("-", "_"), required=True)
    return RunnerConfig(
        mode=mode,
        base_url=args.base_url,
        user_id=user_id,
        template_id=args.template_id,
        conf_dir=args.conf_dir,
        create_timeout=args.create_timeout,
        resume_timeout=args.resume_timeout,
        set_timeout=args.set_timeout,
        quota_probe_limit=args.quota_probe_limit,
        request_id=args.request_id,
        keep_instance=args.keep_instance,
        verify_weixin_login=args.verify_weixin_login,
        weixin_wait_timeout_seconds=args.weixin_wait_timeout_seconds,
        verify_operations=True,
        verify_logs=True,
    )
