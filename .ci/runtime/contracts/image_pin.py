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


def resolve_platform_env(repo_root: Path, service: str, env: str) -> Path:
    service_dir = repo_root / "argocd" / "services" / service / env
    candidates = sorted(service_dir.glob("*-platform.env"))
    if len(candidates) != 1:
        raise FileNotFoundError(
            f"expected exactly one *-platform.env under {service_dir}, found {len(candidates)}"
        )
    return candidates[0]


def key_prefix_from_path(path: Path) -> str:
    stem = path.name[:-4] if path.name.endswith(".env") else path.name
    prefix = stem[:-9] if stem.endswith("-platform") else stem
    return prefix.upper().replace("-", "_")


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
        platform_env = resolve_platform_env(repo_root, args.service, args.env)
        images = parse_image_payload(args.image, platform_env)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    content = platform_env.read_text()
    for image_key, image in images.items():
        content = upsert_env_line(content, image_key, image)
        content = upsert_env_line(content, deployed_at_key_for_image_key(image_key), args.deployed_at)
    platform_env.write_text(content)
    print(platform_env)
    return 0
