import json
import tempfile
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.image_pin import main as image_pin_main


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

    def test_updates_digest_pinned_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env_dir = repo / "argocd/services/sandbox/shprod"
            env_dir.mkdir(parents=True)
            platform_env = env_dir / "sandbox-platform.env"
            platform_env.write_text(
                "SANDBOX_API_IMAGE=old-api\n"
                "SANDBOX_WORKER_IMAGE=old-worker\n"
            )
            payload = json.dumps({
                "images": {
                    "SANDBOX_API_IMAGE": "example.com/api@sha256:api",
                    "SANDBOX_WORKER_IMAGE": "example.com/worker@sha256:worker",
                }
            })

            exit_code = self.run_main([
                "update_image_pin.py",
                "--repo-root", str(repo),
                "--service", "sandbox",
                "--env", "shprod",
                "--image", payload,
                "--deployed-at", "2026-05-03T00:00:00Z",
            ])

            self.assertEqual(exit_code, 0)
            content = platform_env.read_text()
            self.assertIn("SANDBOX_API_IMAGE=example.com/api@sha256:api", content)
            self.assertIn("SANDBOX_WORKER_IMAGE=example.com/worker@sha256:worker", content)

    def test_updates_all_platform_variants(self) -> None:
        """同一个 env 下有 testing / staging 变体时，三份 pin 必须一起更新。

        回归背景：原实现 glob("*-platform.env") 匹配不到带 variant 后缀的文件，
        导致 cloudladdergateway 的 testing 实例镜像从 2026-06 起就再没被自动更新过。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env_dir = repo / "argocd/services/cloudladdergateway/tkexgz"
            env_dir.mkdir(parents=True)
            variants = {
                "cloudladdergateway-platform.env": env_dir / "cloudladdergateway-platform.env",
                "cloudladdergateway-platform-testing.env": env_dir / "cloudladdergateway-platform-testing.env",
                "cloudladdergateway-platform-staging.env": env_dir / "cloudladdergateway-platform-staging.env",
            }
            for path in variants.values():
                path.write_text(
                    "CLOUDLADDERGATEWAY_DEPLOYED_AT=2026-06-08T12:00:00Z\n"
                    "CLOUDLADDERGATEWAY_IMAGE=example.com/clgw:old\n"
                )

            exit_code = self.run_main([
                "update_image_pin.py",
                "--repo-root", str(repo),
                "--service", "cloudladdergateway",
                "--env", "tkexgz",
                "--image", "example.com/clgw:new",
                "--deployed-at", "2026-08-06T00:00:00Z",
            ])

            self.assertEqual(exit_code, 0)
            for name, path in variants.items():
                content = path.read_text()
                # variant 后缀不进 key，三份文件里的键名都是 CLOUDLADDERGATEWAY_IMAGE
                self.assertIn("CLOUDLADDERGATEWAY_IMAGE=example.com/clgw:new", content, name)
                self.assertIn("CLOUDLADDERGATEWAY_DEPLOYED_AT=2026-08-06T00:00:00Z", content, name)

    def test_multi_variant_does_not_inject_foreign_keys(self) -> None:
        """有多份 platform env 时，不要把某个工作负载的键写进不含该键的文件。"""
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env_dir = repo / "argocd/services/cloudladdergateway/tkexsg"
            env_dir.mkdir(parents=True)
            main_env = env_dir / "cloudladdergateway-platform.env"
            testing_env = env_dir / "cloudladdergateway-platform-testing.env"
            main_env.write_text("CLOUDLADDERGATEWAY_IMAGE=old\n")
            testing_env.write_text("SOMETHING_ELSE=keep\n")

            exit_code = self.run_main([
                "update_image_pin.py",
                "--repo-root", str(repo),
                "--service", "cloudladdergateway",
                "--env", "tkexsg",
                "--image", "example.com/clgw:new",
                "--deployed-at", "2026-08-06T00:00:00Z",
            ])

            self.assertEqual(exit_code, 0)
            self.assertIn("CLOUDLADDERGATEWAY_IMAGE=example.com/clgw:new", main_env.read_text())
            self.assertEqual(testing_env.read_text(), "SOMETHING_ELSE=keep\n")

    def run_main(self, argv: list[str]) -> int:
        old_argv = sys.argv
        try:
            sys.argv = argv
            return image_pin_main()
        finally:
            sys.argv = old_argv


if __name__ == "__main__":
    unittest.main()
