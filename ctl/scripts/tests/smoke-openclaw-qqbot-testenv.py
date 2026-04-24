#!/usr/bin/env python3
"""CTL test-environment OpenClaw QQBot smoke runner.

脚本定义:
  对已部署的测试环境 ctl-api 执行“实例创建 -> OpenClaw 主链路 -> QQBot 配置 -> 调试采样”的端到端烟雾验证。
  该脚本覆盖目前最容易回归的真实链路：
  1. 创建实例
  2. 等待实例进入 Running
  3. 执行 debug/exec openclaw_config，确认 custom provider 已写入
  4. 执行 debug/exec openclaw_agent_smoke，确认 OpenClaw 能真正拿到模型返回
  5. 调用 /channels/config 下发 QQBot token
  6. 执行 debug/exec openclaw_channels_status / openclaw_gateway_status
  7. 可选抓取 QQBot 专项日志和最近 gateway 日志，便于人工验证前快速留痕

参数定义:
  --base-url                  ctl-api 基础地址。默认 http://127.0.0.1:19590
  --env                       可选；若填写则自动从 deploy/envs/<env>/platform.env 推导 kubeconfig 并启动 port-forward
  --kubeconfig                可选；显式指定 kubectl 使用的 kubeconfig
  --port-forward-port         自动 port-forward 时绑定的本地端口。默认 19590
  --user-id                   必填，测试环境真实 usr_* user_id；也可用 CTL_TEST_USER_ID 注入
  --qqbot-token               必填，格式 AppID:AppSecret；也可用 QQBOT_TOKEN 注入
  --instance-timeout          创建实例时下发的 timeout 秒数。默认 3600
  --wait-timeout-seconds      等待实例 Running 的总超时。默认 300
  --wait-interval-seconds     轮询间隔。默认 3
  --http-timeout-seconds      单次 HTTP 请求超时。默认 30
  --cleanup-timeout-seconds   删除实例后的等待超时。默认 120
  --expected-base-url         可选，若填写则要求 openclaw_config 输出包含该 base URL
  --expected-model            可选，若填写则要求 openclaw_config 输出包含该模型；默认 kimi-k2.5
  --skip-log-snapshot         跳过 openclaw_qqbot_logs / openclaw_logs_recent 采样
  --keep-instance             保留实例，不做自动删除；适合人工继续验证 QQBot

输出结果定义:
  - stdout: 打印每个阶段的 PASS/FAIL、实例 ID、关键调试输出摘要
  - stderr: 打印 HTTP 错误和失败细节
  - exit 0: 自动化阶段全部通过
  - exit 1: 任一阶段失败

示例:
  python3 ctl/scripts/tests/smoke-openclaw-qqbot-testenv.py \
    --env beijing-sandbox \
    --user-id usr_3929fd9d3a957ae7905aa058 \
    --qqbot-token "$QQBOT_TOKEN" \
    --keep-instance

  python3 ctl/scripts/tests/smoke-openclaw-qqbot-testenv.py \
    --base-url http://127.0.0.1:19590 \
    --user-id usr_3929fd9d3a957ae7905aa058 \
    --qqbot-token 1903259926:xxxx \
    --expected-base-url http://lb-a885sn2l-bs459xiehz3uvpwd.clb.bj-tencentclb.com/v1
"""

from __future__ import annotations

import argparse
import json
import os
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
    DEFAULT_PORT_FORWARD_PORT,
    DEFAULT_TEST_USER_ID,
    PortForwardManager,
    add_testenv_connection_args,
    create_operation_error,
    latest_create_operation,
    resolve_testenv_connection,
    resolve_test_user_id,
)


