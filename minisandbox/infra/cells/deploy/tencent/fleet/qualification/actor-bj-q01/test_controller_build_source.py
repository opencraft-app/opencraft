"""Validate exact controller source selection before touching any credentials."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("build-controller-via-tat.sh")
REVISION = "1" * 40
MANIFEST = "2" * 64
REGISTRY = "registry-test.tencentcloudcr.com"


class ControllerBuildSourceTest(unittest.TestCase):
    def invoke(self, source):
        # The CLI double always terminates at the first credential action.
        # No real registry token, TAT command or remote source is used.
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            marker = root / "credential-action"
            cli = root / "tccli-double"
            cli.write_text("#!/bin/sh\n: > \"$CONTROLLER_TEST_MARKER\"\nexit 88\n")
            cli.chmod(0o700)
            env = dict(os.environ, TCCLI=str(cli), CONTROLLER_TEST_MARKER=str(marker),
                       TENCENTCLOUD_SECRET_ID="example-id", TENCENTCLOUD_SECRET_KEY="example-key",
                       TAT_INSTANCE_ID="ins-fixture", QUALIFICATION_SOURCE_LINK=source,
                       QUALIFICATION_STATE_DIR=str(root / "state"),
                       QUALIFICATION_TCR_HOST=REGISTRY, QUALIFICATION_TCR_REGISTRY_ID="tcr-fixture",
                       ACTOR_FLEET_BUILD_BASE=REGISTRY + "/actor-fleet/base-golang@sha256:" + "3" * 64,
                       ACTOR_FLEET_RUNTIME_BASE=REGISTRY + "/actor-fleet/base-distroless@sha256:" + "4" * 64)
            result = subprocess.run(["bash", str(SCRIPT), REVISION, MANIFEST,
                                     REGISTRY + "/actor-fleet/actor-fleet-controller:fixture"],
                                    env=env, text=True, capture_output=True, timeout=10)
            return result, marker.exists()

    def test_accepts_only_exact_bound_source_paths(self):
        for source in (
            "/data/actor-build/deploy/controller-src-" + REVISION + "-" + MANIFEST,
            "/var/lib/actor-build/deploy/q01-src-" + REVISION + "-" + MANIFEST,
            "/var/lib/actor-build/deploy/actor-bj-q01-current",
        ):
            with self.subTest(source=source):
                result, credential_action = self.invoke(source)
                self.assertEqual(result.returncode, 88, result.stderr)
                self.assertTrue(credential_action)

    def test_rejects_unbound_source_before_credential_actions(self):
        exact = "/data/actor-build/deploy/controller-src-" + REVISION + "-" + MANIFEST
        for source in (
            "/data/actor-build/deploy/current", "/tmp/controller-source",
            exact + "/nested", exact + "/../other", exact + "\n",
            "/data/actor-build/deploy/controller-src-" + "5" * 40 + "-" + MANIFEST,
            "/data/actor-build/deploy/controller-src-" + REVISION + "-" + "6" * 64,
        ):
            with self.subTest(source=source):
                result, credential_action = self.invoke(source)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(credential_action)
                self.assertIn("exact immutable source", result.stderr)


if __name__ == "__main__":
    unittest.main()
