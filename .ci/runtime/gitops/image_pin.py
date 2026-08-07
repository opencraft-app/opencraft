"""
Update deploy-facing image pin files under argocd/services/<service>/<env>.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update an ArgoCD platform env image pin")
    parser.add_argument("--repo-root", default=".", help="Repository root containing argocd/")
    parser.add_argument("--service", required=True, help="Service directory under argocd/services/")
    parser.add_argument("--env", required=True, help="Target env")
    parser.add_argument("--image", required=True, help="Pinned image reference or JSON payload with images mapping")
    parser.add_argument("--deployed-at", required=True, help="Deploy timestamp, typically CI_JOB_STARTED_AT")
    return parser.parse_args()


# 同一个 env 目录下可以有多份 platform env：一份主的 `<svc>-platform.env`，
# 外加按工作负载切分的 `<svc>-platform-<variant>.env`（cloudladdergateway 的
# testing / staging 实例就是这么区分的，它们和 prod 共用一个 namespace）。
#
# 历史上这里只 glob `*-platform.env`，结构上匹配不到带 variant 后缀的文件，
# 导致那些工作负载的镜像 pin 永远不会被自动更新（clgateway testing 从 2026-06
# 起就冻结在一个连 master 都没有的镜像上）。
PLATFORM_ENV_PATTERN = re.compile(r"^(?P<prefix>.+?)-platform(?:-[A-Za-z0-9]+)?\.env$")


def resolve_platform_envs(repo_root: Path, service: str, env: str) -> list[Path]:
    service_dir = repo_root / "argocd" / "services" / service / env
    candidates = sorted(
        path for path in service_dir.glob("*-platform*.env") if PLATFORM_ENV_PATTERN.match(path.name)
    )
    if not candidates:
        raise FileNotFoundError(f"expected at least one *-platform*.env under {service_dir}")
    return candidates


def key_prefix_from_path(path: Path) -> str:
    match = PLATFORM_ENV_PATTERN.match(path.name)
    if match:
        # variant 后缀不进 key：`<svc>-platform-testing.env` 里的键仍然是 `<SVC>_IMAGE`。
        return match.group("prefix").upper().replace("-", "_")
    stem = path.name[:-4] if path.name.endswith(".env") else path.name
    prefix = stem[:-9] if stem.endswith("-platform") else stem
    return prefix.upper().replace("-", "_")


def has_env_key(content: str, key: str) -> bool:
    return re.search(rf"^{re.escape(key)}=", content, re.MULTILINE) is not None


def upsert_env_line(content: str, key: str, value: str) -> str:
    line = f"{key}={value}"
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(content):
        return pattern.sub(line, content, count=1)
    suffix = "" if content.endswith("\n") or not content else "\n"
    return f"{content}{suffix}{line}\n"


def parse_image_payload(raw_image: str, platform_env: Path) -> dict[str, str]:
    raw = raw_image.strip()
    if raw.startswith("{"):
        payload: Any = json.loads(raw)
        images = payload.get("images") if isinstance(payload, dict) else None
        if not isinstance(images, dict) or not images:
            raise ValueError("image JSON payload must contain a non-empty images object")
        return {str(key): str(value) for key, value in images.items()}

    prefix = key_prefix_from_path(platform_env)
    return {f"{prefix}_IMAGE": raw_image}


def deployed_at_key_for_image_key(image_key: str) -> str:
    if image_key.endswith("_IMAGE"):
        return f"{image_key[:-6]}_DEPLOYED_AT"
    return f"{image_key}_DEPLOYED_AT"


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    try:
        platform_envs = resolve_platform_envs(repo_root, args.service, args.env)
        payloads = [(path, parse_image_payload(args.image, path)) for path in platform_envs]
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    multiple = len(platform_envs) > 1
    for platform_env, images in payloads:
        content = platform_env.read_text()
        updated = content
        for image_key, image in images.items():
            # 只有一份 platform env 时保持原有 upsert 语义（允许首次新增键）。
            # 有多份时只更新该文件里已经存在的键，避免把某个工作负载的键写进别的文件。
            if multiple and not has_env_key(content, image_key):
                continue
            updated = upsert_env_line(updated, image_key, image)
            updated = upsert_env_line(
                updated, deployed_at_key_for_image_key(image_key), args.deployed_at
            )
        if updated != content:
            platform_env.write_text(updated)
        print(platform_env)
    return 0
