#!/usr/bin/env python3
"""Regression tests for CVM image cross-region sync orchestration."""

import importlib.util
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "build-image.py"
SPEC = importlib.util.spec_from_file_location("build_image_under_test", MODULE_PATH)
build_image = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build_image
SPEC.loader.exec_module(build_image)


class ImageSyncTests(unittest.TestCase):
    def test_capture_rejects_instance_website_credentials_before_cleanup(self):
        with mock.patch.object(build_image, "run_remote_shell_via_ssh") as run:
            build_image.step_prepare_capture("test-host", "22", "app-only", 18789)
        script = run.call_args.args[2]
        self.assertIn("refusing image capture: instance website credential exists", script)
        self.assertLess(script.index("refusing image capture"), script.index('rm -rf'))
        # Run the exact emitted guard against fixtures, including dangling symlinks.
        guard = script[script.index("# BEGIN instance credential guard"):script.index("# END instance credential guard")]
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "website-credential.env"
            fixture_guard = guard.replace("/etc/vela/website-credential.env", str(credential))
            self.assertEqual(subprocess.run(["bash", "-c", fixture_guard], capture_output=True).returncode, 0)
            credential.write_text("fixture-only")
            result = subprocess.run(["bash", "-c", fixture_guard], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b"fixture-only", result.stdout + result.stderr)
            credential.unlink()
            credential.symlink_to(Path(directory) / "missing")
            self.assertNotEqual(subprocess.run(["bash", "-c", fixture_guard], capture_output=True).returncode, 0)

    def test_capture_cleanup_keeps_shell_variable_expansion(self):
        with mock.patch.object(build_image, "run_remote_shell_via_ssh") as run:
            build_image.step_prepare_capture("test-host", "22", "app-only", 18789,
                                             remote_build_dir="/opt/test-build")
        script = run.call_args.args[2]
        self.assertIn('rm -rf "${remote_build_dir}"', script)
        self.assertNotIn('$/opt/test-build', script)

    def test_hermes_capture_stops_gateway_then_cleans_state(self):
        with mock.patch.object(build_image, "run_remote_shell_via_ssh") as run:
            build_image.step_prepare_capture("test-host", "22", "app-only", 0,
                                             runtime_kind="hermes")
        script = run.call_args.args[2]
        self.assertLess(script.index("stop hermes-gateway.service"), script.index("def clean_runtime"))
        self.assertIn("is-active --quiet hermes-gateway.service", script)
        self.assertIn("'sessions'", script)
        with mock.patch.object(build_image, "run_remote_shell_via_ssh") as run:
            build_image.step_prepare_capture("test-host", "22", "app-only", 18789)
        self.assertNotIn("def clean_runtime", run.call_args.args[2])

    def test_local_command_only_allows_explicit_empty_arguments(self):
        with mock.patch.object(
            build_image.subprocess,
            "run",
            return_value=build_image.subprocess.CompletedProcess([], 0),
        ) as run:
            build_image.run_cmd(
                ["ssh-keygen", "-N", ""],
                allow_empty_indices=(2,),
            )

        run.assert_called_once()
        with self.assertRaisesRegex(
            ValueError,
            "local command argument must not be empty",
        ):
            build_image.run_cmd(["ssh-keygen", "-N", ""])

    def test_temp_keypair_marks_empty_passphrase_as_intentional(self):
        with tempfile.TemporaryDirectory() as key_dir:
            Path(key_dir, "id_rsa.pub").write_text(
                "ssh-rsa test-public-key\n",
                encoding="utf-8",
            )
            with (
                mock.patch.object(build_image.tempfile, "mkdtemp", return_value=key_dir),
                mock.patch.object(build_image, "run_cmd") as run,
            ):
                result = build_image.create_temp_ssh_keypair_local()

        self.assertEqual(result["public_key_text"], "ssh-rsa test-public-key")
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs["allow_empty_indices"], (7,))

    def test_ssh_command_rejects_empty_dynamic_arguments(self):
        with mock.patch.object(build_image.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "ssh command argument must not be empty"):
                build_image.run_ssh_command("ubuntu@example.com", "22", "")

        run.assert_not_called()

    def test_tccli_command_rejects_empty_dynamic_arguments(self):
        with self.assertRaisesRegex(ValueError, "tccli argument must not be empty"):
            build_image.run_tccli("cvm", "DescribeImages", "ap-seoul", ["--ImageIds", ""])

    def test_hermes_deploy_injects_resolved_backend_blueprint_id(self):
        calls = []
        original_ensure = build_image.ensure_remote_build_assets
        original_start = build_image.start_remote_build_job
        original_wait = build_image.wait_for_remote_build_job
        original_resolve = build_image.resolve_hermes_backend_blueprint_id

        def fake_start(*args, **kwargs):
            calls.append((args, kwargs))
            return {"status_file": "/tmp/status.json"}

        try:
            build_image.ensure_remote_build_assets = lambda *_args, **_kwargs: None
            build_image.start_remote_build_job = fake_start
            build_image.wait_for_remote_build_job = lambda *_args, **_kwargs: None
            build_image.resolve_hermes_backend_blueprint_id = lambda: "lhbp-latest"

            build_image.step_deploy_build(
                "ubuntu@example.com",
                "22",
                runtime_kind="hermes",
                runtime_user="agentuser",
            )
        finally:
            build_image.ensure_remote_build_assets = original_ensure
            build_image.start_remote_build_job = original_start
            build_image.wait_for_remote_build_job = original_wait
            build_image.resolve_hermes_backend_blueprint_id = original_resolve

        self.assertEqual(len(calls), 1)
        args, _kwargs = calls[0]
        self.assertEqual(args[5], "agentuser")
        self.assertEqual(args[6], "lhbp-latest")

    def test_multi_region_sync_waits_for_source_between_regions(self):
        source_busy = False
        sync_calls = []
        target_ids = {
            "ap-beijing": "img-bj",
            "ap-shanghai": "img-sh",
            "ap-singapore": "img-sg",
            "ap-tokyo": "img-jp",
            "ap-johorbahru": "img-jhb",
        }
        target_poll_count = {region: 0 for region in target_ids}

        original_run_tccli = build_image.run_tccli
        original_sleep = build_image.time.sleep
        original_log = build_image.log
        original_poll_interval = build_image.POLL_INTERVAL_IMAGE
        original_poll_timeout = build_image.POLL_TIMEOUT_IMAGE_SYNC

        def fake_run_tccli(service, action, region, extra_args=None):
            nonlocal source_busy
            self.assertEqual(service, "cvm")
            if action == "DescribeImages" and region == "ap-seoul":
                return {
                    "TotalCount": 1,
                    "ImageSet": [{
                        "ImageId": "img-source",
                        "ImageState": "SYNCING" if source_busy else "NORMAL",
                    }],
                }
            if action == "SyncImages":
                if source_busy:
                    raise RuntimeError("source image is still syncing")
                target_region = build_image.json.loads(
                    extra_args[extra_args.index("--DestinationRegions") + 1]
                )[0]
                sync_calls.append(target_region)
                source_busy = True
                return {
                    "RequestId": f"req-{target_region}",
                    "ImageSet": [{
                        "Region": target_region,
                        "ImageId": target_ids[target_region],
                    }],
                }
            if action == "DescribeImages" and region in target_ids:
                target_poll_count[region] += 1
                state = "NORMAL" if target_poll_count[region] >= 2 else "SYNCING"
                if state == "NORMAL":
                    source_busy = False
                return {
                    "TotalCount": 1,
                    "ImageSet": [{
                        "ImageId": target_ids[region],
                        "ImageState": state,
                    }],
                }
            raise AssertionError(f"unexpected tccli call: {action} {region} {extra_args}")

        try:
            build_image.run_tccli = fake_run_tccli
            build_image.time.sleep = lambda _seconds: None
            build_image.log = lambda _message: None
            build_image.POLL_INTERVAL_IMAGE = 0
            build_image.POLL_TIMEOUT_IMAGE_SYNC = 30

            result = build_image.step_sync_images(
                "img-source",
                "ap-seoul",
                ["ap-beijing", "ap-shanghai", "ap-singapore", "ap-tokyo", "ap-johorbahru"],
                "hermes-agent-test",
            )
        finally:
            build_image.run_tccli = original_run_tccli
            build_image.time.sleep = original_sleep
            build_image.log = original_log
            build_image.POLL_INTERVAL_IMAGE = original_poll_interval
            build_image.POLL_TIMEOUT_IMAGE_SYNC = original_poll_timeout

        self.assertEqual(sync_calls, ["ap-beijing", "ap-shanghai", "ap-singapore", "ap-tokyo", "ap-johorbahru"])
        self.assertEqual(result, target_ids)

    def test_default_target_regions_include_johor_bahru(self):
        self.assertEqual(
            build_image.DEFAULT_TARGET_REGIONS,
            ["ap-beijing", "ap-shanghai", "ap-singapore", "ap-tokyo", "ap-johorbahru"],
        )


if __name__ == "__main__":
    unittest.main()
