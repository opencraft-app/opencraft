import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
SKILL_PATH = REPO_ROOT / ".agents" / "skills" / "website-builder" / "SKILL.md"


class WebsiteBuilderSkillContractTests(unittest.TestCase):
    def test_skill_is_business_agnostic(self) -> None:
        source = SKILL_PATH.parent
        for path in source.rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts:
                with self.subTest(file=str(path.relative_to(source))):
                    self.assertNotIn("todo", str(path.relative_to(source)).lower())
                    self.assertFalse(b"todo" in path.read_bytes().lower(), "business-specific fixture in Skill")
        skill = SKILL_PATH.read_text()
        self.assertNotIn("/api/sum", skill)
        self.assertNotIn("JSON.stringify({ a: 2, b: 3 })", skill)
        for contract in ("fetch-v1", "rivet-sql-v1", "参数绑定", "幂等", "向后兼容", "独立浏览器"):
            with self.subTest(contract=contract):
                self.assertIn(contract, skill)

    def test_backend_capability_is_fail_closed(self) -> None:
        skill = SKILL_PATH.read_text()
        for text in ("data.backend.enabled", "data.data.enabled", "缺失", "false",
                     '"kind": "static"', "WEBSITE_BACKEND_UNAVAILABLE", "不要重试", "服务端代码"):
            with self.subTest(text=text):
                self.assertIn(text, skill)

    def test_skill_does_not_contradict_the_gated_stateless_backend(self) -> None:
        skill = SKILL_PATH.read_text()
        overview = skill.split("## ⚠️", 1)[0]
        self.assertIn("后端执行与数据存储是两项独立能力", overview)
        self.assertIn("能力门禁", overview)
        self.assertIn("站点所有者登录", skill)
        for contradiction in (
            "**纯静态网站**的创建", "没有后端接口",
            "当前只支持静态网站，存不了数据，这个功能做不了",
            "当场告诉用户当前只支持静态网站、存不了数据",
        ):
            with self.subTest(contradiction=contradiction):
                self.assertNotIn(contradiction, skill)
        self.assertIn("data.backend.enabled", skill)
        self.assertIn("data.data.enabled", skill)
        self.assertIn("fetch-v1", skill)
        self.assertIn("不支持公开访客写入", skill)
        self.assertIn("rivet-sql-v1", skill)

    def test_public_url_examples_use_the_international_https_domain(self) -> None:
        skill = SKILL_PATH.read_text()

        self.assertIn("https://ws-xxx.lightvela.site/", skill)
        self.assertNotIn("sites.lightclaw.tech", skill)

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
