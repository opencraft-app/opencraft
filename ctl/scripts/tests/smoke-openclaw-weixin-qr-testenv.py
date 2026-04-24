#!/usr/bin/env python3
"""CTL test-environment Weixin QR smoke runner.

脚本定义:
  对已部署的测试环境 ctl-api 执行“实例创建 -> 微信 login-session -> 获取二维码”的专项验证。
  这条链路用于确认：
  1. ctl-api 能创建微信登录 session
  2. sandbox 内 openclaw-weixin 登录命令能正常产出二维码信息
  3. session snapshot 能返回 qr_url 或 qr_ascii
  默认在拿到二维码后自动取消 session 并删除实例；若指定 --keep-instance，则保留实例和登录 session 以便人工继续扫码。

参数定义:
  --base-url                  ctl-api 基础地址。默认 http://127.0.0.1:19590
  --env                       可选；若填写则自动从 deploy/envs/<env>/platform.env 推导 kubeconfig 并启动 port-forward
  --kubeconfig                可选；显式指定 kubectl 使用的 kubeconfig
  --port-forward-port         自动 port-forward 时绑定的本地端口。默认 19590
  --user-id                   可选；不传时自动生成临时 usr_* user_id
  --skip-provision-user       跳过 ai-gateway 用户 provision；只适合你已确认 user_id 已存在
  --aigateway-admin-base-url  ai-gateway admin 基础地址；默认优先取环境变量，其次从 ctl 测试配置推导
  --aigateway-admin-token     ai-gateway admin token；默认优先取环境变量，其次从 .secret/ctl/test.env 读取
  --instance-timeout          创建实例时下发的 timeout 秒数。默认 3600
  --wait-timeout-seconds      等待实例 Running 的总超时。默认 300
  --wait-interval-seconds     轮询间隔。默认 3
  --weixin-wait-timeout-seconds 等待微信二维码出现的总超时。默认 90
  --http-timeout-seconds      单次 HTTP 请求超时。默认 30
  --cleanup-timeout-seconds   删除实例后的等待超时。默认 120
  --keep-instance             保留实例和登录 session，不做自动清理

输出结果定义:
  - stdout: 打印 PASS/FAIL、实例 ID、session ID、二维码摘要；若有 qr_ascii，会原样打印在 QR-ASCII-BEGIN/END 之间
  - stderr: 打印 HTTP 错误、失败细节和清理异常
  - exit 0: 成功拿到二维码
  - exit 1: 任一阶段失败

示例:
  python3 ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py \
    --env beijing-sandbox \
    --keep-instance

  python3 ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py \
    --base-url http://127.0.0.1:19590 \
    --keep-instance

  若使用 --keep-instance，脚本成功后会打印 user_id、instance_id 和 session_id。
  看完二维码后，可手动清理：

  curl -X POST http://127.0.0.1:19590/v1/instances/<instance_id>/channels/weixin/login-sessions/<session_id>/cancel \
    -H 'X-User-Id: <printed_user_id>'

  curl -X DELETE http://127.0.0.1:19590/v1/instances/<instance_id> \
    -H 'X-User-Id: <printed_user_id>'
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
    aigateway_admin_base_url: str
    aigateway_admin_token: str
    aigateway_port_forward_port: int
    requested_aigateway_port_forward_port: int
    instance_timeout: int
    wait_timeout_seconds: int
    wait_interval_seconds: int
    weixin_wait_timeout_seconds: int
    http_timeout_seconds: int
    cleanup_timeout_seconds: int
    keep_instance: bool


class SmokeRunner:
    def __init__(self, cfg: SmokeConfig) -> None:
        self.cfg = cfg
        self.instance_id = ""
        self.session_id = ""
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
        request_id_prefix: str = "weixin-qr-smoke",
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

    def ensure_test_user(self) -> None:
        if not self.cfg.user_id:
            try:
                resolved = resolve_test_user_for_smoke(
                    preferred_user_id="",
                    skip_provision_user=self.cfg.skip_provision_user,
                    admin_base_url=self.cfg.aigateway_admin_base_url,
                    admin_token=self.cfg.aigateway_admin_token,  # pragma: allowlist secret
                    ctl_base_url=self.cfg.base_url,
                    generated_user_label="weixin_qr_smoke",
                    provision_nickname="ctl-weixin-smoke",
                    request_id_prefix="weixin-qr-smoke-aigw",
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
        instance_id = str(data.get("instance_id", "")).strip()
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

    def create_weixin_session(self) -> None:
        response = self.request(
            "POST",
            f"/v1/instances/{self.instance_id}/channels/weixin/login-sessions",
            {},
        )
        self.expect_status(response, 200, "create-weixin-session")
        data = self.expect_ok_envelope(response, "create-weixin-session")
        session_id = str(data.get("session_id", "")).strip()
        status = str(data.get("status", "")).strip()
        if not session_id:
            raise SmokeFailure(f"create-weixin-session: empty session_id, body={response.body_text}")
        if status != "starting":
            raise SmokeFailure(f"create-weixin-session: expected starting, got status={status}")
        self.session_id = session_id
        self.log(f"weixin session created: {self.session_id}")
        self.pass_step("create-weixin-session")

    def get_weixin_session(self) -> dict[str, Any]:
        response = self.request(
            "GET",
            f"/v1/instances/{self.instance_id}/channels/weixin/login-sessions/{self.session_id}",
        )
        self.expect_status(response, 200, "get-weixin-session")
        return self.expect_ok_envelope(response, "get-weixin-session")

    def print_qr_result(self, data: dict[str, Any]) -> None:
        status = str(data.get("status", "")).strip()
        qr_url = str(data.get("qr_url", "")).strip()
        qr_ascii = str(data.get("qr_ascii", "")).rstrip()
        self.log(f"weixin session status={status} session_id={self.session_id}")
        if qr_url:
            print(f"QR-URL: {qr_url}", flush=True)
        if qr_ascii:
            print("QR-ASCII-BEGIN", flush=True)
            print(qr_ascii, flush=True)
            print("QR-ASCII-END", flush=True)

    def wait_for_weixin_qr(self) -> None:
        deadline = time.time() + self.cfg.weixin_wait_timeout_seconds
        last_status = ""
        while time.time() < deadline:
            data = self.get_weixin_session()
            last_status = str(data.get("status", "")).strip()
            qr_url = str(data.get("qr_url", "")).strip()
            qr_ascii = str(data.get("qr_ascii", "")).strip()
            if last_status in {"waiting_qr", "scanned", "success"} and (qr_url or qr_ascii):
                self.print_qr_result(data)
                self.pass_step("wait-weixin-qr")
                return
            if last_status in {"failed", "expired", "cancelled", "timeout"}:
                raise SmokeFailure(
                    f"wait-weixin-qr: session ended early with status={last_status}"
                )
            time.sleep(self.cfg.wait_interval_seconds)
        raise SmokeFailure(f"wait-weixin-qr: timeout, last_status={last_status}")

    def cleanup_weixin_session(self) -> None:
        if not self.instance_id or not self.session_id or self.cfg.keep_instance:
            if self.instance_id and self.session_id and self.cfg.keep_instance:
                self.log(
                    "keep-instance enabled, leaving "
                    f"user_id={self.cfg.user_id} instance_id={self.instance_id} "
                    f"session_id={self.session_id} intact"
                )
            return
        response = self.request(
            "POST",
            f"/v1/instances/{self.instance_id}/channels/weixin/login-sessions/{self.session_id}/cancel",
        )
        self.expect_status(response, 200, "cancel-weixin-session")
        self.expect_ok_envelope(response, "cancel-weixin-session")
        self.pass_step("cancel-weixin-session")
        self.session_id = ""

    def cleanup_instance(self) -> None:
        if not self.instance_id or self.cfg.keep_instance:
            return
        response = self.request("DELETE", f"/v1/instances/{self.instance_id}")
        self.expect_status(response, 200, "delete-instance")
        self.expect_ok_envelope(response, "delete-instance")
        deadline = time.time() + self.cfg.cleanup_timeout_seconds
        while time.time() < deadline:
            response = self.request("GET", f"/v1/instances/{self.instance_id}")
            if response.status_code == 404 or response.data.get("code") == "NOT_FOUND":
                self.pass_step("delete-instance")
                self.instance_id = ""
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
        self.create_weixin_session()
        self.wait_for_weixin_qr()

    def cleanup_after_run(self) -> None:
        try:
            self.cleanup_weixin_session()
        except SmokeFailure as err:
            self.log_error(str(err))
            if not self.cfg.keep_instance:
                self.log_error("manual weixin session cleanup may be required")
        try:
            self.cleanup_instance()
        except SmokeFailure as err:
            self.log_error(str(err))
            if not self.cfg.keep_instance:
                self.log_error("manual instance cleanup may be required")
        finally:
            self.aigateway_port_forward.stop()
            self.port_forward.stop()

    def run(self) -> int:
        try:
            self.run_once()
            return 0
        except SmokeFailure as err:
            self.log_error(str(err))
            return 1
        finally:
            self.cleanup_after_run()


def parse_args() -> SmokeConfig:
    env_file_values = load_env_file(DEFAULT_CTL_TEST_ENV_FILE)

    parser = argparse.ArgumentParser(
        description="Run the CTL test-environment Weixin QR smoke."
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
        "--aigateway-admin-base-url",
        default="",
        help="optional override; otherwise auto-resolve from env/platform/test config",
    )
    parser.add_argument(
        "--aigateway-admin-token",
        default=(DEFAULT_AIGATEWAY_ADMIN_TOKEN or env_file_values.get("CTL_TEST_AIGATEWAY_ADMIN_TOKEN", "")),
        help="default: CTL_TEST_AIGATEWAY_ADMIN_TOKEN or .secret/ctl/test.env",
    )
    parser.add_argument("--instance-timeout", type=int, default=3600, help="default: 3600")
    parser.add_argument("--wait-timeout-seconds", type=int, default=300, help="default: 300")
    parser.add_argument("--wait-interval-seconds", type=int, default=3, help="default: 3")
    parser.add_argument("--weixin-wait-timeout-seconds", type=int, default=90, help="default: 90")
    parser.add_argument("--http-timeout-seconds", type=int, default=30, help="default: 30")
    parser.add_argument("--cleanup-timeout-seconds", type=int, default=120, help="default: 120")
    parser.add_argument("--keep-instance", action="store_true", help="do not cancel session or delete the created instance")
    args = parser.parse_args()
    connection = resolve_testenv_connection(parser, args)
    platform_env_values = load_env_file(Path("deploy") / "envs" / connection.env_name / "platform.env") if connection.env_name else {}
    resolved_endpoints = resolve_aigateway_endpoints(
        env_file_values=env_file_values,
        platform_env_values=platform_env_values,
    )

    user_id = normalize_optional_test_user_id(parser, args.user_id)
    resolved_admin_base_url = args.aigateway_admin_base_url.strip() or resolved_endpoints.admin_base_url
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

    return SmokeConfig(
        base_url=connection.base_url,
        env_name=connection.env_name,
        kubeconfig=connection.kubeconfig,
        port_forward_port=connection.port_forward_port,
        requested_port_forward_port=connection.requested_port_forward_port,
        user_id=user_id,
        user_source="explicit" if user_id else "",
        skip_provision_user=args.skip_provision_user,
        aigateway_admin_base_url=resolved_admin_base_url,
        aigateway_admin_token=args.aigateway_admin_token.strip(),
        aigateway_port_forward_port=aigateway_port_forward_port,
        requested_aigateway_port_forward_port=requested_aigateway_port_forward_port,
        instance_timeout=args.instance_timeout,
        wait_timeout_seconds=args.wait_timeout_seconds,
        wait_interval_seconds=args.wait_interval_seconds,
        weixin_wait_timeout_seconds=args.weixin_wait_timeout_seconds,
        http_timeout_seconds=args.http_timeout_seconds,
        cleanup_timeout_seconds=args.cleanup_timeout_seconds,
        keep_instance=args.keep_instance,
    )


def main() -> int:
    cfg = parse_args()
    runner = SmokeRunner(cfg)
    return runner.run()


if __name__ == "__main__":
    sys.exit(main())
