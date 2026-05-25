"""Production environment selection helpers for service release pipelines."""

from __future__ import annotations

import argparse
import sys


PROD_ENVS = {"shprod", "sgprod"}


def split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def resolve_prod_promote_envs(build_envs: str, auto_pin_envs: str) -> list[str]:
    auto_pin_disabled = auto_pin_envs.strip() == "none"
    auto_pin_targets = set(split_csv(auto_pin_envs))
    result: list[str] = []
    for env_name in split_csv(build_envs):
        if env_name not in PROD_ENVS:
            continue
        if not auto_pin_disabled and env_name in auto_pin_targets:
            print(f"skip {env_name}: it is already in MASTER_AUTO_PIN_ENVS", file=sys.stderr, flush=True)
            continue
        result.append(env_name)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve production envs that need manual promote.")
    parser.add_argument("--build-envs", required=True)
    parser.add_argument("--auto-pin-envs", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    for env_name in resolve_prod_promote_envs(args.build_envs, args.auto_pin_envs):
        print(env_name)
    return 0
