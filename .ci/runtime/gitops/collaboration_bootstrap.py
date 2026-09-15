"""Project the two-phase Collaboration Beijing release into GitOps files."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import yaml


ENV = "beijing-sandbox"
IMAGE_RE = re.compile(
    r"^lightclaw-bj8[.]tencentcloudcr[.]com/lightclaw/collaboration@sha256:[0-9a-f]{64}$"
)
ADMIN_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
PLATFORM_KEYS = (
    "COLLABORATION_IMAGE",
    "COLLABORATION_DEPLOYED_AT",
    "COLLABORATION_NODE_POOL",
    "COLLABORATION_IM_SDK_APP_ID",
    "COLLABORATION_IM_ADMIN_USER_ID",
)


def project(
    *,
    repo_root: Path,
    phase: str,
    image: str,
    sdk_app_id: int,
    im_admin_user_id: str,
    deployed_at: str,
) -> list[str]:
    repo_root = repo_root.resolve()
    if phase not in {"foundation", "runtime"}:
        raise ValueError("phase must be foundation or runtime")
    if not IMAGE_RE.fullmatch(image):
        raise ValueError("Collaboration image must be the Beijing repository pinned by digest")
    if sdk_app_id <= 0:
        raise ValueError("Tencent IM SDKAppID must be positive")
    if not ADMIN_RE.fullmatch(im_admin_user_id):
        raise ValueError("Tencent IM administrator ID is invalid")
    if not RFC3339_RE.fullmatch(deployed_at):
        raise ValueError("deployed_at must use UTC RFC3339 seconds")

    candidate_dir = repo_root / "argocd/catalogs/candidates" / ENV
    active = repo_root / "argocd/catalogs/sandbox" / ENV / "collaboration.yaml"
    foundation_candidate = candidate_dir / "collaboration-foundation.yaml"
    runtime_candidate = candidate_dir / "collaboration.yaml"
    platform = repo_root / "argocd/services/collaboration" / ENV / "collaboration-platform.env"
    secret = repo_root / "argocd/secrets" / ENV / "collaboration-runtime-secrets.sops.yaml"

    _validate_sops(secret)
    _validate_candidate(foundation_candidate, "argocd/services/collaboration/beijing-sandbox-foundation")
    _validate_candidate(runtime_candidate, "argocd/services/collaboration/beijing-sandbox")
    if phase == "runtime":
        if not active.is_file():
            raise ValueError("runtime projection requires an existing foundation active catalog")
        current = yaml.safe_load(active.read_text()) or {}
        if current.get("sourcePath") != "argocd/services/collaboration/beijing-sandbox-foundation":
            raise ValueError("runtime projection requires the active catalog to point to foundation")

    source = foundation_candidate if phase == "foundation" else runtime_candidate
    active.parent.mkdir(parents=True, exist_ok=True)
    active.write_text(source.read_text())
    _write_platform_values(
        platform,
        {
            "COLLABORATION_IMAGE": image,
            "COLLABORATION_DEPLOYED_AT": deployed_at,
            "COLLABORATION_NODE_POOL": "general-bj8",
            "COLLABORATION_IM_SDK_APP_ID": str(sdk_app_id),
            "COLLABORATION_IM_ADMIN_USER_ID": im_admin_user_id,
        },
    )
    return [
        str(active.relative_to(repo_root)),
        str(platform.relative_to(repo_root)),
        str(secret.relative_to(repo_root)),
    ]


def _validate_candidate(path: Path, source_path: str) -> None:
    if not path.is_file():
        raise ValueError(f"missing Collaboration candidate: {path}")
    value = yaml.safe_load(path.read_text()) or {}
    expected = {
        "service": "collaboration",
        "env": ENV,
        "project": ENV,
        "destinationName": ENV,
        "namespace": "lightvela-collaboration",
        "sourcePath": source_path,
    }
    if value != expected:
        raise ValueError(f"Collaboration candidate contract mismatch: {path}")


def _validate_sops(path: Path) -> None:
    if not path.is_file():
        raise ValueError("Collaboration SOPS artifact is missing")
    text = path.read_text()
    if "ENC[" not in text or re.search(r"(?m)^sops:\s*$", text) is None:
        raise ValueError("Collaboration SOPS artifact is not encrypted")


def _write_platform_values(path: Path, values: dict[str, str]) -> None:
    if not path.is_file():
        raise ValueError("Collaboration platform env is missing")
    seen: set[str] = set()
    output: list[str] = []
    for raw in path.read_text().splitlines():
        key = raw.split("=", 1)[0]
        if key in values:
            if key in seen:
                raise ValueError(f"duplicate Collaboration platform key: {key}")
            output.append(f"{key}={values[key]}")
            seen.add(key)
        else:
            output.append(raw)
    missing = set(PLATFORM_KEYS) - seen
    if missing:
        raise ValueError(f"missing Collaboration platform keys: {sorted(missing)}")
    path.write_text("\n".join(output) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--phase", choices=("foundation", "runtime"), required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--sdk-app-id", type=int, required=True)
    parser.add_argument("--im-admin-user-id", required=True)
    parser.add_argument("--deployed-at", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    changed = project(
        repo_root=args.repo_root,
        phase=args.phase,
        image=args.image,
        sdk_app_id=args.sdk_app_id,
        im_admin_user_id=args.im_admin_user_id,
        deployed_at=args.deployed_at,
    )
    print(json.dumps({"phase": args.phase, "changed_paths": changed}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
