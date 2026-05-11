"""Image release gate execution."""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ImageGateResult:
    status: str
    pin_payload: str
    digests_json: str


def run_image_gate(*, repo_root: Path, runtime_command_dir: Path, env: str, image: str) -> ImageGateResult:
    print("============================================================", file=sys.stderr)
    print("GitOps 发布门禁：校验目标镜像是否已存在", file=sys.stderr)
    print(f"目标环境：{env}", file=sys.stderr)
    print(f"目标镜像：{image}", file=sys.stderr)
    print("说明：GitOps pin 只能写入已存在于镜像仓库的 tag；缺失时停止 promote，避免 Argo 拉取 ImagePullBackOff。", file=sys.stderr)
    print("============================================================", file=sys.stderr)

    script = (
        'source "$1/.ci/init.sh"\n'
        'ci_set_registry_credentials "$2"\n'
        'python3 "$3/verify_image_exists.py" --image "$4" --format dotenv\n'
    )
    result = subprocess.run(
        ["bash", "-c", script, "bash", str(repo_root), env, str(runtime_command_dir), image],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    if result.returncode != 0:
        if result.stdout:
            print(result.stdout, file=sys.stderr, end="")
        raise RuntimeError("镜像存在性门禁失败；不会写 GitOps pin，也不会创建 promote MR。")

    image_env = _parse_dotenv(result.stdout)
    if image_env.get("IMAGE_EXISTS") != "true":
        raise RuntimeError("镜像存在性门禁失败；verify_image_exists.py 未确认所有镜像存在。")
    if not image_env.get("IMAGE_PIN_PAYLOAD"):
        raise RuntimeError("镜像 digest 门禁失败；无法生成不可变 digest pin。")

    print("============================================================", file=sys.stderr)
    print("GitOps 发布门禁：镜像存在性校验通过", file=sys.stderr)
    print(f"镜像清单：{image_env.get('IMAGE_REFS_JSON', '[]')}", file=sys.stderr)
    print(f"镜像 digest：{image_env.get('IMAGE_DIGESTS_JSON', '{}')}", file=sys.stderr)
    print("============================================================", file=sys.stderr)
    return ImageGateResult(
        status="passed",
        pin_payload=image_env["IMAGE_PIN_PAYLOAD"],
        digests_json=image_env.get("IMAGE_DIGESTS_JSON", "{}"),
    )


def _parse_dotenv(output: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in output.splitlines():
        if not line.strip() or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip("'")
    return values
