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
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
import ssl


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Wait for Argo CD applications to converge after a merged GitOps MR and comment the result."
    )
    parser.add_argument("--api-base", default=os.environ.get("GIT_WOA_API_BASE"))
    parser.add_argument("--project-id", type=int, default=env_int("GITOPS_PROJECT_ID"))
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file", default="/etc/lightclaw-ci/git_woa_private_token")
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--argocd-base-url")
    parser.add_argument("--argocd-username")
    parser.add_argument("--argocd-password")
    parser.add_argument("--argocd-insecure-skip-verify", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=600)
    parser.add_argument("--poll-seconds", type=int, default=10)
    return parser.parse_args()


def env_int(name: str) -> int | None:
    value = os.environ.get(name, "").strip()
    return int(value) if value else None


def require_gongfeng_settings(args: argparse.Namespace) -> None:
    missing = []
    if not args.api_base:
        missing.append("GIT_WOA_API_BASE or --api-base")
    if args.project_id is None:
        missing.append("GITOPS_PROJECT_ID or --project-id")
    if missing:
        raise RuntimeError("missing Gongfeng settings: " + ", ".join(missing))


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


def resolve_string_setting(
    cli_value: Optional[str],
    env_name: str,
    file_path: str,
    default: str = "",
) -> str:
    if cli_value and cli_value.strip():
        return cli_value.strip()

    env_value = os.environ.get(env_name, "").strip()
    if env_value:
        return env_value

    file_candidate = Path(file_path)
    if file_candidate.is_file():
        return read_secret_value(str(file_candidate))

    return default.strip()


def resolve_bool_setting(cli_flag: bool, env_name: str, file_path: str, default: bool = False) -> bool:
    if cli_flag:
        return True

    env_value = os.environ.get(env_name, "").strip().lower()
    if env_value in {"1", "true", "yes", "on"}:
        return True
    if env_value in {"0", "false", "no", "off"}:
        return False

    file_candidate = Path(file_path)
    if file_candidate.is_file():
        file_value = read_secret_value(str(file_candidate)).strip().lower()
        if file_value in {"1", "true", "yes", "on"}:
            return True
        if file_value in {"0", "false", "no", "off"}:
            return False

    return default


def resolve_argocd_settings(args: argparse.Namespace) -> Tuple[str, str, str, ssl.SSLContext]:
    base_url = resolve_string_setting(
        args.argocd_base_url,
        "ARGOCD_BASE_URL",
        "/etc/lightclaw-ci/argocd_base_url",
        "https://argocd.lightclaw.tech",
    )
    username = resolve_string_setting(
        args.argocd_username,
        "ARGOCD_USERNAME",
        "/etc/lightclaw-ci/argocd_username",
    )
    password = resolve_string_setting(
        args.argocd_password,
        "ARGOCD_PASSWORD",
        "/etc/lightclaw-ci/argocd_password",
    )
    insecure_skip_verify = resolve_bool_setting(
        args.argocd_insecure_skip_verify,
        "ARGOCD_INSECURE_SKIP_VERIFY",
        "/etc/lightclaw-ci/argocd_insecure_skip_verify",
        False,
    )

    if not username or not password:
        raise RuntimeError(
            "missing Argo CD credentials; provide --argocd-username/--argocd-password, set ARGOCD_USERNAME/ARGOCD_PASSWORD, or populate /etc/lightclaw-ci/argocd_username and /etc/lightclaw-ci/argocd_password"
        )

    ssl_context = ssl._create_unverified_context() if insecure_skip_verify else ssl.create_default_context()
    return base_url.rstrip("/"), username, password, ssl_context


def api_request(method: str, url: str, private_token: str, form_data: Optional[Dict[str, Any]] = None) -> Any:
    headers = {"PRIVATE-TOKEN": private_token}
    data = None
    if form_data is not None:
        data = urllib.parse.urlencode(form_data).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        payload = resp.read().decode()
    return json.loads(payload) if payload else None


def argocd_api_request(
    method: str,
    url: str,
    ssl_context: ssl.SSLContext,
    token: str,
    form_data: Optional[Dict[str, Any]] = None,
) -> Any:
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if form_data is not None:
        data = json.dumps(form_data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=ssl_context) as resp:
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


