import os
import subprocess
import unittest
import sys
import json
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.image_existence import (  # noqa: E402
    ImageCheckResult,
    digest_pin_payload,
    digest_ref,
    emit,
    image_references,
    verify_images,
    verify_images_with_retry,
)


def completed_process(args: object, returncode: int = 0, stdout: str = "", stderr: str = ""):
    # Test fixtures construct CompletedProcess objects directly; no subprocess is launched here.
    return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)  # nosemgrep: dangerous-subprocess-use-audit


class ImageExistenceTests(unittest.TestCase):
    def test_parses_single_image_reference(self) -> None:
        self.assertEqual(image_references("registry.example.com/app/demo:v1"), ["registry.example.com/app/demo:v1"])

    def test_parses_multi_image_payload(self) -> None:
        payload = '{"images":{"API_IMAGE":"registry.example.com/app/api:v1","WORKER_IMAGE":"registry.example.com/app/worker:v1"}}'

        self.assertEqual(
            image_references(payload),
            ["registry.example.com/app/api:v1", "registry.example.com/app/worker:v1"],
        )

    def test_verifies_all_images_and_logs_in_once_per_registry(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, **kwargs):
            calls.append(command)
            if command[1:3] == ["manifest", "inspect"]:
                return completed_process(
                    command,
                    stdout='{"Descriptor":{"digest":"sha256:abc"}}',
                )
            return completed_process(command)

        previous = os.environ.copy()
        try:
            os.environ["REGISTRY_USERNAME"] = "100045199955"
            os.environ["REGISTRY_PASSWORD"] = "fake-password"
            results = verify_images(
                ["registry.example.com/app/api:v1", "registry.example.com/app/worker:v1"],
                docker_bin="docker",
                run=fake_run,
            )
        finally:
            os.environ.clear()
            os.environ.update(previous)

        self.assertTrue(all(result.exists for result in results))
        self.assertTrue(all(result.digest == "sha256:abc" for result in results))
        login_calls = [call for call in calls if call[1] == "login"]
        inspect_calls = [call for call in calls if call[1:3] == ["manifest", "inspect"]]
        self.assertEqual(len(login_calls), 1)
        self.assertEqual(len(inspect_calls), 2)
        self.assertTrue(all("--verbose" in call for call in inspect_calls))

    def test_missing_image_fails_result(self) -> None:
        def fake_run(command, **kwargs):
            return completed_process(command, 1, stderr="manifest unknown")

        with redirect_stderr(StringIO()):
            results = verify_images(
                ["registry.example.com/app/missing:v1"],
                docker_bin="docker",
                skip_login=True,
                run=fake_run,
            )

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].exists)

    def test_can_suppress_expected_missing_image_stderr(self) -> None:
        def fake_run(command, **kwargs):
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="manifest unknown")

        stderr = StringIO()
        with redirect_stderr(stderr):
            results = verify_images(
                ["registry.example.com/app/missing:v1"],
                docker_bin="docker",
                skip_login=True,
                run=fake_run,
                log_missing_errors=False,
            )

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].exists)
        self.assertEqual(stderr.getvalue(), "")

    def test_verify_images_with_retry_waits_for_missing_image(self) -> None:
        calls = 0

        def fake_run(command, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return completed_process(command, 1, stderr="manifest unknown")
            return completed_process(command, stdout='{"Descriptor":{"digest":"sha256:abc"}}')

        with redirect_stderr(StringIO()), mock.patch("contracts.image_existence.time.sleep") as sleep:
            results = verify_images_with_retry(
                ["registry.example.com/app/demo:v1"],
                docker_bin="docker",
                skip_login=True,
                retries=1,
                retry_interval_seconds=2,
                run=fake_run,
            )

        self.assertTrue(results[0].exists)
        self.assertEqual(results[0].digest, "sha256:abc")
        sleep.assert_called_once_with(2)

    def test_dotenv_output_quotes_json_for_shell_source(self) -> None:
        output = StringIO()

        with redirect_stdout(output):
            emit([ImageCheckResult("registry.example.com/app/demo:v1", True, "sha256:abc")], "dotenv")

        self.assertIn("IMAGE_EXISTS=true", output.getvalue())
        self.assertIn("IMAGE_REFS_JSON='[", output.getvalue())
        self.assertIn("IMAGE_DIGESTS_JSON='{", output.getvalue())
        self.assertIn("IMAGE_PIN_PAYLOAD=registry.example.com/app/demo@sha256:abc", output.getvalue())

    def test_builds_digest_ref_from_tagged_image(self) -> None:
        self.assertEqual(
            digest_ref("registry.example.com/app/demo:v1", "sha256:abc"),
            "registry.example.com/app/demo@sha256:abc",
        )

    def test_builds_multi_image_digest_payload_with_original_keys(self) -> None:
        payload = digest_pin_payload(
            [
                ImageCheckResult("registry.example.com/app/api:v1", True, "sha256:api", "API_IMAGE"),
                ImageCheckResult("registry.example.com/app/worker:v1", True, "sha256:worker", "WORKER_IMAGE"),
            ]
        )

        self.assertEqual(
            json.loads(payload),
            {
                "images": {
                    "API_IMAGE": "registry.example.com/app/api@sha256:api",
                    "WORKER_IMAGE": "registry.example.com/app/worker@sha256:worker",
                }
            },
        )


if __name__ == "__main__":
    unittest.main()
