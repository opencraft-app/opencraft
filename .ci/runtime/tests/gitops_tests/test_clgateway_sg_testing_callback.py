from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CloudLadderSGCallbackTests(unittest.TestCase):
    def backend_base_urls(self, filename: str) -> dict[str, str]:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/cloudladdergateway/tkexsg"
                / filename
            ).read_text()
        )
        return {
            item["name"]: item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
            if item["name"].startswith("CLOUDLADDERGATEWAY_BACKEND_DIANSHI_")
        }

    def callback_base_urls(self, filename: str) -> dict[str, str]:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/cloudladdergateway/tkexsg"
                / filename
            ).read_text()
        )
        env = {
            item["name"]: item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
            if item["name"].startswith("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK")
        }
        self.assertEqual(len(env), 7)
        return env

    def test_sg_prod_callback_targets_sg_api(self) -> None:
        callbacks = self.callback_base_urls("statefulsetplus.yaml")
        sg_key = "CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_SG_BASE_URL"
        self.assertEqual(callbacks.pop(sg_key), "https://api.lightvela.ai")
        self.assertEqual(
            set(callbacks.values()),
            {"https://api-sandbox-jp-1.lightclaw.tech"},
        )

    def test_sg_testing_callbacks_stay_on_kr_api(self) -> None:
        self.assertEqual(
            set(self.callback_base_urls("statefulsetplus-testing.yaml").values()),
            {"https://api-sandbox-kr-1.lightclaw.tech"},
        )

    def test_sg_workloads_use_sgpolaris_dianshi_backends(self) -> None:
        expected = {
            "CLOUDLADDERGATEWAY_BACKEND_DIANSHI_PRICE_BASE_URL":
                "http://opc-activity-price.production.sgpolaris:10006",
            "CLOUDLADDERGATEWAY_BACKEND_DIANSHI_ORDER_BASE_URL":
                "http://opc-dianshi-activity.production.sgpolaris:80",
        }
        self.assertEqual(
            self.backend_base_urls("statefulsetplus-testing.yaml"), expected
        )
        self.assertEqual(self.backend_base_urls("statefulsetplus.yaml"), expected)

    def test_sg_prod_registers_same_service_in_china_and_singapore_polaris(self) -> None:
        china_prod_service = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/secrets/tkexsg/cloudladdergateway-polaris-prod-service.sops.yaml"
            ).read_text()
        )
        singapore_prod_service = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/secrets/tkexsg/cloudladdergateway-polaris-prod-sg-service.sops.yaml"
            ).read_text()
        )
        testing_service = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/secrets/tkexsg/cloudladdergateway-polaris-testing-service.sops.yaml"
            ).read_text()
        )
        china_annotations = china_prod_service["metadata"]["annotations"]
        singapore_annotations = singapore_prod_service["metadata"]["annotations"]
        testing_annotations = testing_service["metadata"]["annotations"]

        for annotations in (china_annotations, singapore_annotations):
            self.assertEqual(
                annotations["polaris.tkex.cloud.tencentyun.com/service"],
                "clgateway-intl",
            )
            self.assertEqual(
                annotations["polaris.tkex.cloud.tencentyun.com/namespace"],
                "Production",
            )
            self.assertEqual(
                annotations["polaris.tkex.cloud.tencentyun.com/workloadname"],
                "lightvela-proxy",
            )
            self.assertTrue(
                annotations["polaris.tkex.cloud.tencentyun.com/token"].startswith("ENC[")
            )
        self.assertEqual(
            china_annotations["polaris.tkex.cloud.tencentyun.com/polaris-site-zone"],
            "china",
        )
        self.assertEqual(
            singapore_annotations["polaris.tkex.cloud.tencentyun.com/polaris-site-zone"],
            "singapore",
        )
        self.assertNotEqual(
            china_prod_service["metadata"]["name"],
            singapore_prod_service["metadata"]["name"],
        )
        self.assertEqual(
            testing_annotations["polaris.tkex.cloud.tencentyun.com/polaris-site-zone"],
            "singapore",
        )

        service_text = (
            REPO_ROOT / "argocd/services/cloudladdergateway/tkexsg/service.yaml"
        ).read_text()
        kustomization_text = (
            REPO_ROOT / "argocd/services/cloudladdergateway/tkexsg/kustomization.yaml"
        ).read_text()
        self.assertNotIn("lightvela-proxy-inner-service-prod-intl", service_text)
        self.assertIn("ksops-polaris-prod-service-generator.yaml", kustomization_text)
        self.assertIn("ksops-polaris-prod-sg-service-generator.yaml", kustomization_text)


if __name__ == "__main__":
    unittest.main()
