import importlib.util
import tempfile
import unittest
from pathlib import Path

import yaml


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_controller_oidc", HERE / "render-controller-oidc.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderControllerOIDCTest(unittest.TestCase):
    def render(self, enabled):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "manifest.yaml"
            target.write_text((HERE / "admission-controller.yaml").read_text())
            MODULE.render(
                target,
                enabled,
                "qcs::cam::uin/100045199955:roleName/actor-bj-q01-runtime-scale-down",
                "cls-ike1rebd",
            )
            text = target.read_text()
            return text, list(yaml.safe_load_all(text))

    def test_enabled_uses_native_projected_token_without_service_account_annotations(self):
        text, documents = self.render(True)
        self.assertNotIn("__TKE_OIDC_", text)
        service_account = next(item for item in documents if item["kind"] == "ServiceAccount")
        self.assertNotIn("annotations", service_account["metadata"])
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        pod = deployment["spec"]["template"]["spec"]
        token = pod["volumes"][0]["projected"]["sources"][0]["serviceAccountToken"]
        self.assertEqual(token, {"audience": "sts.cloud.tencent.com", "expirationSeconds": 3600, "path": "token"})
        container = pod["containers"][0]
        env = {item["name"]: item.get("value") for item in container["env"]}
        self.assertEqual(env["TKE_PROVIDER_ID"], "cls-ike1rebd")
        self.assertEqual(env["TKE_WEB_IDENTITY_TOKEN_FILE"], "/var/run/secrets/cloud.tencent.com/serviceaccount/token")
        self.assertEqual(container["volumeMounts"], [{
            "name": "tke-oidc-token",
            "mountPath": "/var/run/secrets/cloud.tencent.com/serviceaccount",
            "readOnly": True,
        }])

    def test_disabled_has_no_oidc_credential_material(self):
        text, documents = self.render(False)
        self.assertNotIn("__TKE_OIDC_", text)
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        pod = deployment["spec"]["template"]["spec"]
        self.assertNotIn("volumes", pod)
        container = pod["containers"][0]
        self.assertNotIn("volumeMounts", container)
        names = {item["name"] for item in container["env"]}
        self.assertTrue({"TKE_ROLE_ARN", "TKE_PROVIDER_ID", "TKE_WEB_IDENTITY_TOKEN_FILE"}.isdisjoint(names))


if __name__ == "__main__":
    unittest.main()
