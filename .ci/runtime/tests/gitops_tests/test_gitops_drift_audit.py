import json
import os
import tempfile
import textwrap
import unittest
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
import sys
from typing import Any

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from tests.helpers import git

from gitops.gitops_drift_audit import (
    Drift,
    ExpectedApp,
    build_alert_content,
    evaluate_drift,
    load_expected_apps,
    notify_if_needed,
    resolve_wework_webhook,
)


def expected_app() -> ExpectedApp:
    return ExpectedApp(
        app_name="ctl-beijing-sandbox",
        service="ctl",
        env="beijing-sandbox",
        project="beijing-sandbox",
        destination_name="beijing-sandbox",
        namespace="ctl",
        source_path="argocd/services/ctl/beijing-sandbox",
        expected_images=("example.com/ctl:v2",),
    )


def live_app(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "metadata": {
            "name": "ctl-beijing-sandbox",
            "labels": {
                "lightclaw.dev/environment-name": "beijing-sandbox",
            },
        },
        "spec": {
            "project": "beijing-sandbox",
            "source": {
                "repoURL": "git@git.woa.com:wisp/mono2.git",
                "targetRevision": "gitops",
                "path": "argocd/services/ctl/beijing-sandbox",
            },
            "destination": {
                "name": "beijing-sandbox",
                "namespace": "ctl",
            },
        },
        "status": {
            "sync": {
                "revision": "abc123",
                "status": "Synced",
            },
            "health": {
                "status": "Healthy",
            },
            "summary": {
                "images": ["example.com/ctl:v2"],
            },
        },
    }
    deep_update(payload, overrides)
    return payload


def deep_update(target: dict[str, Any], updates: dict[str, Any]) -> None:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            deep_update(target[key], value)
        else:
            target[key] = value


