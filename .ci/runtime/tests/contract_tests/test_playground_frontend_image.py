import subprocess
import unittest
import sys
from pathlib import Path

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.playground_frontend_image import (  # noqa: E402
    ensure_playground_frontend_image,
    source_id_from_tag,
    validate_retag_pair,
)


class PlaygroundFrontendImageTests(unittest.TestCase):
    def test_source_id_from_frontend_playground_tag(self) -> None:
        self.assertEqual(source_id_from_tag("frontend-sandbox-bj-6-d28bf7b09cab"), "d28bf7b09cab")

    def test_retag_pair_requires_same_repository(self) -> None:
        with self.assertRaisesRegex(ValueError, "repositories differ"):
            validate_retag_pair(
                "registry.example.com/app/frontend:frontend-sandbox-bj-5-d28bf7b09cab",
                "registry.example.com/other/frontend:frontend-sandbox-bj-6-d28bf7b09cab",
            )

    def test_retag_pair_requires_same_source_sha(self) -> None:
        with self.assertRaisesRegex(ValueError, "same source sha"):
            validate_retag_pair(
                "registry.example.com/app/frontend:frontend-sandbox-bj-5-aaaaaaaaaaa",
                "registry.example.com/app/frontend:frontend-sandbox-bj-6-bbbbbbbbbbb",
            )

    def test_existing_target_is_noop(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, **kwargs):
            calls.append(command)
            if command[1:3] == ["manifest", "inspect"]:
                return subprocess.CompletedProcess(command, 0, stdout='{"Descriptor":{"digest":"sha256:target"}}', stderr="")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        result = ensure_playground_frontend_image(
            target_image="registry.example.com/app/frontend:frontend-sandbox-bj-6-d28bf7b09cab",
            source_images=[],
            skip_login=True,
            run=fake_run,
        )

        self.assertEqual(result.status, "exists")
        self.assertEqual(result.target.digest, "sha256:target")
        self.assertFalse(any(call[1] == "push" for call in calls))

    def test_missing_target_without_apply_reports_retag_required(self) -> None:
        def fake_run(command, **kwargs):
            image = command[-1]
            if command[1:3] == ["manifest", "inspect"] and "sandbox-bj-5" in image:
                return subprocess.CompletedProcess(command, 0, stdout='{"Descriptor":{"digest":"sha256:source"}}', stderr="")
            if command[1:3] == ["manifest", "inspect"]:
                return subprocess.CompletedProcess(command, 1, stdout="", stderr="manifest unknown")
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        result = ensure_playground_frontend_image(
            target_image="registry.example.com/app/frontend:frontend-sandbox-bj-6-d28bf7b09cab",
            source_images=["registry.example.com/app/frontend:frontend-sandbox-bj-5-d28bf7b09cab"],
            skip_login=True,
            run=fake_run,
        )

        self.assertEqual(result.status, "retag_required")
        self.assertEqual(result.source.digest, "sha256:source")

    def test_apply_retags_and_pushes_source_to_target(self) -> None:
        calls: list[list[str]] = []
        target_seen = False

        def fake_run(command, **kwargs):
            nonlocal target_seen
            calls.append(command)
            if command[1:3] == ["manifest", "inspect"]:
                image = command[-1]
                if "sandbox-bj-5" in image:
                    return subprocess.CompletedProcess(command, 0, stdout='{"Descriptor":{"digest":"sha256:source"}}', stderr="")
                if target_seen:
                    return subprocess.CompletedProcess(command, 0, stdout='{"Descriptor":{"digest":"sha256:target"}}', stderr="")
                return subprocess.CompletedProcess(command, 1, stdout="", stderr="manifest unknown")
            if command[1] == "push":
                target_seen = True
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        result = ensure_playground_frontend_image(
            target_image="registry.example.com/app/frontend:frontend-sandbox-bj-6-d28bf7b09cab",
            source_images=["registry.example.com/app/frontend:frontend-sandbox-bj-5-d28bf7b09cab"],
            skip_login=True,
            apply=True,
            run=fake_run,
        )

        self.assertEqual(result.status, "retagged")
        self.assertEqual([call[1] for call in calls if call[1] in {"pull", "tag", "push"}], ["pull", "tag", "push"])


if __name__ == "__main__":
    unittest.main()
