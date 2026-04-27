#!/usr/bin/env python3
"""
Validate that a merged GitOps MR has converged in Argo CD and annotate the MR.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Wait for Argo CD applications to converge after a merged GitOps MR and comment the result."
    )
    parser.add_argument("--api-base", default="https://git.woa.com/api/v3")
    parser.add_argument("--project-id", type=int, default=1731878)
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--namespace", default="argocd")
    parser.add_argument("--kubeconfig")
    parser.add_argument("--wait-seconds", type=int, default=600)
    parser.add_argument("--poll-seconds", type=int, default=10)
    return parser.parse_args()


@dataclass(frozen=True)
class ReleaseTarget:
    service: str
    env: str

    @property
    def app_name(self) -> str:
        return f"{self.service}-{self.env}"


def read_secret_value(path: str) -> str:
    with open(path, "r") as fh:
        return fh.read().strip()


def resolve_private_token(args: argparse.Namespace) -> str:
    if args.private_token:
        return args.private_token.strip()

    try:
        return read_secret_value(args.private_token_file)
    except FileNotFoundError:
        pass

    env_token = os.environ.get("GIT_WOA_PRIVATE_TOKEN", "").strip()
    if env_token:
        return env_token

    raise RuntimeError(
        "missing Git WOA token; provide --private-token, ensure %s exists, or set GIT_WOA_PRIVATE_TOKEN"
        % args.private_token_file
    )


def api_request(method: str, url: str, private_token: str, form_data: Optional[Dict[str, Any]] = None) -> Any:
    headers = {"PRIVATE-TOKEN": private_token}
    data = None
    if form_data is not None:
        data = urllib.parse.urlencode(form_data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        payload = resp.read().decode()
    return json.loads(payload) if payload else None


def list_merge_requests(
    api_base: str, project_id: int, private_token: str, state: str, source_branch: str, target_branch: str
) -> List[Dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "state": state,
            "source_branch": source_branch,
            "target_branch": target_branch,
        }
    )
    url = f"{api_base}/projects/{project_id}/merge_requests?{params}"
    return api_request("GET", url, private_token)


def resolve_merged_mr(args: argparse.Namespace, private_token: str) -> Dict[str, Any]:
    merged = list_merge_requests(
        args.api_base, args.project_id, private_token, "merged", args.source_branch, args.target_branch
    )
    if not merged:
        raise RuntimeError(
            "no merged GitOps MR found for %s -> %s" % (args.source_branch, args.target_branch)
        )
    return merged[0]


def post_merge_request_note(
    api_base: str, project_id: int, private_token: str, mr_id: int, body: str
) -> Dict[str, Any]:
    url = f"{api_base}/projects/{project_id}/merge_requests/{mr_id}/notes"
    return api_request("POST", url, private_token, {"body": body})


def changed_files_from_head(repo_root: Path) -> List[str]:
    result = subprocess.run(
        ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def infer_release_targets(changed_files: Sequence[str]) -> List[ReleaseTarget]:
    pattern = re.compile(r"^argocd/services/([^/]+)/([^/]+)/")
    seen: Set[Tuple[str, str]] = set()
    targets: List[ReleaseTarget] = []
    for path in changed_files:
        match = pattern.match(path)
        if not match:
            continue
        pair = (match.group(1), match.group(2))
        if pair in seen:
            continue
        seen.add(pair)
        targets.append(ReleaseTarget(service=pair[0], env=pair[1]))
    return targets


def expected_images_for_target(repo_root: Path, target: ReleaseTarget) -> List[str]:
    env_files = sorted((repo_root / "argocd" / "services" / target.service / target.env).glob("*-platform.env"))
    if not env_files:
        raise RuntimeError(f"missing platform env for {target.service}/{target.env}")

    image_values: List[str] = []
    for env_file in env_files:
        for raw_line in env_file.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.endswith("_IMAGE"):
                image_values.append(value.strip())
    unique_images = sorted({value for value in image_values if value})
    if not unique_images:
        raise RuntimeError(f"no *_IMAGE entries found in {env_files[0]}")
    return unique_images


def resolve_kubeconfig(args: argparse.Namespace, repo_root: Path) -> str:
    explicit = (args.kubeconfig or os.environ.get("ARGOCD_CONTROL_PLANE_KUBECONFIG", "")).strip()
    if explicit:
        return explicit

    default_repo_file = repo_root / "hk-cls-mp5b5r0y-extranet.kubeconfig"
    if default_repo_file.is_file():
        return str(default_repo_file)

    inherited = os.environ.get("KUBECONFIG", "").strip()
    if inherited:
        return inherited

    raise RuntimeError(
        "missing kubeconfig; pass --kubeconfig, set ARGOCD_CONTROL_PLANE_KUBECONFIG, or provide repo root hk-cls-mp5b5r0y-extranet.kubeconfig"
    )


def kubectl_get_application(kubeconfig: str, namespace: str, app_name: str) -> Dict[str, Any]:
    result = subprocess.run(
        [
            "kubectl",
            f"--kubeconfig={kubeconfig}",
            "-n",
            namespace,
            "get",
            "applications.argoproj.io",
            app_name,
            "-o",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def wait_for_application_convergence(
    kubeconfig: str,
    namespace: str,
    target: ReleaseTarget,
    merge_commit_sha: str,
    expected_images: Sequence[str],
    wait_seconds: int,
    poll_seconds: int,
) -> Dict[str, Any]:
    deadline = time.time() + wait_seconds
    last_snapshot: Dict[str, Any] = {}

    while time.time() < deadline:
        app = kubectl_get_application(kubeconfig, namespace, target.app_name)
        status = app.get("status", {})
        sync = status.get("sync", {})
        health = status.get("health", {})
        summary = status.get("summary", {})
        images = summary.get("images") or []
        image_set = set(images)
        revision = sync.get("revision", "")
        sync_status = sync.get("status", "")
        health_status = health.get("status", "")

        last_snapshot = {
            "app_name": target.app_name,
            "revision": revision,
            "sync_status": sync_status,
            "health_status": health_status,
            "images": sorted(images),
        }

        if (
            revision == merge_commit_sha
            and sync_status == "Synced"
            and health_status == "Healthy"
            and set(expected_images).issubset(image_set)
        ):
            return last_snapshot

        time.sleep(poll_seconds)

    raise RuntimeError(
        "application %s did not converge within %ss: revision=%s sync=%s health=%s images=%s expected=%s"
        % (
            target.app_name,
            wait_seconds,
            last_snapshot.get("revision"),
            last_snapshot.get("sync_status"),
            last_snapshot.get("health_status"),
            ",".join(last_snapshot.get("images", [])),
            ",".join(expected_images),
        )
    )


def format_success_note(mr: Dict[str, Any], results: Sequence[Dict[str, Any]]) -> str:
    lines = [
        "自动验收通过：Argo CD 已收敛到目标 revision，且 live workload image 匹配本次 GitOps 发布。",
        "",
        f"- MR: !{mr.get('iid')}",
        f"- merge commit: `{mr.get('merge_commit_sha')}`",
        "",
        "| App | Revision | Sync | Health | Expected images |",
        "| --- | --- | --- | --- | --- |",
    ]
    for result in results:
        expected = "<br/>".join(result["expected_images"])
        lines.append(
            f"| `{result['app_name']}` | `{result['revision']}` | `{result['sync_status']}` | `{result['health_status']}` | `{expected}` |"
        )
    return "\n".join(lines)


def format_failure_note(mr: Dict[str, Any], error: str, partial_results: Sequence[Dict[str, Any]]) -> str:
    lines = [
        "自动验收失败：GitOps MR 已合并，但 Argo CD 收敛状态未达到预期。",
        "",
        f"- MR: !{mr.get('iid')}",
        f"- merge commit: `{mr.get('merge_commit_sha')}`",
        f"- error: `{error}`",
    ]
    if partial_results:
        lines.extend(
            [
                "",
                "| App | Revision | Sync | Health | Expected images |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for result in partial_results:
            expected = "<br/>".join(result["expected_images"])
            lines.append(
                f"| `{result['app_name']}` | `{result['revision']}` | `{result['sync_status']}` | `{result['health_status']}` | `{expected}` |"
            )
    return "\n".join(lines)


def format_waiting_note(mr: Dict[str, Any], targets: Sequence[ReleaseTarget]) -> str:
    target_names = ", ".join(f"`{target.app_name}`" for target in targets)
    return "\n".join(
        [
            "自动验收进度：已开始等待 Argo CD 收敛。",
            "",
            f"- MR: !{mr.get('iid')}",
            f"- merge commit: `{mr.get('merge_commit_sha')}`",
            f"- target apps: {target_names}",
            "- 目标条件：`Synced / Healthy` 且 `status.summary.images` 包含本次发布镜像",
        ]
    )


def ensure_commands(commands: Iterable[str]) -> None:
    for command in commands:
        if not shutil.which(command):
            raise RuntimeError(f"missing required command: {command}")


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    private_token = resolve_private_token(args)
    kubeconfig = resolve_kubeconfig(args, repo_root)
    merged_mr = resolve_merged_mr(args, private_token)

    changed_files = changed_files_from_head(repo_root)
    targets = infer_release_targets(changed_files)
    if not targets:
        raise RuntimeError("no argocd/services/<service>/<env>/ changes found in promote commit")

    post_merge_request_note(
        args.api_base,
        args.project_id,
        private_token,
        merged_mr["id"],
        format_waiting_note(merged_mr, targets),
    )

    partial_results: List[Dict[str, Any]] = []
    try:
        for target in targets:
            expected_images = expected_images_for_target(repo_root, target)
            snapshot = wait_for_application_convergence(
                kubeconfig=kubeconfig,
                namespace=args.namespace,
                target=target,
                merge_commit_sha=merged_mr["merge_commit_sha"],
                expected_images=expected_images,
                wait_seconds=args.wait_seconds,
                poll_seconds=args.poll_seconds,
            )
            snapshot["expected_images"] = expected_images
            partial_results.append(snapshot)

        note = format_success_note(merged_mr, partial_results)
        post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        print(note)
        return 0
    except Exception as exc:  # noqa: BLE001
        note = format_failure_note(merged_mr, str(exc), partial_results)
        try:
            post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        except Exception as note_exc:  # noqa: BLE001
            print(f"failed to post MR note after verification error: {note_exc}", file=sys.stderr)
        print(note, file=sys.stderr)
        raise


if __name__ == "__main__":
    import shutil

    raise SystemExit(main())
