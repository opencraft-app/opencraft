"""
Validate that a merged GitOps MR has converged in Argo CD and annotate the MR.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Sequence, Set, Tuple
import ssl

from gitops.argocd import api_request as argocd_api_request
from gitops.argocd import login as login_argocd
from gitops.argocd import resolve_settings as resolve_argocd_settings
from gitops.git import lines as git_lines
from gitops.git import output as git_output
from gitops.git import run as git_run
from gitops.gongfeng import (
    api_json_request,
    env_int,
    merge_request_note_url,
    merge_requests_url,
    require_settings_from_args,
    resolve_private_token_from_args,
)
from gitops.release_facts import ReleaseFacts, release_facts_from_mapping, trailers_from_git
from gitops.release_view import (
    render_argo_success_note,
    render_argo_waiting_note,
    render_failure_note,
    render_merge_only_note,
    render_noop_note,
)


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
    parser.add_argument("--merge-wait-seconds", type=int, default=0)
    parser.add_argument("--merge-poll-seconds", type=int, default=10)
    parser.add_argument(
        "--merge-only",
        action="store_true",
        help="Only verify that the GitOps MR merged; do not wait for Argo sync/convergence.",
    )
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


def list_merge_requests(
    api_base: str, project_id: int, private_token: str, state: str, source_branch: str, target_branch: str
) -> List[Dict[str, Any]]:
    url = merge_requests_url(api_base, project_id, state=state, source_branch=source_branch, target_branch=target_branch)
    return api_json_request("GET", url, private_token)


def resolve_merged_mr(args: argparse.Namespace, private_token: str) -> Dict[str, Any]:
    deadline = time.time() + max(args.merge_wait_seconds, 0)
    attempt = 0
    while True:
        attempt += 1
        merged = list_merge_requests(
            args.api_base, args.project_id, private_token, "merged", args.source_branch, args.target_branch
        )
        if merged:
            return merged[0]
        if time.time() >= deadline:
            raise RuntimeError(
                "no merged GitOps MR found for %s -> %s" % (args.source_branch, args.target_branch)
            )
        print(
            "waiting for GitOps MR merge: attempt=%s source_branch=%s target_branch=%s"
            % (attempt, args.source_branch, args.target_branch),
            file=sys.stderr,
        )
        time.sleep(max(args.merge_poll_seconds, 1))


def post_merge_request_note(
    api_base: str, project_id: int, private_token: str, mr_id: int, body: str
) -> Dict[str, Any]:
    return api_json_request("POST", merge_request_note_url(api_base, project_id, mr_id), private_token, {"body": body})


def changed_files_from_head(repo_root: Path) -> List[str]:
    return git_lines(repo_root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")


def changed_files_from_recent_commits(repo_root: Path, max_count: int = 20) -> List[str]:
    changed_files: List[str] = []
    seen: Set[str] = set()
    for commit in git_lines(repo_root, "rev-list", "--max-count", str(max_count), "HEAD"):
        for path in git_lines(repo_root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit):
            if path in seen:
                continue
            seen.add(path)
            changed_files.append(path)
    return changed_files


def ensure_commit_available(repo_root: Path, revision: str, target_branch: str) -> None:
    try:
        git_output(repo_root, "cat-file", "-e", f"{revision}^{{commit}}", strip=True)
        return
    except subprocess.CalledProcessError:
        pass

    git_run(repo_root, "fetch", "origin", target_branch)
    git_output(repo_root, "cat-file", "-e", f"{revision}^{{commit}}", strip=True)


def changed_files_from_merge_commit(repo_root: Path, merge_commit_sha: str, target_branch: str) -> List[str]:
    ensure_commit_available(repo_root, merge_commit_sha, target_branch)
    parents_line = git_output(repo_root, "rev-list", "--parents", "-n", "1", merge_commit_sha, strip=True)
    revisions = parents_line.split()
    if len(revisions) >= 2:
        base_revision = revisions[1]
    else:
        base_revision = f"{merge_commit_sha}^"

    return git_lines(repo_root, "diff", "--name-only", base_revision, merge_commit_sha)


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


def _facts_or_empty(facts: ReleaseFacts | None = None) -> ReleaseFacts:
    return facts or release_facts_from_mapping({})


def format_success_note(
    mr: Dict[str, Any],
    results: Sequence[Dict[str, Any]],
    facts: ReleaseFacts | None = None,
) -> str:
    return render_argo_success_note(_facts_or_empty(facts), mr, results)


def format_noop_note(mr: Dict[str, Any], facts: ReleaseFacts | None = None) -> str:
    return render_noop_note(_facts_or_empty(facts), mr)


def format_merge_only_note(
    mr: Dict[str, Any],
    targets: Sequence[ReleaseTarget],
    facts: ReleaseFacts | None = None,
) -> str:
    return render_merge_only_note(_facts_or_empty(facts), mr, targets)


def format_failure_note(
    mr: Dict[str, Any],
    error: str,
    partial_results: Sequence[Dict[str, Any]],
    facts: ReleaseFacts | None = None,
) -> str:
    return render_failure_note(_facts_or_empty(facts), mr, error, partial_results)


def format_waiting_note(
    mr: Dict[str, Any],
    targets: Sequence[ReleaseTarget],
    facts: ReleaseFacts | None = None,
) -> str:
    return render_argo_waiting_note(_facts_or_empty(facts), mr, targets)


def main() -> int:
    args = parse_args()
    require_settings_from_args(args)
    repo_root = Path(args.repo_root).resolve()
    private_token = resolve_private_token_from_args(args)
    facts = trailers_from_git(repo_root)
    merged_mr = resolve_merged_mr(args, private_token)

    changed_files = changed_files_from_merge_commit(
        repo_root,
        merged_mr["merge_commit_sha"],
        args.target_branch,
    )
    targets = infer_release_targets(changed_files)
    if args.merge_only:
        note = format_merge_only_note(merged_mr, targets, facts)
        post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        print(note)
        return 0

    argocd_base_url, argocd_username, argocd_password, ssl_context = resolve_argocd_settings(args)
    argocd_token = login_argocd(argocd_base_url, argocd_username, argocd_password, ssl_context)
    if not targets:
        note = format_noop_note(merged_mr, facts)
        post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        print(note)
        return 0

    post_merge_request_note(
        args.api_base,
        args.project_id,
        private_token,
        merged_mr["id"],
        format_waiting_note(merged_mr, targets, facts),
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

        note = format_success_note(merged_mr, partial_results, facts)
        post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        print(note)
        return 0
    except Exception as exc:  # noqa: BLE001
        note = format_failure_note(merged_mr, str(exc), partial_results, facts)
        try:
            post_merge_request_note(args.api_base, args.project_id, private_token, merged_mr["id"], note)
        except Exception as note_exc:  # noqa: BLE001
            print(f"failed to post MR note after verification error: {note_exc}", file=sys.stderr)
        print(note, file=sys.stderr)
        raise