def changed_files_from_recent_commits(repo_root: Path, max_count: int = 20) -> List[str]:
    commits_result = subprocess.run(
        ["git", "rev-list", "--max-count", str(max_count), "HEAD"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    commits = [line.strip() for line in commits_result.stdout.splitlines() if line.strip()]

    changed_files: List[str] = []
    seen: Set[str] = set()
    for commit in commits:
        result = subprocess.run(
            ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
        for line in result.stdout.splitlines():
            path = line.strip()
            if not path or path in seen:
                continue
            seen.add(path)
            changed_files.append(path)
    return changed_files


def infer_release_targets(changed_files: Sequence[str]) -> List[ReleaseTarget]:
    pattern = re.compile(r"^argocd/services/([^/]+)/([^/]+)/")
    ignored_env_dirs = {"common", "profiles"}
    seen: Set[Tuple[str, str]] = set()
    targets: List[ReleaseTarget] = []
    for path in changed_files:
        match = pattern.match(path)
        if not match:
            continue
        if match.group(2) in ignored_env_dirs:
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


def login_argocd(base_url: str, username: str, password: str, ssl_context: ssl.SSLContext) -> str:
    req = urllib.request.Request(
        f"{base_url}/api/v1/session",
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ssl_context) as resp:
        payload = json.loads(resp.read().decode())
    token = payload.get("token", "").strip()
    if not token:
        raise RuntimeError("argo cd login succeeded but no token was returned")
    return token


def argocd_get_application(
    base_url: str,
    ssl_context: ssl.SSLContext,
    token: str,
    app_name: str,
) -> Dict[str, Any]:
    try:
        apps_payload = argocd_api_request("GET", f"{base_url}/api/v1/applications", ssl_context, token)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(
            "argo applications list request failed via %s: http=%s body=%s"
            % (app_name, exc.code, body[:500])
        ) from exc

    items = apps_payload.get("items", [])
    for item in items:
        if item.get("metadata", {}).get("name") == app_name:
            return item

    visible_apps = sorted(item.get("metadata", {}).get("name", "") for item in items if item.get("metadata"))
    raise RuntimeError(
        "argo application %s not found via %s (visible apps sample: %s)"
        % (app_name, base_url, ", ".join(visible_apps[:20]))
    )


def short_revision(revision: str) -> str:
    return revision[:12] if revision else "-"


def join_values(values: Sequence[str]) -> str:
    return ",".join(values) if values else "-"


def format_convergence_log_line(
    snapshot: Dict[str, Any],
    expected_revision: str,
    expected_images: Sequence[str],
    elapsed_seconds: int,
    wait_seconds: int,
) -> str:
    return (
        "argo convergence poll: "
        f"app={snapshot.get('app_name', '-')} "
        f"elapsed={elapsed_seconds}/{wait_seconds}s "
        f"revision={short_revision(str(snapshot.get('revision') or ''))} "
        f"expected_revision={short_revision(expected_revision)} "
        f"sync={snapshot.get('sync_status') or '-'} "
        f"health={snapshot.get('health_status') or '-'} "
        f"expected_images={join_values(expected_images)} "
        f"live_images={join_values(snapshot.get('images', []))}"
    )


def wait_for_application_convergence(
    argocd_base_url: str,
    ssl_context: ssl.SSLContext,
    token: str,
    target: ReleaseTarget,
    merge_commit_sha: str,
    expected_images: Sequence[str],
    wait_seconds: int,
    poll_seconds: int,
) -> Dict[str, Any]:
    started_at = time.time()
    deadline = started_at + wait_seconds
    last_snapshot: Dict[str, Any] = {}

    while time.time() < deadline:
        app = argocd_get_application(argocd_base_url, ssl_context, token, target.app_name)
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
        elapsed_seconds = int(time.time() - started_at)
        print(
            format_convergence_log_line(
                last_snapshot,
                expected_revision=merge_commit_sha,
                expected_images=expected_images,
                elapsed_seconds=elapsed_seconds,
                wait_seconds=wait_seconds,
            ),
            flush=True,
        )

        if (
            revision == merge_commit_sha
            and sync_status == "Synced"
            and health_status == "Healthy"
            and set(expected_images).issubset(image_set)
        ):
            print(
                "argo convergence passed: app=%s elapsed=%s/%ss revision=%s sync=%s health=%s"
                % (
                    target.app_name,
                    elapsed_seconds,
                    wait_seconds,
                    short_revision(revision),
                    sync_status,
                    health_status,
                ),
                flush=True,
            )
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


def main() -> int:
    args = parse_args()
    require_gongfeng_settings(args)
    repo_root = Path(args.repo_root).resolve()
    private_token = resolve_private_token(args)
    argocd_base_url, argocd_username, argocd_password, ssl_context = resolve_argocd_settings(args)
    argocd_token = login_argocd(argocd_base_url, argocd_username, argocd_password, ssl_context)
    merged_mr = resolve_merged_mr(args, private_token)

    changed_files = changed_files_from_head(repo_root)
    targets = infer_release_targets(changed_files)
    if not targets:
        changed_files = changed_files_from_recent_commits(repo_root)
        targets = infer_release_targets(changed_files)
    if not targets:
        raise RuntimeError("no argocd/services/<service>/<env>/ changes found in promote branch commits")

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
                argocd_base_url=argocd_base_url,
                ssl_context=ssl_context,
                token=argocd_token,
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
