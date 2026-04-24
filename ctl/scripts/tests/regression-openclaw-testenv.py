#!/usr/bin/env python3
"""Full CTL test-environment API regression runner.

脚本定义:
  对已部署的测试环境 ctl-api 执行一套自动化优先的 API 回归，覆盖：
  health -> create -> list -> get -> debug/exec -> pause -> resume -> timeout ->
  operations -> logs -> destroy。
  这套回归默认不包含 QQBot / 微信登录等需要额外凭证或人工参与的专项链路。

参数定义:
  --base-url                  ctl-api 基础地址。默认 http://127.0.0.1:19590
  --env                       可选；若填写则自动从 deploy/envs/<env>/platform.env 推导 kubeconfig 并启动 port-forward
  --kubeconfig                可选；显式指定 kubectl 使用的 kubeconfig
  --port-forward-port         自动 port-forward 时绑定的本地端口。默认 19590
  --user-id                   必填，测试环境真实 usr_* user_id；也可用 CTL_TEST_USER_ID 注入
  --create-timeout            创建实例 timeout 秒数。默认 3600
  --resume-timeout            resume 时的 timeout 秒数。默认 1800
  --set-timeout               timeout 接口下发秒数。默认 1200
  --wait-timeout-seconds      等待实例状态推进的总超时。默认 300
  --wait-interval-seconds     状态轮询间隔。默认 3
  --http-timeout-seconds      单次 HTTP 请求超时。默认 30
  --request-id                固定请求 ID；默认自动生成
  --keep-instance             失败时保留实例，便于继续排障

输出结果定义:
  - stdout: 步骤级 PASS/SKIP 日志和最终摘要
  - stderr: 失败步骤、HTTP 状态码、响应体和异常上下文
  - 退出码 0 表示回归通过，非 0 表示至少一项失败
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from local_api_runner import LocalAPIRunner, add_common_args, config_from_args
from testenv_runtime import DEFAULT_PORT_FORWARD_PORT, PortForwardManager, resolve_testenv_connection


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="全量验证测试环境 ctl-api 的自动化 API 回归。"
    )
    add_common_args(parser)
    parser.add_argument("--env", default="", help="auto port-forward env, e.g. beijing-sandbox")
    parser.add_argument("--kubeconfig", default="", help="optional kubeconfig path for auto port-forward")
    parser.add_argument(
        "--port-forward-port",
        type=int,
        default=DEFAULT_PORT_FORWARD_PORT,
        help=f"default: {DEFAULT_PORT_FORWARD_PORT}",
    )
    parser.set_defaults(
        base_url="http://127.0.0.1:19590",
        create_timeout=3600,
        resume_timeout=1800,
        set_timeout=1200,
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    connection = resolve_testenv_connection(parser, args)
    args.base_url = connection.base_url
    cfg = config_from_args(args, mode="testenv-regression")
    cfg.verify_operations = True
    cfg.verify_logs = True
    cfg.verify_quota_exhausted = False
    cfg.skip_template_config_check = True
    cfg.skip_sandbox_connectivity_check = True
    cfg.verify_create_operation_success = True
    cfg.wait_timeout_seconds = 300
    cfg.wait_interval_seconds = 3
    port_forward = PortForwardManager(
        base_url=connection.base_url,
        env_name=connection.env_name,
        kubeconfig=connection.kubeconfig,
        port_forward_port=connection.port_forward_port,
        requested_port_forward_port=connection.requested_port_forward_port,
    )
    runner = LocalAPIRunner(cfg)
    try:
        port_forward.start()
        return runner.run_regression()
    except RuntimeError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 1
    finally:
        port_forward.stop()


if __name__ == "__main__":
    sys.exit(main())
