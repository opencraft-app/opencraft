import json
import tempfile
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci.image_pin import main as image_pin_main


class ImagePinTests(unittest.TestCase):
    def test_updates_single_image_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env_dir = repo / "argocd/services/ctl/beijing-sandbox-2"
            env_dir.mkdir(parents=True)
            platform_env = env_dir / "ctl-platform.env"
            platform_env.write_text("CTL_IMAGE=old\n")

            exit_code = self.run_main([
                "update_image_pin.py",
                "--repo-root", str(repo),
                "--service", "ctl",
                "--env", "beijing-sandbox-2",
                "--image", "example.com/ctl:v2",
                "--deployed-at", "2026-04-29T00:00:00Z",
            ])

            self.assertEqual(exit_code, 0)
            content = platform_env.read_text()
            self.assertIn("CTL_IMAGE=example.com/ctl:v2", content)
            self.assertIn("CTL_DEPLOYED_AT=2026-04-29T00:00:00Z", content)

    def test_updates_multi_image_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env_dir = repo / "argocd/services/sandbox/beijing-sandbox-2"
            env_dir.mkdir(parents=True)
            platform_env = env_dir / "sandbox-platform.env"
            platform_env.write_text(
                "SANDBOX_API_IMAGE=old-api\n"
                "SANDBOX_WORKER_IMAGE=old-worker\n"
            )
            payload = json.dumps({
                "images": {
                    "SANDBOX_API_IMAGE": "example.com/api:v2",
                    "SANDBOX_WORKER_IMAGE": "example.com/worker:v2",
                }
            })

            exit_code = self.run_main([
                "update_image_pin.py",
                "--repo-root", str(repo),
                "--service", "sandbox",
                "--env", "beijing-sandbox-2",
                "--image", payload,
                "--deployed-at", "2026-04-29T00:00:00Z",
            ])

            self.assertEqual(exit_code, 0)
            content = platform_env.read_text()
            self.assertIn("SANDBOX_API_IMAGE=example.com/api:v2", content)
            self.assertIn("SANDBOX_API_DEPLOYED_AT=2026-04-29T00:00:00Z", content)
            self.assertIn("SANDBOX_WORKER_IMAGE=example.com/worker:v2", content)
            self.assertIn("SANDBOX_WORKER_DEPLOYED_AT=2026-04-29T00:00:00Z", content)

    def run_main(self, argv: list[str]) -> int:
        old_argv = sys.argv
        try:
            sys.argv = argv
            return image_pin_main()
        finally:
            sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()
