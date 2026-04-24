#!/usr/bin/env python3
"""CTL test-environment OpenClaw end-to-end smoke runner.

脚本定义:
  对已部署的测试环境 ctl-api 执行一条最关键的真实链路：
  0. 自动 provision 一个可用于 ai-gateway 发 key 的临时用户（也可复用指定 user_id）
  1. 创建实例
  2. 等待实例进入 Running，并确认 CREATE operation 真正成功
  3. 若本地端口已被旧的 ctl-api port-forward 占用，自动清理陈旧 kubectl 进程
  4. 执行 debug/exec openclaw_soul，确认 SOUL.md 已按模板写入
  5. 执行 debug/exec openclaw_config，确认 custom provider 已写入
  6. 执行 debug/exec openclaw_agent_smoke，确认 OpenClaw 能真正拿到模型返回
  7. 默认自动删除实例，避免残留测试资源

参数定义:
  --base-url                  ctl-api 基础地址。默认 http://127.0.0.1:19590
  --env                       可选；若填写则自动从 deploy/envs/<env>/platform.env 推导 kubeconfig 并启动 port-forward
  --kubeconfig                可选；显式指定 kubectl 使用的 kubeconfig
  --port-forward-port         自动 port-forward 时绑定的本地端口。默认 19590
  --user-id                   可选；不传时自动生成临时 usr_* user_id
  --skip-provision-user       跳过 ai-gateway 用户 provision；只适合你已确认 user_id 已存在
  --skip-agent-smoke          只验证实例创建 / SOUL / openclaw_config，不跑最终 agent 冒烟
  --aigateway-admin-base-url  ai-gateway admin 基础地址；默认优先取环境变量，其次从 ctl 测试配置推导
  --aigateway-admin-token     ai-gateway admin token；默认优先取环境变量，其次从 .secret/ctl/test.env 读取
  --soul-template-id          创建实例时下发的 soul_template_id。默认 gentle
  --instance-timeout          创建实例时下发的 timeout 秒数。默认 3600
  --wait-timeout-seconds      等待实例 Running 的总超时。默认 300
  --wait-interval-seconds     轮询间隔。默认 3
  --http-timeout-seconds      单次 HTTP 请求超时。默认 30
  --cleanup-timeout-seconds   删除实例后的等待超时。默认 120
  --expected-base-url         可选，若填写则要求 openclaw_config 输出包含该 base URL
  --expected-model            可选，若填写则要求 openclaw_config 输出包含该模型；默认 kimi-k2.5
  --keep-instance             保留实例，不做自动删除

输出结果定义:
  - stdout: 打印每个阶段的 PASS/FAIL、实例 ID、关键输出摘要
  - stderr: 打印 HTTP 错误和失败细节
  - exit 0: 整条链路通过
  - exit 1: 任一阶段失败

示例:
  python3 ctl/scripts/tests/smoke-openclaw-testenv.py \
    --env beijing-sandbox \
    --soul-template-id gentle \
    --skip-agent-smoke

  python3 ctl/scripts/tests/smoke-openclaw-testenv.py \
    --soul-template-id gentle

  python3 ctl/scripts/tests/smoke-openclaw-testenv.py \
    --base-url http://127.0.0.1:19590 \
    --user-id usr_3929fd9d3a957ae7905aa058 \
    --skip-provision-user \
    --soul-template-id pro \
    --expected-base-url http://lb-a885sn2l-bs459xiehz3uvpwd.clb.bj-tencentclb.com/v1
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from testenv_runtime import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_AIGATEWAY_ADMIN_TOKEN,
    DEFAULT_CTL_TEST_ENV_FILE,
    DEFAULT_PORT_FORWARD_PORT,
    DEFAULT_TEST_USER_ID,
    PortForwardManager,
    add_testenv_connection_args,
    choose_port_forward_port,
    create_operation_error,
    latest_create_operation,
    load_env_file,
    normalize_optional_test_user_id,
    resolve_aigateway_endpoints,
    resolve_testenv_connection,
    resolve_test_user_for_smoke,
)


DEFAULT_SOUL_TEMPLATE_ID = os.environ.get("CTL_TEST_SOUL_TEMPLATE_ID", "gentle")
DEFAULT_RUN_ATTEMPTS = int(os.environ.get("CTL_TEST_RUN_ATTEMPTS", "2"))
DEFAULT_AIGATEWAY_PORT_FORWARD_PORT = int(os.environ.get("CTL_TEST_AIGATEWAY_PORT_FORWARD_PORT", "18780"))
DEFAULT_AIGATEWAY_NAMESPACE = "ai-gateway"
DEFAULT_AIGATEWAY_SERVICE = "gateway-backend"


class SmokeFailure(RuntimeError):
    """Raised when a smoke step fails."""


@dataclass
class HTTPResponse:
    status_code: int
    body_text: str
    data: dict[str, Any]


@dataclass
class SmokeConfig:
    base_url: str
    env_name: str
    kubeconfig: str
    port_forward_port: int
    requested_port_forward_port: int
    user_id: str
    user_source: str
    skip_provision_user: bool
    skip_agent_smoke: bool
    aigateway_admin_base_url: str
    aigateway_admin_token: str
    aigateway_port_forward_port: int
    requested_aigateway_port_forward_port: int
    soul_template_id: str
    instance_timeout: int
    wait_timeout_seconds: int
    wait_interval_seconds: int
    http_timeout_seconds: int
    cleanup_timeout_seconds: int
    expected_base_url: str
    expected_model: str
    keep_instance: bool
    run_attempts: int


class SmokeRunner:
    def __init__(self, cfg: SmokeConfig) -> None:
        self.cfg = cfg
        self.instance_id = ""
        self.port_forward = PortForwardManager(
            base_url=cfg.base_url,
            env_name=cfg.env_name,
            kubeconfig=cfg.kubeconfig,
            port_forward_port=cfg.port_forward_port,
            requested_port_forward_port=cfg.requested_port_forward_port,
        )
        self.aigateway_port_forward = PortForwardManager(
            base_url=cfg.aigateway_admin_base_url,
            env_name=cfg.env_name,
            kubeconfig=cfg.kubeconfig,
            port_forward_port=cfg.aigateway_port_forward_port,
            requested_port_forward_port=cfg.requested_aigateway_port_forward_port,
            namespace=DEFAULT_AIGATEWAY_NAMESPACE,
            service=DEFAULT_AIGATEWAY_SERVICE,
        )

    def log(self, message: str) -> None:
        print(f"INFO: {message}", flush=True)

    def log_error(self, message: str) -> None:
        print(f"ERROR: {message}", file=sys.stderr, flush=True)

    def pass_step(self, name: str) -> None:
        print(f"PASS: {name}", flush=True)

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        base_url: str | None = None,
        extra_headers: dict[str, str] | None = None,
        request_id_prefix: str = "openclaw-smoke",
        timeout_seconds: int | None = None,
    ) -> HTTPResponse:
        url = (base_url or self.cfg.base_url).rstrip("/") + path
        payload = None
        headers = {
            "X-User-Id": self.cfg.user_id,
            "X-Request-Id": f"{request_id_prefix}-{int(time.time())}",
        }
        if extra_headers:
            headers.update(extra_headers)
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url=url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=(timeout_seconds or self.cfg.http_timeout_seconds)) as resp:
                body_text = resp.read().decode("utf-8")
                status_code = resp.getcode()
        except urllib.error.HTTPError as err:
            status_code = err.code
            body_text = err.read().decode("utf-8")
        except urllib.error.URLError as err:
            raise SmokeFailure(f"http request failed for {method} {path}: {err}") from err

        try:
            data = json.loads(body_text) if body_text else {}
        except json.JSONDecodeError as err:
            raise SmokeFailure(f"response is not valid json for {method} {path}: {err}") from err

        return HTTPResponse(status_code=status_code, body_text=body_text, data=data)

    def expect_status(self, response: HTTPResponse, expected: int, label: str) -> None:
        if response.status_code != expected:
            raise SmokeFailure(
                f"{label}: expected http {expected}, got {response.status_code}, body={response.body_text}"
            )

    def expect_status_in(self, response: HTTPResponse, expected: set[int], label: str) -> None:
        if response.status_code not in expected:
            wanted = ", ".join(str(code) for code in sorted(expected))
            raise SmokeFailure(
                f"{label}: expected http in {{{wanted}}}, got {response.status_code}, body={response.body_text}"
            )

    def expect_ok_envelope(self, response: HTTPResponse, label: str) -> dict[str, Any]:
        if response.data.get("code") != "OK":
            raise SmokeFailure(f"{label}: expected code=OK, got body={response.body_text}")
        if response.data.get("message") != "success":
            raise SmokeFailure(f"{label}: expected message=success, got body={response.body_text}")
        data = response.data.get("data")
        if not isinstance(data, dict):
            raise SmokeFailure(f"{label}: expected object data envelope, got body={response.body_text}")
        return data

    def expect_object_json(self, response: HTTPResponse, label: str) -> dict[str, Any]:
        data = response.data
        if not isinstance(data, dict):
            raise SmokeFailure(f"{label}: expected object json body, got body={response.body_text}")
        if "code" in data and "message" in data and "data" in data:
            return self.expect_ok_envelope(response, label)
        return data

    def load_soul_template_content(self) -> str:
        path = Path("ctl/assets/souls") / f"SOUL-{self.cfg.soul_template_id}.md"
        try:
            content = path.read_text(encoding="utf-8")
        except FileNotFoundError as err:
            raise SmokeFailure(f"soul-template: template file not found: {path}") from err
        normalized = content.strip()
        if not normalized:
            raise SmokeFailure(f"soul-template: template file is empty: {path}")
        return normalized

    @staticmethod
    def normalize_soul_text(text: str) -> str:
        normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        start = normalized.find("# SOUL.md")
        if start >= 0:
            normalized = normalized[start:]
        return "\n".join(line.rstrip() for line in normalized.splitlines()).strip()

    def ensure_test_user(self) -> None:
        if not self.cfg.user_id:
            try:
                resolved = resolve_test_user_for_smoke(
                    preferred_user_id="",
                    skip_provision_user=self.cfg.skip_provision_user,
                    admin_base_url=self.cfg.aigateway_admin_base_url,
                    admin_token=self.cfg.aigateway_admin_token,  # pragma: allowlist secret
                    ctl_base_url=self.cfg.base_url,
                    generated_user_label="openclaw_smoke",
                    provision_nickname="ctl-smoke",
                    request_id_prefix="openclaw-smoke-aigw",
                    timeout=self.cfg.http_timeout_seconds,
                )
            except RuntimeError as err:
                raise SmokeFailure(f"ensure-user: {err}") from err
            self.cfg.user_id = resolved.user_id
            self.cfg.user_source = resolved.source

        if self.cfg.user_source == "explicit":
            self.log(f"using explicit user_id={self.cfg.user_id}")
        elif self.cfg.user_source == "ctl-existing-instance":
            self.log(f"reusing ctl user with existing instance: {self.cfg.user_id}")
        elif self.cfg.user_source == "aigateway-existing-user":
            self.log(f"reusing existing ai-gateway user: {self.cfg.user_id}")
        elif self.cfg.user_source == "provisioned":
            self.log(f"provisioned ai-gateway user: {self.cfg.user_id}")
        else:
            self.log(f"using discovered user_id={self.cfg.user_id} source={self.cfg.user_source}")
        self.pass_step("ensure-user")

    def run_health_check(self) -> None:
        response = self.request("GET", "/health")
        self.expect_status(response, 200, "health")
        if response.data.get("code") != "OK":
            raise SmokeFailure(f"health: expected code=OK, got body={response.body_text}")
        self.pass_step("health")

    def run_list_soul_templates(self) -> None:
        response = self.request("GET", "/v1/soul-templates")
        self.expect_status(response, 200, "list-soul-templates")
        data = self.expect_ok_envelope(response, "list-soul-templates")
        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise SmokeFailure(
                f"list-soul-templates: expected non-empty items, body={response.body_text}"
            )
        matched = None
        for item in items:
            if not isinstance(item, dict):
                raise SmokeFailure(
                    f"list-soul-templates: expected object item, body={response.body_text}"
                )
            if not str(item.get("id", "")).strip():
                raise SmokeFailure(
                    f"list-soul-templates: empty id, body={response.body_text}"
                )
            if not str(item.get("name", "")).strip() or not str(item.get("description", "")).strip():
                raise SmokeFailure(
                    f"list-soul-templates: empty name/description, body={response.body_text}"
                )
            if str(item.get("id")) == self.cfg.soul_template_id:
                matched = item
        if matched is None:
            raise SmokeFailure(
                f"list-soul-templates: requested template {self.cfg.soul_template_id} missing, body={response.body_text}"
            )
        self.log(f"soul template available: {matched.get('id')} ({matched.get('name')})")
        self.pass_step("list-soul-templates")

    def create_instance(self) -> None:
        response = self.request(
            "POST",
            "/v1/instances",
            {
                "timeout": self.cfg.instance_timeout,
                "soul_template_id": self.cfg.soul_template_id,
            },
        )
        self.expect_status_in(response, {200, 201}, "create-instance")
        data = self.expect_ok_envelope(response, "create-instance")
        instance_id = data.get("instance_id", "")
        if not instance_id:
            raise SmokeFailure(f"create-instance: empty instance_id, body={response.body_text}")
        self.instance_id = instance_id
        self.log(f"instance created: {self.instance_id} soul_template_id={self.cfg.soul_template_id}")
        self.pass_step("create-instance")

    def wait_running(self) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        last_status = ""
        while time.time() < deadline:
            response = self.request("GET", f"/v1/instances/{self.instance_id}")
            self.expect_status(response, 200, "wait-running")
            data = self.expect_ok_envelope(response, "wait-running")
            last_status = str(data.get("status", ""))
            if last_status == "Running":
                self.log(f"instance is running: sandbox_id={data.get('sandbox_id', '')}")
                self.pass_step("wait-running")
                return
            if last_status in {"Destroy", "Deleted", "DeleteFailed", "CreateFailed"}:
                raise SmokeFailure(f"wait-running: instance entered terminal status {last_status}")
            time.sleep(self.cfg.wait_interval_seconds)
        raise SmokeFailure(f"wait-running: timeout, last_status={last_status}")

    def list_operations(self) -> list[dict[str, Any]]:
        response = self.request(
            "GET",
            f"/v1/instances/{self.instance_id}/operations?page=1&page_size=20",
        )
        self.expect_status(response, 200, "list-operations")
        data = self.expect_ok_envelope(response, "list-operations")
        items = data.get("items")
        if not isinstance(items, list):
            raise SmokeFailure(f"list-operations: expected list items, body={response.body_text}")
        return [item for item in items if isinstance(item, dict)]

    def get_latest_create_operation(self, label: str) -> dict[str, Any]:
        op = latest_create_operation(self.list_operations())
        if op is None:
            raise SmokeFailure(f"{label}: CREATE operation not found")
        return op

    def ensure_create_operation_healthy(self, label: str) -> None:
        op = self.get_latest_create_operation(label)
        status = str(op.get("status", "")).upper()
        if status == "FAILED":
            raise SmokeFailure(f"{label}: CREATE failed: {create_operation_error(op)}")
        if status == "SUCCESS":
            return
        raise SmokeFailure(f"{label}: CREATE still not ready, status={status or 'missing'}")

    def wait_create_operation_success(self) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        last_status = ""
        consecutive_success = 0
        while time.time() < deadline:
            op = self.get_latest_create_operation("wait-create-operation")
            last_status = str(op.get("status", "")).upper()
            if last_status == "SUCCESS":
                consecutive_success += 1
                if consecutive_success >= 2:
                    self.log(f"create operation succeeded: operation_id={op.get('operation_id', '')}")
                    self.pass_step("wait-create-operation")
                    return
            else:
                consecutive_success = 0
            if last_status == "FAILED":
                raise SmokeFailure(
                    f"wait-create-operation: CREATE failed: {create_operation_error(op)}"
                )
            if last_status in {"", "CREATED", "RUNNING"}:
                time.sleep(self.cfg.wait_interval_seconds)
                continue
            time.sleep(self.cfg.wait_interval_seconds)
        raise SmokeFailure(f"wait-create-operation: timeout, last_status={last_status or 'missing'}")

    def exec_debug_command(self, command: str) -> dict[str, Any]:
        debug_http_timeout = max(self.cfg.http_timeout_seconds, 150)
        response = self.request(
            "POST",
            f"/v1/instances/{self.instance_id}/debug/exec",
            {"command": command},
            timeout_seconds=debug_http_timeout,
        )
        self.expect_status(response, 200, f"debug-exec:{command}")
        data = self.expect_ok_envelope(response, f"debug-exec:{command}")
        if data.get("status") != "SUCCESS":
            raise SmokeFailure(
                f"debug-exec:{command}: expected SUCCESS, got body={response.body_text}"
            )
        if int(data.get("exit_code", 1)) != 0:
            raise SmokeFailure(
                f"debug-exec:{command}: expected exit_code=0, got body={response.body_text}"
            )
        return data

    def verify_openclaw_config(self) -> None:
        self.ensure_create_operation_healthy("openclaw-config")
        data = self.exec_debug_command("openclaw_config")
        output = str(data.get("output", ""))
        required_tokens = ['"providers"', '"apiKey"', '"baseUrl"', '"primary"']
        for token in required_tokens:
            if token not in output:
                raise SmokeFailure(f"openclaw-config: missing token {token} in output")
        if self.cfg.expected_model and self.cfg.expected_model not in output:
            raise SmokeFailure(
                f"openclaw-config: expected model {self.cfg.expected_model} not found"
            )
        if self.cfg.expected_base_url and self.cfg.expected_base_url not in output:
            raise SmokeFailure(
                f"openclaw-config: expected base url {self.cfg.expected_base_url} not found"
            )
        self.pass_step("openclaw-config")

    def verify_soul_template(self) -> None:
        expected = self.normalize_soul_text(self.load_soul_template_content())
        max_attempts = 10
        retry_interval_seconds = 3
        for attempt in range(1, max_attempts + 1):
            self.ensure_create_operation_healthy("openclaw-soul")
            data = self.exec_debug_command("openclaw_soul")
            output = self.normalize_soul_text(str(data.get("output", "")))
            if output == expected or expected in output:
                first_line = expected.splitlines()[0].strip()
                self.log(f"verified SOUL.md template: {self.cfg.soul_template_id} ({first_line})")
                self.pass_step("openclaw-soul")
                return
            self.ensure_create_operation_healthy("openclaw-soul")
            if attempt < max_attempts:
                self.log(
                    f"openclaw-soul mismatch on attempt {attempt}, retrying after {retry_interval_seconds}s"
                )
                time.sleep(retry_interval_seconds)
        first_line = expected.splitlines()[0].strip()
        raise SmokeFailure(
            f"openclaw-soul: SOUL.md content mismatch with requested template after retries ({first_line})"
        )

    def verify_agent_smoke(self) -> None:
        self.ensure_create_operation_healthy("openclaw-agent-smoke")
        data = self.exec_debug_command("openclaw_agent_smoke")
        output = str(data.get("output", ""))
        if "\nOK\n" not in f"\n{output}\n":
            raise SmokeFailure(f"openclaw-agent-smoke: expected final OK, got output={output!r}")
        self.pass_step("openclaw-agent-smoke")

    def cleanup_instance(self) -> None:
        if not self.instance_id or self.cfg.keep_instance:
            if self.instance_id and self.cfg.keep_instance:
                self.log(f"keep-instance enabled, leaving {self.instance_id} intact")
            return
        response = self.request("DELETE", f"/v1/instances/{self.instance_id}")
        self.expect_status(response, 200, "delete-instance")
        self.expect_ok_envelope(response, "delete-instance")
        deadline = time.time() + self.cfg.cleanup_timeout_seconds
        while time.time() < deadline:
            response = self.request("GET", f"/v1/instances/{self.instance_id}")
            if response.status_code == 404 or response.data.get("code") == "NOT_FOUND":
                self.pass_step("delete-instance")
                return
            time.sleep(2)
        raise SmokeFailure(f"delete-instance: timeout waiting for instance {self.instance_id} to disappear")

    def run_once(self) -> None:
        try:
            self.port_forward.start()
            self.aigateway_port_forward.start()
        except RuntimeError as err:
            raise SmokeFailure(str(err)) from err
        self.ensure_test_user()
        self.run_health_check()
        self.run_list_soul_templates()
        self.create_instance()
        self.wait_running()
        self.wait_create_operation_success()
        self.verify_soul_template()
        self.verify_openclaw_config()
        if self.cfg.skip_agent_smoke:
            self.log("skip-agent-smoke enabled, skipping final openclaw_agent_smoke")
        else:
            self.verify_agent_smoke()

    def cleanup_after_attempt(self) -> None:
        try:
            self.cleanup_instance()
        except SmokeFailure as cleanup_err:
            self.log_error(str(cleanup_err))
            if not self.cfg.keep_instance:
                self.log_error("manual cleanup may be required")
        finally:
            self.aigateway_port_forward.stop()
            self.port_forward.stop()

    def run(self) -> int:
        attempts = max(1, self.cfg.run_attempts)
        last_err: SmokeFailure | None = None
        for attempt in range(1, attempts + 1):
            self.instance_id = ""
            try:
                self.run_once()
                self.cleanup_after_attempt()
                return 0
            except SmokeFailure as err:
                last_err = err
                self.log_error(str(err))
                self.cleanup_after_attempt()
                if self.cfg.keep_instance:
                    return 1
                if attempt < attempts:
                    self.log(
                        f"smoke attempt {attempt} failed, retrying after 5s"
                    )
                    time.sleep(5)
                    continue
                return 1
        try:
            if last_err is not None:
                self.log_error(str(last_err))
            return 1
        finally:
            self.port_forward.stop()


def parse_args() -> SmokeConfig:
    env_file_values = load_env_file(DEFAULT_CTL_TEST_ENV_FILE)

    parser = argparse.ArgumentParser(
        description="Run the CTL test-environment OpenClaw end-to-end smoke."
    )
    add_testenv_connection_args(parser)
    parser.add_argument(
        "--user-id",
        default=DEFAULT_TEST_USER_ID,
        help="optional usr_* user id; default auto-generates a disposable test user",
    )
    parser.add_argument(
        "--skip-provision-user",
        action="store_true",
        help="skip ai-gateway admin provision and trust the provided/generated user_id as already usable",
    )
    parser.add_argument(
        "--skip-agent-smoke",
        action="store_true",
        help="skip final openclaw_agent_smoke and stop after SOUL/config verification",
    )
    parser.add_argument(
        "--aigateway-admin-base-url",
        default="",
        help="optional override; otherwise auto-resolve from env/platform/test config",
    )
    parser.add_argument(
        "--aigateway-admin-token",
        default=(DEFAULT_AIGATEWAY_ADMIN_TOKEN or env_file_values.get("CTL_TEST_AIGATEWAY_ADMIN_TOKEN", "")),
        help="default: CTL_TEST_AIGATEWAY_ADMIN_TOKEN or .secret/ctl/test.env",
    )
    parser.add_argument(
        "--soul-template-id",
        default=DEFAULT_SOUL_TEMPLATE_ID,
        help=f'default: "{DEFAULT_SOUL_TEMPLATE_ID}"',
    )
    parser.add_argument("--instance-timeout", type=int, default=3600, help="default: 3600")
    parser.add_argument("--wait-timeout-seconds", type=int, default=300, help="default: 300")
    parser.add_argument("--wait-interval-seconds", type=int, default=3, help="default: 3")
    parser.add_argument("--http-timeout-seconds", type=int, default=30, help="default: 30")
    parser.add_argument("--cleanup-timeout-seconds", type=int, default=120, help="default: 120")
    parser.add_argument(
        "--expected-base-url",
        default="",
        help="optional config assertion; default auto-resolves from env/platform/test config when available",
    )
    parser.add_argument("--expected-model", default="kimi-k2.5", help='default: "kimi-k2.5"')
    parser.add_argument("--keep-instance", action="store_true", help="do not delete the created instance")
    parser.add_argument("--run-attempts", type=int, default=DEFAULT_RUN_ATTEMPTS, help=f"default: {DEFAULT_RUN_ATTEMPTS}")
    args = parser.parse_args()
    connection = resolve_testenv_connection(parser, args)
    platform_env_values = load_env_file(Path("deploy") / "envs" / connection.env_name / "platform.env") if connection.env_name else {}
    resolved_endpoints = resolve_aigateway_endpoints(
        env_file_values=env_file_values,
        platform_env_values=platform_env_values,
    )

    user_id = normalize_optional_test_user_id(parser, args.user_id)
    resolved_admin_base_url = args.aigateway_admin_base_url.strip() or resolved_endpoints.admin_base_url
    resolved_expected_base_url = args.expected_base_url.strip() or resolved_endpoints.expected_base_url
    requested_aigateway_port_forward_port = DEFAULT_AIGATEWAY_PORT_FORWARD_PORT
    aigateway_port_forward_port = requested_aigateway_port_forward_port

    if not user_id and connection.env_name and not args.aigateway_admin_base_url.strip():
        try:
            aigateway_port_forward_port = choose_port_forward_port(
                requested_aigateway_port_forward_port,
                namespace=DEFAULT_AIGATEWAY_NAMESPACE,
                service=DEFAULT_AIGATEWAY_SERVICE,
            )
        except ValueError as err:
            parser.error(str(err))
        resolved_admin_base_url = f"http://127.0.0.1:{aigateway_port_forward_port}/api/admin"

    if not user_id:
        if not resolved_admin_base_url:
            parser.error("unable to resolve ai-gateway admin base url for auto user discovery")
        if not args.aigateway_admin_token.strip():
            parser.error("--aigateway-admin-token is required when auto user discovery is enabled")
    if not re.fullmatch(r"[a-z0-9-]+", args.soul_template_id.strip()):
        parser.error("--soul-template-id must match [a-z0-9-]+")
    if args.run_attempts < 1:
        parser.error("--run-attempts must be >= 1")

    return SmokeConfig(
        base_url=connection.base_url,
        env_name=connection.env_name,
        kubeconfig=connection.kubeconfig,
        port_forward_port=connection.port_forward_port,
        requested_port_forward_port=connection.requested_port_forward_port,
        user_id=user_id,
        user_source="explicit" if user_id else "",
        skip_provision_user=args.skip_provision_user,
        skip_agent_smoke=args.skip_agent_smoke,
        aigateway_admin_base_url=resolved_admin_base_url,
        aigateway_admin_token=args.aigateway_admin_token.strip(),
        aigateway_port_forward_port=aigateway_port_forward_port,
        requested_aigateway_port_forward_port=requested_aigateway_port_forward_port,
        soul_template_id=args.soul_template_id.strip(),
        instance_timeout=args.instance_timeout,
        wait_timeout_seconds=args.wait_timeout_seconds,
        wait_interval_seconds=args.wait_interval_seconds,
        http_timeout_seconds=args.http_timeout_seconds,
        cleanup_timeout_seconds=args.cleanup_timeout_seconds,
        expected_base_url=resolved_expected_base_url,
        expected_model=args.expected_model.strip(),
        keep_instance=args.keep_instance,
        run_attempts=args.run_attempts,
    )


def main() -> int:
    cfg = parse_args()
    runner = SmokeRunner(cfg)
    return runner.run()


if __name__ == "__main__":
    sys.exit(main())
