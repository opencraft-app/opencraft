#!/usr/bin/env python3
"""CTL testenv pool-selection smoke.

脚本定义:
  在测试环境执行一次真实 CreateInstance，并收集“候选池排序/快照来源”证据。
  重点覆盖：
  1) 客户端无法正式指定 pool（附加字段会被忽略）
  2) service 侧是否使用 pressure snapshot 排序候选池
  3) bypass 是否持续刷新 pool pressure snapshot

参数定义:
  --base-url / --env / --kubeconfig / --port-forward-port:
    复用 testenv_runtime 的连接参数。
  --user-id:
    必填，测试用户（usr_*）。
  --instance-timeout:
    创建实例 timeout 秒数，默认 3600。
  --wait-timeout-seconds:
    等待终态超时，默认 180。
  --wait-interval-seconds:
    轮询间隔，默认 3。
  --allow-final-failed:
    允许最终状态为 Failed（共享环境不可控时用于留证）。
  --keep-instance:
    保留实例，不自动删除。

输出结果定义:
  - stdout 打印 CREATE 请求、选池日志、bypass 刷新日志、实例终态
  - exit 0: 满足断言
  - exit 1: 任一关键断言失败
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from testenv_runtime import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_AIGATEWAY_ADMIN_BASE_URL,
    DEFAULT_AIGATEWAY_ADMIN_TOKEN,
    DEFAULT_CTL_TEST_ENV_FILE,
    DEFAULT_PORT_FORWARD_PORT,
    DEFAULT_TEST_USER_ID,
    PortForwardManager,
    add_testenv_connection_args,
    ensure_aigateway_test_user,
    infer_default_aigateway_urls,
    load_env_file,
    request_json,
    resolve_testenv_connection,
    resolve_test_user_id,
)


class SmokeFailure(RuntimeError):
    pass


def resolve_kubeconfig_via_shell(env_name: str) -> str:
    if not env_name:
        return ""
    cmd = (
        f"source deploy/envs/{env_name}/platform.env >/dev/null 2>&1; "
        "printf '%s' \"${DEPLOY_KUBECONFIG:-}\""
    )
    try:
        output = subprocess.check_output(["bash", "-lc", cmd], text=True).strip()
        return output
    except subprocess.CalledProcessError:
        return ""


def kubectl_logs(
    *,
    kubeconfig: str,
    namespace: str,
    deploy: str,
    since: str,
) -> str:
    cmd = ["kubectl", "-n", namespace, "logs", f"deploy/{deploy}", f"--since={since}"]
    env = None
    if kubeconfig:
        env = {**os.environ, "KUBECONFIG": kubeconfig}
    last_output = ""
    for _ in range(3):
        try:
            return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, env=env)
        except subprocess.CalledProcessError as err:
            last_output = (err.output or "").strip()
            time.sleep(1)
    raise SmokeFailure(f"kubectl logs failed for {namespace}/{deploy}: {last_output}")


def poll_instance_final(
    *,
    base_url: str,
    user_id: str,
    instance_id: str,
    wait_timeout: int,
    wait_interval: int,
) -> dict[str, Any]:
    deadline = time.time() + wait_timeout
    while time.time() < deadline:
        response = request_json(
            "GET",
            f"{base_url}/v1/instances/{instance_id}",
            headers={
                "X-User-Id": user_id,
                "X-Request-Id": f"pool-smoke-get-{int(time.time())}",
            },
        )
        if response.status_code != 200 or response.data.get("code") != "OK":
            raise SmokeFailure(
                f"get instance failed: status={response.status_code}, body={response.body_text}"
            )
        data = response.data.get("data") or {}
        state = str(data.get("status", "")).strip()
        if state in {"Running", "Failed"}:
            return data
        time.sleep(wait_interval)
    raise SmokeFailure(f"wait instance final status timeout: {instance_id}")


def cleanup_instance(base_url: str, user_id: str, instance_id: str) -> None:
    try:
        request_json(
            "DELETE",
            f"{base_url}/v1/instances/{instance_id}",
            headers={
                "X-User-Id": user_id,
                "X-Request-Id": f"pool-smoke-delete-{int(time.time())}",
            },
        )
    except Exception:
        pass


def main() -> int:
    env_file_values = load_env_file(DEFAULT_CTL_TEST_ENV_FILE)
    inferred_admin_base_url, _ = infer_default_aigateway_urls()
    inferred_admin_base_url = inferred_admin_base_url.strip()
    if "${" in inferred_admin_base_url:
        inferred_admin_base_url = ""
    env_admin_base_url = env_file_values.get("CTL_TEST_AIGATEWAY_ADMIN_BASE_URL", "").strip()
    env_default_base_url = env_file_values.get("CTL_TEST_AIGATEWAY_DEFAULT_BASE_URL", "").strip()
    if env_default_base_url.endswith("/v1"):
        env_default_base_url = env_default_base_url.removesuffix("/v1")
    resolved_admin_base_url = (
        DEFAULT_AIGATEWAY_ADMIN_BASE_URL
        or env_admin_base_url
        or env_default_base_url
        or inferred_admin_base_url
    )

    parser = argparse.ArgumentParser(description="Smoke test CTL pool selection on testenv")
    add_testenv_connection_args(
        parser,
        default_base_url=DEFAULT_BASE_URL,
        default_port_forward_port=DEFAULT_PORT_FORWARD_PORT,
    )
    parser.add_argument(
        "--user-id",
        default=DEFAULT_TEST_USER_ID,
        help="可选 usr_*；默认自动生成临时测试用户，也可通过 CTL_TEST_USER_ID 注入",
    )
    parser.add_argument(
        "--skip-provision-user",
        action="store_true",
        help="跳过 ai-gateway 用户 provision；只适合你已确认 user_id 已存在",
    )
    parser.add_argument(
        "--aigateway-admin-base-url",
        default=resolved_admin_base_url,
        help=(
            "默认：CTL_TEST_AIGATEWAY_ADMIN_BASE_URL；"
            "其次 .secret/ctl/test.env 的 CTL_TEST_AIGATEWAY_ADMIN_BASE_URL / "
            "CTL_TEST_AIGATEWAY_DEFAULT_BASE_URL；最后从测试配置推导"
        ),
    )
    parser.add_argument(
        "--aigateway-admin-token",
        default=(DEFAULT_AIGATEWAY_ADMIN_TOKEN or env_file_values.get("CTL_TEST_AIGATEWAY_ADMIN_TOKEN", "")),
        help="默认：CTL_TEST_AIGATEWAY_ADMIN_TOKEN；若未设置则回退读取 .secret/ctl/test.env",
    )
    parser.add_argument("--instance-timeout", type=int, default=3600)
    parser.add_argument("--wait-timeout-seconds", type=int, default=180)
    parser.add_argument("--wait-interval-seconds", type=int, default=3)
    parser.add_argument("--allow-final-failed", action="store_true")
    parser.add_argument("--keep-instance", action="store_true")
    args = parser.parse_args()

    conn = resolve_testenv_connection(parser, args)
    if not conn.kubeconfig and conn.env_name:
        conn.kubeconfig = resolve_kubeconfig_via_shell(conn.env_name)
    base_url = conn.base_url.rstrip("/")
    user_id = resolve_test_user_id(parser, args.user_id, label="pool_selection_smoke", required=False)
    if not args.skip_provision_user:
        if "${" in args.aigateway_admin_base_url:
            parser.error("--aigateway-admin-base-url appears unresolved (contains ${...}); pass a concrete URL")
        if not args.aigateway_admin_base_url.strip():
            parser.error("--aigateway-admin-base-url is required when auto provisioning is enabled")
        if not args.aigateway_admin_token.strip():
            parser.error("--aigateway-admin-token is required when auto provisioning is enabled")

    port_forward = PortForwardManager(
        base_url=conn.base_url,
        env_name=conn.env_name,
        kubeconfig=conn.kubeconfig,
        port_forward_port=conn.port_forward_port,
        requested_port_forward_port=conn.requested_port_forward_port,
    )
    instance_id = ""

    try:
        port_forward.start()

        if not args.skip_provision_user:
            try:
                ensure_aigateway_test_user(
                    admin_base_url=args.aigateway_admin_base_url,
                    admin_token=args.aigateway_admin_token,  # pragma: allowlist secret
                    user_id=user_id,
                    nickname="ctl-pool-smoke",
                    request_id_prefix="pool-smoke-aigw",
                )
            except RuntimeError as err:
                raise SmokeFailure(f"ensure-user failed: {err}") from err
            print(f"PASS: ensure-user {user_id}")
        else:
            print(f"PASS: ensure-user skipped user_id={user_id}")

        health_resp = request_json(
            "GET",
            f"{base_url}/health",
            headers={"X-User-Id": user_id, "X-Request-Id": f"pool-smoke-health-{int(time.time())}"},
        )
        if health_resp.status_code != 200:
            raise SmokeFailure(f"health failed: status={health_resp.status_code}, body={health_resp.body_text}")
        print(f"PASS: health {health_resp.data}")

        create_body = {
            "timeout": int(args.instance_timeout),
            "pool": "pool-c0",
            "template_id": "pool-c0",
        }
        create_resp = request_json(
            "POST",
            f"{base_url}/v1/instances",
            headers={"X-User-Id": user_id, "X-Request-Id": f"pool-smoke-create-{int(time.time())}"},
            body=create_body,
        )
        if create_resp.status_code != 201 or create_resp.data.get("code") != "OK":
            raise SmokeFailure(
                f"create failed: status={create_resp.status_code}, body={create_resp.body_text}"
            )
        data = create_resp.data.get("data") or {}
        instance_id = str(data.get("instance_id", "")).strip()
        if not instance_id:
            raise SmokeFailure(f"create response missing instance_id: {create_resp.body_text}")
        print(f"PASS: create instance_id={instance_id}")
        print(f"EVIDENCE: create_request={json.dumps(create_body, ensure_ascii=False)}")
        print("EVIDENCE: create_api_accepted_unknown_pool_fields=true")

        final_data = poll_instance_final(
            base_url=base_url,
            user_id=user_id,
            instance_id=instance_id,
            wait_timeout=int(args.wait_timeout_seconds),
            wait_interval=int(args.wait_interval_seconds),
        )
        final_status = str(final_data.get("status", "")).strip()
        print(f"EVIDENCE: final_instance={json.dumps(final_data, ensure_ascii=False)}")
        if final_status != "Running" and not args.allow_final_failed:
            raise SmokeFailure(f"expected final Running, got {final_status}")
        if final_status == "Failed":
            print("WARN: final status is Failed (allowed by --allow-final-failed)")

        if not conn.kubeconfig:
            raise SmokeFailure("missing kubeconfig; cannot collect ctl-service/ctl-bypass logs")
        service_logs = kubectl_logs(
            kubeconfig=conn.kubeconfig,
            namespace="ctl",
            deploy="ctl-service",
            since="10m",
        )
        bypass_logs = kubectl_logs(
            kubeconfig=conn.kubeconfig,
            namespace="ctl",
            deploy="ctl-bypass",
            since="10m",
        )

        selected_lines = [
            line
            for line in service_logs.splitlines()
            if instance_id in line and "selected sandbox candidate pools for create" in line
        ]
        if not selected_lines:
            raise SmokeFailure("no selected sandbox candidate pools log found for instance")
        print("EVIDENCE: selected_pool_log")
        print(selected_lines[-1])

        snapshot_lines = [
            line
            for line in bypass_logs.splitlines()
            if "pool pressure snapshot refreshed" in line
        ]
        if not snapshot_lines:
            raise SmokeFailure("no bypass snapshot refresh log found")
        print("EVIDENCE: latest_bypass_snapshot_log")
        print(snapshot_lines[-1])

        print("PASS: pool-selection-smoke")
        return 0
    except SmokeFailure as err:
        print(f"FAIL: {err}", file=sys.stderr)
        return 1
    finally:
        if instance_id and not args.keep_instance:
            cleanup_instance(base_url, user_id, instance_id)
        port_forward.stop()


if __name__ == "__main__":
    raise SystemExit(main())