class GitOpsDriftAuditTests(unittest.TestCase):
    def test_unexpanded_ci_setting_uses_wework_fallback(self) -> None:
        args = type("Args", (), {"wework_webhook": None})()
        with patched_env(
            WEWORK_DRIFT_AUDIT_WEBHOOK="${{ settings.WEWORK_DRIFT_AUDIT_WEBHOOK }}",
            WEWORK_DRIFT_AUDIT_WEBHOOK_FALLBACK="https://example.test/fallback",
        ):
            webhook = resolve_wework_webhook(args)

        self.assertEqual(webhook, "https://example.test/fallback")

    def test_no_drift_when_live_matches_catalog_expectation(self) -> None:
        drifts = evaluate_drift(
            [expected_app()],
            [live_app()],
            gitops_commit_sha="abc123",
            repo_url="git@git.woa.com:wisp/mono2.git",
            target_revision="gitops",
            env="beijing-sandbox",
        )

        self.assertEqual(drifts, [])

    def test_missing_live_app_fails(self) -> None:
        drifts = evaluate_drift(
            [expected_app()],
            [],
            gitops_commit_sha="abc123",
            repo_url="git@git.woa.com:wisp/mono2.git",
            target_revision="gitops",
            env="beijing-sandbox",
        )

        self.assertEqual(drifts, [Drift("ctl-beijing-sandbox", "app", "present", "missing")])

    def test_live_target_revision_path_revision_and_image_mismatch_fail(self) -> None:
        drifts = evaluate_drift(
            [expected_app()],
            [
                live_app(
                    spec={
                        "source": {
                            "targetRevision": "master",
                            "path": "argocd/services/ctl/other",
                        }
                    },
                    status={
                        "sync": {
                            "revision": "old",
                            "status": "OutOfSync",
                        },
                        "health": {
                            "status": "Progressing",
                        },
                        "summary": {
                            "images": ["example.com/ctl:v1"],
                        },
                    },
                )
            ],
            gitops_commit_sha="abc123",
            repo_url="git@git.woa.com:wisp/mono2.git",
            target_revision="gitops",
            env="beijing-sandbox",
        )

        fields = {drift.field for drift in drifts}
        self.assertIn("spec.source.targetRevision", fields)
        self.assertIn("spec.source.path", fields)
        self.assertIn("status.sync.revision", fields)
        self.assertIn("status.sync.status", fields)
        self.assertIn("status.health.status", fields)
        self.assertIn("status.summary.images", fields)

    def test_orphan_beijing_app_fails(self) -> None:
        orphan = live_app(
            metadata={
                "name": "orphan-beijing-sandbox",
                "labels": {
                    "lightclaw.dev/environment-name": "beijing-sandbox",
                },
            }
        )

        drifts = evaluate_drift(
            [expected_app()],
            [live_app(), orphan],
            gitops_commit_sha="abc123",
            repo_url="git@git.woa.com:wisp/mono2.git",
            target_revision="gitops",
            env="beijing-sandbox",
        )

        self.assertEqual(drifts, [Drift("orphan-beijing-sandbox", "orphan", "absent from live", "present in live")])

    def test_loads_shprod_direct_app_expectations_from_gitops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "argocd/apps/shprod").mkdir(parents=True)
            (repo / "argocd/services/frontend/shprod").mkdir(parents=True)
            (repo / "argocd/apps/shprod/frontend.yaml").write_text(
                textwrap.dedent(
                    """\
                    apiVersion: argoproj.io/v1alpha1
                    kind: Application
                    metadata:
                      name: frontend-shprod
                    spec:
                      project: shprod-frontend
                      source:
                        path: argocd/services/frontend/shprod
                      destination:
                        namespace: frontend
                        name: shprod
                    """
                )
            )
            (repo / "argocd/services/frontend/shprod/frontend-platform.env").write_text(
                "FRONTEND_IMAGE=example.com/frontend:v1\n"
            )
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "gitops")

            apps = load_expected_apps(repo, "shprod", "HEAD")

            self.assertEqual(len(apps), 1)
            self.assertEqual(apps[0].app_name, "frontend-shprod")
            self.assertEqual(apps[0].service, "frontend")
            self.assertEqual(apps[0].project, "shprod-frontend")
            self.assertEqual(apps[0].destination_name, "shprod")
            self.assertEqual(apps[0].namespace, "frontend")
            self.assertEqual(apps[0].source_path, "argocd/services/frontend/shprod")
            self.assertEqual(apps[0].expected_images, ("example.com/frontend:v1",))

    def test_loads_sandbox2_catalog_expectations_from_gitops(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "argocd/catalogs/sandbox/beijing-sandbox-2").mkdir(parents=True)
            (repo / "argocd/services/ctl/beijing-sandbox-2").mkdir(parents=True)
            (repo / "argocd/catalogs/sandbox/beijing-sandbox-2/ctl.yaml").write_text(
                textwrap.dedent(
                    """\
                    service: ctl
                    env: beijing-sandbox-2
                    project: beijing-sandbox-2
                    destinationName: beijing-sandbox-2
                    namespace: ctl
                    sourcePath: argocd/services/ctl/beijing-sandbox-2
                    """
                )
            )
            (repo / "argocd/services/ctl/beijing-sandbox-2/ctl-platform.env").write_text(
                "CTL_IMAGE=example.com/ctl:sandbox2\n"
            )
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "gitops")

            apps = load_expected_apps(repo, "beijing-sandbox-2", "HEAD")

            self.assertEqual(len(apps), 1)
            self.assertEqual(apps[0].app_name, "ctl-beijing-sandbox-2")
            self.assertEqual(apps[0].project, "beijing-sandbox-2")
            self.assertEqual(apps[0].destination_name, "beijing-sandbox-2")
            self.assertEqual(apps[0].expected_images, ("example.com/ctl:sandbox2",))

    def test_no_drift_does_not_send_wework_alert(self) -> None:
        called = False

        def fake_urlopen(*_args: Any, **_kwargs: Any) -> Any:
            nonlocal called
            called = True
            return fake_response()

        sent = notify_if_needed(
            "https://example.test/webhook",
            "beijing-sandbox",
            "origin/gitops",
            "abc123",
            [],
            urlopen=fake_urlopen,
        )

        self.assertFalse(sent)
        self.assertFalse(called)

    def test_drift_sends_wework_alert_with_summary_payload(self) -> None:
        captured: dict[str, Any] = {}

        def fake_urlopen(req: Any, **_kwargs: Any) -> Any:
            captured["payload"] = json.loads(req.data.decode())
            return fake_response()

        sent = notify_if_needed(
            "https://example.test/webhook",
            "beijing-sandbox",
            "origin/gitops",
            "abc123",
            [Drift("ctl-beijing-sandbox", "status.sync.status", "Synced", "OutOfSync")],
            urlopen=fake_urlopen,
        )

        self.assertTrue(sent)
        content = captured["payload"]["text"]["content"]
        self.assertIn("env: beijing-sandbox", content)
        self.assertIn("gitops_commit: abc123", content)
        self.assertIn("drift_count: 1", content)
        self.assertIn("ctl-beijing-sandbox status.sync.status", content)

    def test_wework_failure_does_not_hide_original_drift_result(self) -> None:
        def fake_urlopen(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("webhook down")

        sent = notify_if_needed(
            "https://example.test/webhook",
            "beijing-sandbox",
            "origin/gitops",
            "abc123",
            [Drift("ctl-beijing-sandbox", "app", "present", "missing")],
            urlopen=fake_urlopen,
        )

        self.assertFalse(sent)


@contextmanager
def patched_env(**updates: str) -> Any:
    previous = {key: os.environ.get(key) for key in updates}
    try:
        os.environ.update(updates)
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@contextmanager
def fake_response() -> Any:
    class Response:
        def read(self) -> bytes:
            return BytesIO(b"ok").read()

    yield Response()



class AlertContentTests(unittest.TestCase):
    def test_build_alert_content_includes_error(self) -> None:
        content = build_alert_content("beijing-sandbox", "origin/gitops", "", [], error="argo login failed")

        self.assertIn("error: argo login failed", content)


if __name__ == "__main__":
    unittest.main()
