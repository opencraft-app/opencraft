#!/usr/bin/env python3
"""
Update deploy-facing image pin files under argocd/services/<service>/<env>.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Update an ArgoCD platform env image pin")
    parser.add_argument("--repo-root", default=".", help="Repository root containing argocd/")
    parser.add_argument("--service", required=True, help="Service directory under argocd/services/")
    parser.add_argument("--env", required=True, help="Target env")
    parser.add_argument("--image", required=True, help="Pinned image reference")
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
    stem = path.name.removesuffix(".env")
    prefix = stem.removesuffix("-platform")
    return prefix.upper().replace("-", "_")


def upsert_env_line(content: str, key: str, value: str) -> str:
    line = f"{key}={value}"
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    if pattern.search(content):
        return pattern.sub(line, content, count=1)
    suffix = "" if content.endswith("\n") or not content else "\n"
    return f"{content}{suffix}{line}\n"


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    try:
        platform_env = resolve_platform_env(repo_root, args.service, args.env)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    prefix = key_prefix_from_path(platform_env)
    content = platform_env.read_text()
    content = upsert_env_line(content, f"{prefix}_IMAGE", args.image)
    content = upsert_env_line(content, f"{prefix}_DEPLOYED_AT", args.deployed_at)
    platform_env.write_text(content)
    print(platform_env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