DEFAULT_QQBOT_TOKEN = os.environ.get("QQBOT_TOKEN", "")


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
    qqbot_token: str
    instance_timeout: int
    wait_timeout_seconds: int
    wait_interval_seconds: int
    http_timeout_seconds: int
    cleanup_timeout_seconds: int
    expected_base_url: str
    expected_model: str
    skip_log_snapshot: bool
    keep_instance: bool


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

    def log(self, message: str) -> None:
        print(f"INFO: {message}", flush=True)

    def log_error(self, message: str) -> None:
        print(f"ERROR: {message}", file=sys.stderr, flush=True)

    def pass_step(self, name: str) -> None:
        print(f"PASS: {name}", flush=True)

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> HTTPResponse:
        url = self.cfg.base_url.rstrip("/") + path
        payload = None
        headers = {
            "X-User-Id": self.cfg.user_id,
            "X-Request-Id": f"openclaw-qqbot-smoke-{int(time.time())}",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url=url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.cfg.http_timeout_seconds) as resp:
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
        self.pass_step("list-soul-templates")

    def create_instance(self) -> None:
        response = self.request("POST", "/v1/instances", {"timeout": self.cfg.instance_timeout})
        self.expect_status_in(response, {200, 201}, "create-instance")
        data = self.expect_ok_envelope(response, "create-instance")
        instance_id = data.get("instance_id", "")
        if not instance_id:
            raise SmokeFailure(f"create-instance: empty instance_id, body={response.body_text}")
        self.instance_id = instance_id
        self.log(f"instance created: {self.instance_id}")
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
        consecutive_success = 0
        last_status = ""
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
            time.sleep(self.cfg.wait_interval_seconds)
        raise SmokeFailure(f"wait-create-operation: timeout, last_status={last_status or 'missing'}")

    def exec_debug_command(self, command: str) -> dict[str, Any]:
        response = self.request(
            "POST",
            f"/v1/instances/{self.instance_id}/debug/exec",
            {"command": command},
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

    def verify_agent_smoke(self) -> None:
        self.ensure_create_operation_healthy("openclaw-agent-smoke")
        data = self.exec_debug_command("openclaw_agent_smoke")
        output = str(data.get("output", ""))
        if "\nOK\n" not in f"\n{output}\n":
            raise SmokeFailure(f"openclaw-agent-smoke: expected final OK, got output={output!r}")
        self.pass_step("openclaw-agent-smoke")

    def configure_qqbot(self) -> None:
        self.ensure_create_operation_healthy("qqbot-config")
        response = self.request(
            "POST",
            f"/v1/instances/{self.instance_id}/channels/config",
            {"channel": "qqbot", "token": self.cfg.qqbot_token},
        )
        self.expect_status(response, 200, "qqbot-config")
        data = self.expect_ok_envelope(response, "qqbot-config")
        if str(data.get("status")) != "Succeeded":
            raise SmokeFailure(f"qqbot-config: unexpected status, body={response.body_text}")
        if data.get("channel") != "qqbot":
            raise SmokeFailure(f"qqbot-config: expected channel=qqbot, body={response.body_text}")
        if not bool(data.get("gateway_restarted")):
            raise SmokeFailure(f"qqbot-config: expected gateway_restarted=true, body={response.body_text}")
        output = str(data.get("output", ""))
        if "Added QQ Bot account" not in output:
            raise SmokeFailure(f"qqbot-config: expected add-account output, got {output!r}")
        self.pass_step("qqbot-config")

    def verify_qqbot_status(self) -> None:
        self.ensure_create_operation_healthy("qqbot-status")
        data = self.exec_debug_command("openclaw_channels_status")
        output = str(data.get("output", ""))
        required = [
            "QQ Bot default",
            "configured",
            "running",
            "connected",
        ]
        for token in required:
            if token not in output:
                raise SmokeFailure(f"qqbot-status: missing token {token} in output={output!r}")
        self.pass_step("qqbot-status")

    def verify_gateway_status(self) -> None:
        self.ensure_create_operation_healthy("gateway-status")
        data = self.exec_debug_command("openclaw_gateway_status")
        output = str(data.get("output", ""))
        required = [
            "gateway_port=",
            "===ps===",
            "openclaw-gateway",
            "===listen===",
            ":18789",
        ]
        for token in required:
            if token not in output:
                raise SmokeFailure(f"gateway-status: missing token {token} in output={output!r}")
        self.pass_step("gateway-status")

    def log_snapshot(self) -> None:
        if self.cfg.skip_log_snapshot:
            return
        self.ensure_create_operation_healthy("log-snapshot")
        qqbot_logs = self.exec_debug_command("openclaw_qqbot_logs")
        recent_logs = self.exec_debug_command("openclaw_logs_recent")
        qqbot_output = str(qqbot_logs.get("output", ""))
        recent_output = str(recent_logs.get("output", ""))
        self.log("qqbot log snapshot:")
        print(qqbot_output[:4000], flush=True)
        self.log("recent gateway log snapshot:")
        print(recent_output[:4000], flush=True)
        self.pass_step("log-snapshot")

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

    def run(self) -> int:
        try:
            try:
                self.port_forward.start()
            except RuntimeError as err:
                raise SmokeFailure(str(err)) from err
            self.run_health_check()
            self.run_list_soul_templates()
            self.create_instance()
            self.wait_running()
            self.wait_create_operation_success()
            self.verify_openclaw_config()
            self.verify_agent_smoke()
            self.configure_qqbot()
            self.verify_qqbot_status()
            self.verify_gateway_status()
            self.log_snapshot()
            self.log(
                "automatic QQBot checks passed; if you need manual message verification, rerun with --keep-instance"
            )
            return 0
        except SmokeFailure as err:
            self.log_error(str(err))
            return 1
        finally:
            try:
                self.cleanup_instance()
            except SmokeFailure as cleanup_err:
                self.log_error(str(cleanup_err))
                if not self.cfg.keep_instance:
                    self.log_error("manual cleanup may be required")
            finally:
                self.port_forward.stop()


def parse_args() -> SmokeConfig:
    parser = argparse.ArgumentParser(
        description="Run the CTL test-environment OpenClaw + QQBot smoke."
    )
    add_testenv_connection_args(parser)
    parser.add_argument(
        "--user-id",
        default=DEFAULT_TEST_USER_ID,
        help="real test-env usr_* user id; or set CTL_TEST_USER_ID",
    )
    parser.add_argument(
        "--qqbot-token",
        default=DEFAULT_QQBOT_TOKEN,
        help="QQBot token AppID:AppSecret; or set QQBOT_TOKEN",
    )
    parser.add_argument("--instance-timeout", type=int, default=3600, help="default: 3600")
    parser.add_argument("--wait-timeout-seconds", type=int, default=300, help="default: 300")
    parser.add_argument("--wait-interval-seconds", type=int, default=3, help="default: 3")
    parser.add_argument("--http-timeout-seconds", type=int, default=30, help="default: 30")
    parser.add_argument("--cleanup-timeout-seconds", type=int, default=120, help="default: 120")
    parser.add_argument("--expected-base-url", default="", help="optional config assertion")
    parser.add_argument("--expected-model", default="kimi-k2.5", help='default: "kimi-k2.5"')
    parser.add_argument("--skip-log-snapshot", action="store_true", help="skip log snapshot collection")
    parser.add_argument("--keep-instance", action="store_true", help="do not delete the created instance")
    args = parser.parse_args()
    connection = resolve_testenv_connection(parser, args)

    user_id = resolve_test_user_id(parser, args.user_id, label="openclaw_qqbot_smoke", required=True)

    qqbot_token = args.qqbot_token.strip()
    if not qqbot_token:
        parser.error("--qqbot-token is required; pass AppID:AppSecret or set QQBOT_TOKEN")
    if ":" not in qqbot_token:
        parser.error("--qqbot-token must look like AppID:AppSecret")

    return SmokeConfig(
        base_url=connection.base_url,
        env_name=connection.env_name,
        kubeconfig=connection.kubeconfig,
        port_forward_port=connection.port_forward_port,
        requested_port_forward_port=connection.requested_port_forward_port,
        user_id=user_id,
        qqbot_token=qqbot_token,
        instance_timeout=args.instance_timeout,
        wait_timeout_seconds=args.wait_timeout_seconds,
        wait_interval_seconds=args.wait_interval_seconds,
        http_timeout_seconds=args.http_timeout_seconds,
        cleanup_timeout_seconds=args.cleanup_timeout_seconds,
        expected_base_url=args.expected_base_url.strip(),
        expected_model=args.expected_model.strip(),
        skip_log_snapshot=args.skip_log_snapshot,
        keep_instance=args.keep_instance,
    )


def main() -> int:
    cfg = parse_args()
    runner = SmokeRunner(cfg)
    return runner.run()


if __name__ == "__main__":
    sys.exit(main())
