import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SKILL_PATH = REPO_ROOT / ".agents" / "skills" / "website-builder" / "SKILL.md"


class WebsiteBuilderSkillContractTests(unittest.TestCase):
    def test_publish_consumes_the_server_signed_upload_headers(self) -> None:
        skill = SKILL_PATH.read_text()

        for required_text in (
            "data.upload_headers",
            "Content-Length",
            "x-cos-meta-artifact-sha256",
            "逐项原样",
            "缺失",
            "未知",
        ):
            with self.subTest(required_text=required_text):
                self.assertIn(required_text, skill)

    def test_publish_keeps_secret_bearing_operational_data_out_of_output(self) -> None:
        skill = SKILL_PATH.read_text()

        for secret_value in ("upload_url", "VELA_WEBSITE_KEY", "原始响应"):
            with self.subTest(secret_value=secret_value):
                self.assertRegex(
                    skill,
                    rf"(?s)(?:不要|不得|严禁).{{0,80}}{secret_value}|{secret_value}.{{0,80}}(?:不要|不得|严禁).{{0,30}}(?:输出|打印|展示)",
                )


if __name__ == "__main__":
    unittest.main()
