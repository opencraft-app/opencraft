#!/usr/bin/env python3
"""Smoke walkthrough for local ctl API.

脚本定义:
  快速验证 ctl 本地 API、异步 worker 和云端 sandbox 主链路是否可用。
  默认只覆盖最小闭环，不包含配额打满等重场景。
  可选开启微信 login-session 二维码验证。

参数定义:
  继承 local_api_runner 的公共参数。

输出结果定义:
  - stdout: 步骤级检查结果与最终摘要
  - stderr: 失败上下文
  - 退出码 0 表示 smoke 通过，非 0 表示至少一项失败

示例:
  python3 ctl/scripts/tests/smoke_local_api.py
  python3 ctl/scripts/tests/smoke_local_api.py --user-id usr_local_smoke --keep-instance
  python3 ctl/scripts/tests/smoke_local_api.py --verify-weixin-login
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from local_api_runner import LocalAPIRunner, add_common_args, config_from_args


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "快速验证 ctl 本地 REST API 与 sandbox 联调主链路。"
            "默认覆盖 health/create/get/debug/destroy，可选验证微信二维码。"
        )
    )
    add_common_args(parser)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    runner = LocalAPIRunner(config_from_args(args, mode="smoke"))
    return runner.run_smoke()


if __name__ == "__main__":
    sys.exit(main())
