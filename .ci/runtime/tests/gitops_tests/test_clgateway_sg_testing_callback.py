from pathlib import Path
import re
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]

CALLBACK_PREFIX = "CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK"
# 开发者个人落点改派用的 env，和地域回调落点是两回事：地域回调决定「哪个 region 的回调
# 打到哪个共享站点」，这些则把命中 uin 的回调抽走送进 devtunnel。统计地域落点时要排掉，
# 否则加一个开发者就会撑破下面的数量断言。
DEV_OVERRIDE_MARKERS = ("_UIN_ROUTES", "_DEV_")


def is_dev_override(name: str) -> bool:
    return any(marker in name for marker in DEV_OVERRIDE_MARKERS)


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

    def callback_env(self, filename: str) -> dict[str, str]:
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
            if item["name"].startswith(CALLBACK_PREFIX)
        }

    def callback_base_urls(self, filename: str) -> dict[str, str]:
        env = {
            name: value
            for name, value in self.callback_env(filename).items()
            if not is_dev_override(name)
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

    def test_sg_testing_dev_landing_goes_through_devtunnel(self) -> None:
        env = self.callback_env("statefulsetplus-testing.yaml")
        # 不断言具体 uin：槽位是开发者按需申领的，谁在联调就换成谁的影子账号 uin。
        # 写死数字只会让每次换人都顺带改一次测试，而那一步必然被忘掉。这里只守住
        # 格式约束——`<uin>=<槽位>` 逗号分隔，槽位必须是镜像里烤好的 dev-1/2/3 之一。
        uin_routes = env[f"{CALLBACK_PREFIX}_UIN_ROUTES"]
        self.assertRegex(
            uin_routes,
            r"^\d+=jifei-callback-dev-[123](?:,\d+=jifei-callback-dev-[123])*$",
        )
        # 申领了哪些槽位，就必须给哪些槽位配落点，否则回调被改派到黑洞占位 base_url。
        for slot in sorted(set(re.findall(r"jifei-callback-dev-([123])", uin_routes))):
            self.assertIn(f"{CALLBACK_PREFIX}_DEV_{slot}_BASE_URL", env)
            self.assertIn(f"{CALLBACK_PREFIX}_DEV_{slot}_HOST_HEADER", env)
        # 落点必须是集群内 devtunnel，不能是某台开发者机器的直连 IP：tkex → DevCloud
        # 反向不通，直连只会让回调稳定超时。
        self.assertTrue(
            env[f"{CALLBACK_PREFIX}_DEV_1_BASE_URL"].startswith(
                "http://devtunnel-testing."
            ),
            env[f"{CALLBACK_PREFIX}_DEV_1_BASE_URL"],
        )
        # host 是 devtunnel 的分流 key，必须与 tkexgz 那套区分开，否则同一个开发者同时挂
        # 两条 agent 时国内站和国际站的回调会投到同一个落点。
        self.assertEqual(
            env[f"{CALLBACK_PREFIX}_DEV_1_HOST_HEADER"], "sg1.tunnel.internal"
        )

    def test_sg_prod_has_no_developer_landing_override(self) -> None:
        overrides = sorted(
            name
            for name in self.callback_env("statefulsetplus.yaml")
            if is_dev_override(name)
        )
        self.assertEqual(
            overrides,
            [],
            f"生产实例不允许有开发者个人落点改派: {overrides}",
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
