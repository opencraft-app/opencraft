from __future__ import annotations

import unittest
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


def routes_for(env: str) -> dict[str, dict]:
    config = yaml.safe_load(
        (REPO_ROOT / f"argocd/services/service-gateway/{env}/config.yaml").read_text()
    )
    return {route["name"]: route for route in config.get("routes") or []}


class ReferralGatewayRoutesTest(unittest.TestCase):
    def test_beijing_exposes_only_the_declared_referral_contract(self) -> None:
        routes = routes_for("beijing-sandbox")

        public = routes["referral-code-public"]
        self.assertEqual(public["prefix"], "/v1/referrals/codes")
        self.assertEqual(public["access"], "public")
        self.assertEqual(public["methods"], ["GET", "OPTIONS"])
        self.assertEqual(
            public["path_allow"],
            [{"method": "GET", "path": "/v1/referrals/codes/{code}"}],
        )

        user = routes["referral-user"]
        self.assertEqual(user["prefix"], "/v1/referrals/me")
        self.assertEqual(user["access"], "authenticated")
        self.assertEqual(user["auth_strategy"], "session")
        self.assertEqual(
            user["path_allow"],
            [
                {"method": "GET", "path": "/v1/referrals/me"},
                {"method": "POST", "path": "/v1/referrals/me/code"},
                {"method": "GET", "path": "/v1/referrals/me/stats"},
            ],
        )

        auth_public = routes["auth"].get("public_allow") or []
        self.assertIn(
            {"method": "POST", "path": "/auth/referral/prepare"},
            auth_public,
        )

    def test_shanghai_exposes_the_same_exact_referral_contract(self) -> None:
        routes = routes_for("shprod")

        public = routes["referral-code-public"]
        self.assertEqual(public["prefix"], "/v1/referrals/codes")
        self.assertEqual(public["access"], "public")
        self.assertEqual(
            public["path_allow"],
            [{"method": "GET", "path": "/v1/referrals/codes/{code}"}],
        )

        user = routes["referral-user"]
        self.assertEqual(user["access"], "authenticated")
        self.assertEqual(user["auth_strategy"], "session")
        self.assertEqual(
            user["path_allow"],
            [
                {"method": "GET", "path": "/v1/referrals/me"},
                {"method": "POST", "path": "/v1/referrals/me/code"},
                {"method": "GET", "path": "/v1/referrals/me/stats"},
            ],
        )
        self.assertIn(
            {"method": "POST", "path": "/auth/referral/prepare"},
            routes["auth"].get("public_allow") or [],
        )

    def test_singapore_does_not_inherit_china_referral_routes(self) -> None:
        routes = routes_for("sgprod")
        self.assertNotIn("referral-code-public", routes)
        self.assertNotIn("referral-user", routes)
        self.assertNotIn(
            {"method": "POST", "path": "/auth/referral/prepare"},
            routes["auth"].get("public_allow") or [],
        )


if __name__ == "__main__":
    unittest.main()
