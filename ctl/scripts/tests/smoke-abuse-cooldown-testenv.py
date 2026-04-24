#!/usr/bin/env python3
"""CTL test-environment per-user abuse cooldown smoke runner.

脚本定义:
  针对测试环境 ctl-api 自动验证“用户高频 create/destroy 会触发 per-user abuse cooldown”。
  默认流程是：
  1. health 预检
  2. 连续执行 destroy_threshold 次 create -> running -> destroy
  3. 再执行 create_threshold - destroy_threshold 次 create -> running（保留实例）
  4. 下一次 create 必须返回 429 INSTANCE_CHURN_LIMITED，并带 Retry-After
  5. 立刻重试一次，确认 cooldown 已经生效
  6. 默认自动清理本脚本创建的实例

参数定义:
  --base-url                    ctl-api 基础地址。默认 http://127.0.0.1:19590
  --env                         可选；若填写则自动从 deploy/envs/<env>/platform.env 推导 kubeconfig 并启动 port-forward
  --kubeconfig                  可选；显式指定 kubectl 使用的 kubeconfig
  --port-forward-port           自动 port-forward 时绑定的本地端口。默认 19590
  --user-id                     必填，测试环境真实 usr_* user_id；也可用 CTL_TEST_USER_ID 注入
  --instance-timeout            create 时下发给实例的 timeout 秒数。默认 3600
  --create-threshold            预期 user abuse create 阈值。默认 10
  --destroy-threshold           预期 user abuse destroy 阈值。默认 8
  --wait-timeout-seconds        等待实例 Running/Deleted 的总超时。默认 300
  --wait-interval-seconds       状态轮询间隔。默认 3
  --http-timeout-seconds        单次 HTTP 请求超时。默认 30
  --verify-recovery             额外等待 cooldown 过期后，再验证一次 create 恢复成功
  --max-recovery-wait-seconds   verify-recovery 时允许等待的最长秒数。默认 720
  --allow-existing-instances    默认要求测试用户起跑前没有现存实例；开启后跳过该校验
  --keep-instance               失败时保留本脚本创建的实例，便于排障

输出结果定义:
  - stdout: 步骤级 PASS/INFO 日志和最终摘要
  - stderr: 失败步骤、HTTP 状态码、响应体和异常上下文
  - exit 0: abuse cooldown 行为符合预期
  - exit 1: 任一阶段失败

调用示例:
  python3 ctl/scripts/tests/smoke-abuse-cooldown-testenv.py \
    --env beijing-sandbox \
    --user-id usr_3929fd9d3a957ae7905aa058

  python3 ctl/scripts/tests/smoke-abuse-cooldown-testenv.py \
    --user-id usr_3929fd9d3a957ae7905aa058 \
    --verify-recovery \
    --max-recovery-wait-seconds 720
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from testenv_runtime import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_TEST_USER_ID,
    PortForwardManager,
    add_testenv_connection_args,
    create_operation_error,
    latest_create_operation,
    resolve_testenv_connection,
    resolve_test_user_id,
)


RETRYABLE_CLEANUP_STATUS_CODES = {502, 503, 504}
RETRYABLE_CLEANUP_CODES = {"SANDBOX_SERVICE_ERROR"}
MAX_CLEANUP_ATTEMPTS = 5
CLEANUP_RETRY_SECONDS = 3


class CooldownSmokeFailure(RuntimeError):
    """Raised when the abuse cooldown smoke fails."""


@dataclass
class HTTPResponse:
    status_code: int
    body_text: str
    data: dict[str, Any]
    headers: dict[str, str]


@dataclass
class SmokeConfig:
    base_url: str
    env_name: str
    kubeconfig: str
    port_forward_port: int
    requested_port_forward_port: int
    user_id: str
    instance_timeout: int
    create_threshold: int
    destroy_threshold: int
    wait_timeout_seconds: int
    wait_interval_seconds: int
    http_timeout_seconds: int
    verify_recovery: bool
    max_recovery_wait_seconds: int
    allow_existing_instances: bool
    keep_instance: bool


@dataclass
class CooldownSmokeRunner:
    cfg: SmokeConfig
    created_instance_ids: list[str] = field(default_factory=list)
    cleanup_failures: list[str] = field(default_factory=list)
    last_response: HTTPResponse | None = None
    _request_seq: int = 0
    port_forward: PortForwardManager | None = None

    def log(self, message: str) -> None:
        print(f"INFO: {message}", flush=True)

    def log_error(self, message: str) -> None:
        print(f"ERROR: {message}", file=sys.stderr, flush=True)

    def pass_step(self, name: str) -> None:
        print(f"PASS: {name}", flush=True)

    def ensure_port_forward_manager(self) -> PortForwardManager:
        if self.port_forward is None:
            self.port_forward = PortForwardManager(
                base_url=self.cfg.base_url,
                env_name=self.cfg.env_name,
                kubeconfig=self.cfg.kubeconfig,
                port_forward_port=self.cfg.port_forward_port,
                requested_port_forward_port=self.cfg.requested_port_forward_port,
            )
        return self.port_forward

    def next_request_id(self, label: str) -> str:
        self._request_seq += 1
        return f"abuse-cooldown-{label}-{int(time.time())}-{os.getpid()}-{self._request_seq}"

    def request(self, method: str, path: str, body: dict[str, Any] | None = None, *, label: str) -> HTTPResponse:
        url = self.cfg.base_url.rstrip("/") + path
        payload = None
        headers = {
            "X-User-Id": self.cfg.user_id,
            "X-Request-Id": self.next_request_id(label),
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url=url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.cfg.http_timeout_seconds) as resp:
                body_text = resp.read().decode("utf-8")
                status_code = resp.getcode()
                response_headers = dict(resp.headers.items())
        except urllib.error.HTTPError as err:
            status_code = err.code
            body_text = err.read().decode("utf-8")
            response_headers = dict(err.headers.items())
        except urllib.error.URLError as err:
            raise CooldownSmokeFailure(f"{label}: http request failed for {method} {path}: {err}") from err

        try:
            data = json.loads(body_text) if body_text else {}
        except json.JSONDecodeError as err:
            raise CooldownSmokeFailure(f"{label}: response is not valid json: {err}") from err

        result = HTTPResponse(
            status_code=status_code,
            body_text=body_text,
            data=data,
            headers={key.lower(): value for key, value in response_headers.items()},
        )
        self.last_response = result
        return result

    def expect_status(self, response: HTTPResponse, expected: int, label: str) -> None:
        if response.status_code != expected:
            raise CooldownSmokeFailure(
                f"{label}: expected http {expected}, got {response.status_code}, body={response.body_text}"
            )

    def expect_status_in(self, response: HTTPResponse, expected: set[int], label: str) -> None:
        if response.status_code not in expected:
            wanted = ", ".join(str(code) for code in sorted(expected))
            raise CooldownSmokeFailure(
                f"{label}: expected http in {{{wanted}}}, got {response.status_code}, body={response.body_text}"
            )

    def expect_success(self, response: HTTPResponse, label: str) -> dict[str, Any]:
        if response.data.get("code") != "OK" or response.data.get("message") != "success":
            raise CooldownSmokeFailure(f"{label}: expected success envelope, got body={response.body_text}")
        data = response.data.get("data")
        if not isinstance(data, dict):
            raise CooldownSmokeFailure(f"{label}: expected object data, got body={response.body_text}")
        return data

    def expect_limit_reject(self, response: HTTPResponse, label: str) -> int:
        self.expect_status(response, 429, label)
        if response.data.get("code") != "INSTANCE_CHURN_LIMITED":
            raise CooldownSmokeFailure(
                f"{label}: expected code=INSTANCE_CHURN_LIMITED, got body={response.body_text}"
            )
        retry_after = response.data.get("retry_after_seconds")
        if not isinstance(retry_after, int) or retry_after <= 0:
            raise CooldownSmokeFailure(
                f"{label}: expected positive retry_after_seconds, got body={response.body_text}"
            )
        header_retry_after = response.headers.get("retry-after", "").strip()
        if header_retry_after != str(retry_after):
            raise CooldownSmokeFailure(
                f"{label}: retry-after header/body mismatch, header={header_retry_after!r}, body={retry_after!r}"
            )
        return retry_after

    def run_health_check(self) -> None:
        response = self.request("GET", "/health", label="health")
        self.expect_status(response, 200, "health")
        if response.data.get("code") != "OK":
            raise CooldownSmokeFailure(f"health: expected code=OK, got body={response.body_text}")
        self.pass_step("health")

    def run_list_soul_templates(self) -> None:
        response = self.request("GET", "/v1/soul-templates", label="list-soul-templates")
        self.expect_status(response, 200, "list-soul-templates")
        data = self.expect_success(response, "list-soul-templates")
        items = data.get("items")
        if not isinstance(items, list) or not items:
            raise CooldownSmokeFailure(
                f"list-soul-templates: expected non-empty items, body={response.body_text}"
            )
        for item in items:
            if not isinstance(item, dict):
                raise CooldownSmokeFailure(
                    f"list-soul-templates: expected object item, body={response.body_text}"
                )
            if not str(item.get("id", "")).strip():
                raise CooldownSmokeFailure(
                    f"list-soul-templates: empty id, body={response.body_text}"
                )
            if not str(item.get("name", "")).strip() or not str(item.get("description", "")).strip():
                raise CooldownSmokeFailure(
                    f"list-soul-templates: empty name/description, body={response.body_text}"
                )
        self.pass_step("list-soul-templates")

    def assert_user_is_clean(self) -> None:
        if self.cfg.allow_existing_instances:
            self.log("allow-existing-instances enabled, skipping preflight list check")
            return
        response = self.request("GET", "/v1/instances?page=1&page_size=20", label="preflight-list")
        self.expect_status(response, 200, "preflight-list")
        data = self.expect_success(response, "preflight-list")
        items = data.get("items", [])
        if not isinstance(items, list):
            raise CooldownSmokeFailure("preflight-list: items is not a list")
        blocking_items = [
            item
            for item in items
            if str(item.get("status", "")) not in {"Failed", "Deleted", "DeleteFailed"}
        ]
        if blocking_items:
            ids = [
                f"{item.get('instance_id', '')}:{item.get('status', '')}"
                for item in blocking_items
            ]
            raise CooldownSmokeFailure(
                "preflight-list: expected no active existing instances; use a clean usr_* user or pass --allow-existing-instances. "
                f"blocking={ids}"
            )
        ignored_items = [
            f"{item.get('instance_id', '')}:{item.get('status', '')}"
            for item in items
            if str(item.get("status", "")) in {"Failed", "Deleted", "DeleteFailed"}
        ]
        if ignored_items:
            self.log(f"preflight-list: ignoring historical terminal instances: {ignored_items}")
        self.pass_step("preflight-list")

    def create_instance(self, label: str) -> str:
        response = self.request(
            "POST",
            "/v1/instances",
            {"timeout": self.cfg.instance_timeout},
            label=label,
        )
        self.expect_status_in(response, {200, 201}, label)
        data = self.expect_success(response, label)
        instance_id = str(data.get("instance_id") or "")
        if not instance_id:
            raise CooldownSmokeFailure(f"{label}: empty instance_id, body={response.body_text}")
        self.created_instance_ids.append(instance_id)
        self.log(f"{label}: instance created {instance_id}")
        return instance_id

    def list_operations(self, instance_id: str, label: str) -> list[dict[str, Any]]:
        response = self.request(
            "GET",
            f"/v1/instances/{instance_id}/operations?page=1&page_size=20",
            label=label,
        )
        self.expect_status(response, 200, label)
        data = self.expect_success(response, label)
        items = data.get("items")
        if not isinstance(items, list):
            raise CooldownSmokeFailure(f"{label}: expected list items, body={response.body_text}")
        return [item for item in items if isinstance(item, dict)]

    def wait_for_create_operation_success(self, instance_id: str, label: str) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        consecutive_success = 0
        last_status = ""
        while time.time() < deadline:
            op = latest_create_operation(self.list_operations(instance_id, label))
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
                raise CooldownSmokeFailure(
                    f"{label}: CREATE failed: {create_operation_error(op)}"
                )
            time.sleep(self.cfg.wait_interval_seconds)
        raise CooldownSmokeFailure(
            f"{label}: timeout waiting for CREATE success, last_status={last_status or 'missing'}"
        )

    def wait_for_status(self, instance_id: str, expected_status: str, label: str) -> None:
        deadline = time.time() + self.cfg.wait_timeout_seconds
        last_status = ""
        while time.time() < deadline:
            response = self.request("GET", f"/v1/instances/{instance_id}", label=label)
            if response.status_code == 404 and expected_status == "Deleted":
                return
            self.expect_status(response, 200, label)
            data = self.expect_success(response, label)
            last_status = str(data.get("status", ""))
            if last_status == expected_status:
                return
            if last_status in {"Failed", "CreateFailed", "DeleteFailed"}:
                raise CooldownSmokeFailure(
                    f"{label}: instance {instance_id} entered terminal status {last_status}"
                )
            time.sleep(self.cfg.wait_interval_seconds)
        raise CooldownSmokeFailure(
            f"{label}: timeout waiting for instance {instance_id} status={expected_status}, last_status={last_status}"
        )

    def destroy_instance(self, instance_id: str, label: str) -> None:
        response = self.request("DELETE", f"/v1/instances/{instance_id}", label=label)
        self.expect_status(response, 200, label)
        data = self.expect_success(response, label)
        if str(data.get("status", "")) != "Deleting":
            raise CooldownSmokeFailure(f"{label}: expected Deleting, got body={response.body_text}")
        self.wait_for_status(instance_id, "Deleted", f"{label}-wait")
        self.pass_step(label)

    def destroy_instance_for_cleanup(self, instance_id: str) -> None:
        label = f"cleanup-{instance_id}"
        last_error = ""
        for attempt in range(1, MAX_CLEANUP_ATTEMPTS + 1):
            attempt_label = f"{label}-attempt-{attempt}"
            response = self.request("DELETE", f"/v1/instances/{instance_id}", label=attempt_label)
            if response.status_code == 404 and response.data.get("code") == "NOT_FOUND":
                self.log(f"{label}: instance already gone, skipping delete")
                self.pass_step(label)
                return
            if response.status_code == 200:
                data = self.expect_success(response, attempt_label)
                if str(data.get("status", "")) != "Deleting":
                    raise CooldownSmokeFailure(f"{attempt_label}: expected Deleting, got body={response.body_text}")
                self.wait_for_status(instance_id, "Deleted", f"{label}-wait")
                self.pass_step(label)
                return

            last_error = (
                f"{attempt_label}: expected http 200, got {response.status_code}, body={response.body_text}"
            )
            if (
                response.status_code in RETRYABLE_CLEANUP_STATUS_CODES
                and str(response.data.get("code", "")) in RETRYABLE_CLEANUP_CODES
                and attempt < MAX_CLEANUP_ATTEMPTS
            ):
                self.log(
                    f"{label}: transient delete failure on attempt {attempt}/{MAX_CLEANUP_ATTEMPTS}, "
                    f"retrying in {CLEANUP_RETRY_SECONDS}s"
                )
                time.sleep(CLEANUP_RETRY_SECONDS)
                continue
            break

        raise CooldownSmokeFailure(last_error or f"{label}: cleanup failed without a response body")

    def remove_tracked_instance(self, instance_id: str) -> None:
        self.created_instance_ids = [item for item in self.created_instance_ids if item != instance_id]

    def run_destroy_cycles(self) -> None:
        for index in range(1, self.cfg.destroy_threshold + 1):
            instance_id = self.create_instance(f"destroy-cycle-create-{index}")
            self.wait_for_status(instance_id, "Running", f"destroy-cycle-wait-{index}")
            self.wait_for_create_operation_success(instance_id, f"destroy-cycle-create-op-{index}")
            self.destroy_instance(instance_id, f"destroy-cycle-destroy-{index}")
            self.remove_tracked_instance(instance_id)
        self.pass_step("destroy-cycles")

    def run_create_only_cycles(self) -> None:
        remaining_creates = self.cfg.create_threshold - self.cfg.destroy_threshold
        if remaining_creates < 0:
            raise CooldownSmokeFailure(
                "create-threshold must be greater than or equal to destroy-threshold"
            )
        for index in range(1, remaining_creates + 1):
            instance_id = self.create_instance(f"create-only-cycle-create-{index}")
            self.wait_for_status(instance_id, "Running", f"create-only-cycle-wait-{index}")
            self.wait_for_create_operation_success(instance_id, f"create-only-cycle-create-op-{index}")
        self.pass_step("create-only-cycles")

    def verify_cooldown_rejects(self) -> int:
        response = self.request(
            "POST",
            "/v1/instances",
            {"timeout": self.cfg.instance_timeout},
            label="trigger-cooldown",
        )
        retry_after = self.expect_limit_reject(response, "trigger-cooldown")
        self.pass_step("trigger-cooldown")

        retry_response = self.request(
            "POST",
            "/v1/instances",
            {"timeout": self.cfg.instance_timeout},
            label="retry-during-cooldown",
        )
        second_retry_after = self.expect_limit_reject(retry_response, "retry-during-cooldown")
        if second_retry_after > retry_after:
            raise CooldownSmokeFailure(
                "retry-during-cooldown: expected retry_after_seconds to stay the same or decrease"
            )
        self.pass_step("retry-during-cooldown")
        return retry_after

    def verify_recovery(self, retry_after: int) -> None:
        if not self.cfg.verify_recovery:
            self.log("verify-recovery disabled, skipping cooldown expiry wait")
            return
        wait_seconds = min(retry_after + 2, self.cfg.max_recovery_wait_seconds)
        if wait_seconds < retry_after:
            raise CooldownSmokeFailure(
                f"verify-recovery: retry_after={retry_after}s exceeds max-recovery-wait-seconds={self.cfg.max_recovery_wait_seconds}"
            )
        self.log(f"waiting {wait_seconds}s for cooldown expiry")
        time.sleep(wait_seconds)
        instance_id = self.create_instance("post-cooldown-create")
        self.wait_for_status(instance_id, "Running", "post-cooldown-wait")
        self.wait_for_create_operation_success(instance_id, "post-cooldown-create-op")
        self.pass_step("post-cooldown-create")

    def cleanup(self) -> None:
        if self.cfg.keep_instance:
            if self.created_instance_ids:
                self.log(f"keep-instance enabled, leaving instances intact: {self.created_instance_ids}")
            return
        for instance_id in reversed(self.created_instance_ids):
            try:
                self.destroy_instance_for_cleanup(instance_id)
            except CooldownSmokeFailure as err:
                message = str(err)
                self.cleanup_failures.append(message)
                self.log_error(message)
        self.created_instance_ids.clear()

    def run(self) -> int:
        self.log(
            "starting abuse cooldown smoke "
            f"base_url={self.cfg.base_url} user_id={self.cfg.user_id} "
            f"create_threshold={self.cfg.create_threshold} destroy_threshold={self.cfg.destroy_threshold}"
        )
        exit_code = 0
        try:
            try:
                self.ensure_port_forward_manager().start()
            except RuntimeError as err:
                raise CooldownSmokeFailure(str(err)) from err
            if not self.cfg.user_id.strip():
                raise CooldownSmokeFailure("user_id is required; pass --user-id with a real usr_* user id")
            self.run_health_check()
            self.run_list_soul_templates()
            self.assert_user_is_clean()
            self.run_destroy_cycles()
            self.run_create_only_cycles()
            retry_after = self.verify_cooldown_rejects()
            self.verify_recovery(retry_after)
        except CooldownSmokeFailure as err:
            exit_code = 1
            self.log_error(str(err))
            if self.last_response is not None:
                self.log_error(
                    f"http_status={self.last_response.status_code} body={self.last_response.body_text}"
                )
        finally:
            self.cleanup()
            if self.port_forward is not None:
                self.port_forward.stop()
        if self.cleanup_failures:
            exit_code = 1
        return exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="验证测试环境 ctl-api 的 per-user abuse cooldown 保护。"
    )
    add_testenv_connection_args(parser)
    parser.add_argument(
        "--user-id",
        default=DEFAULT_TEST_USER_ID,
        help="必填，测试环境真实 usr_* user_id；也可通过 CTL_TEST_USER_ID 注入",
    )
    parser.add_argument(
        "--instance-timeout",
        type=int,
        default=3600,
        help="create 时下发的实例 timeout 秒数，默认: 3600",
    )
    parser.add_argument(
        "--create-threshold",
        type=int,
        default=10,
        help="预期 user abuse create 阈值，默认: 10",
    )
    parser.add_argument(
        "--destroy-threshold",
        type=int,
        default=8,
        help="预期 user abuse destroy 阈值，默认: 8",
    )
    parser.add_argument(
        "--wait-timeout-seconds",
        type=int,
        default=300,
        help="等待实例 Running/Deleted 的总超时，默认: 300",
    )
    parser.add_argument(
        "--wait-interval-seconds",
        type=int,
        default=3,
        help="状态轮询间隔，默认: 3",
    )
    parser.add_argument(
        "--http-timeout-seconds",
        type=int,
        default=30,
        help="单次 HTTP 请求超时，默认: 30",
    )
    parser.add_argument(
        "--verify-recovery",
        action="store_true",
        help="额外等待 cooldown 过期后，再验证一次 create 恢复成功",
    )
    parser.add_argument(
        "--max-recovery-wait-seconds",
        type=int,
        default=720,
        help="verify-recovery 时允许等待的最长秒数，默认: 720",
    )
    parser.add_argument(
        "--allow-existing-instances",
        action="store_true",
        help="跳过用户无现存实例的预检；默认保守失败，避免和已有资源互相干扰",
    )
    parser.add_argument(
        "--keep-instance",
        action="store_true",
        help="失败时不自动删除本脚本创建的实例，便于排障",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    connection = resolve_testenv_connection(parser, args)
    user_id = resolve_test_user_id(parser, args.user_id, label="abuse_cooldown_smoke", required=True)
    cfg = SmokeConfig(
        base_url=connection.base_url,
        env_name=connection.env_name,
        kubeconfig=connection.kubeconfig,
        port_forward_port=connection.port_forward_port,
        requested_port_forward_port=connection.requested_port_forward_port,
        user_id=user_id,
        instance_timeout=args.instance_timeout,
        create_threshold=args.create_threshold,
        destroy_threshold=args.destroy_threshold,
        wait_timeout_seconds=args.wait_timeout_seconds,
        wait_interval_seconds=args.wait_interval_seconds,
        http_timeout_seconds=args.http_timeout_seconds,
        verify_recovery=args.verify_recovery,
        max_recovery_wait_seconds=args.max_recovery_wait_seconds,
        allow_existing_instances=args.allow_existing_instances,
        keep_instance=args.keep_instance,
    )
    if cfg.create_threshold <= 0 or cfg.destroy_threshold <= 0:
        parser.error("--create-threshold and --destroy-threshold must be positive")
    if cfg.create_threshold < cfg.destroy_threshold:
        parser.error("--create-threshold must be >= --destroy-threshold")
    if cfg.wait_timeout_seconds <= 0 or cfg.wait_interval_seconds <= 0:
        parser.error("--wait-timeout-seconds and --wait-interval-seconds must be positive")
    if cfg.http_timeout_seconds <= 0:
        parser.error("--http-timeout-seconds must be positive")
    if cfg.max_recovery_wait_seconds <= 0:
        parser.error("--max-recovery-wait-seconds must be positive")
    runner = CooldownSmokeRunner(cfg)
    return runner.run()


if __name__ == "__main__":
    sys.exit(main())
