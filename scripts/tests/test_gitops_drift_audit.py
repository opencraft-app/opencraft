import json
import os
import unittest
from contextlib import contextmanager
from io import BytesIO
from typing import Any

from scripts.audit_gitops_drift import (
    Drift,
    ExpectedApp,
    build_alert_content,
    evaluate_drift,
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
