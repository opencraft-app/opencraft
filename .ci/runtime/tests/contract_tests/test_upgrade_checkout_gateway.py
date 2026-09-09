import unittest
from pathlib import Path
import yaml

ROOT = next(p for p in Path(__file__).resolve().parents if (p / '.ci/runtime').is_dir())


class UpgradeCheckoutGatewayTests(unittest.TestCase):
    def test_beijing_only_payment_url_allows_ticket_auth(self):
        config = yaml.safe_load((ROOT / 'argocd/services/service-gateway/sandbox-bj-7/config.yaml').read_text())
        route = next(route for route in config['routes'] if route['name'] == 'ctl-passes')
        self.assertEqual(route['access'], 'authenticated')
        optional = {(rule['method'], rule['path']) for rule in route['optional_auth_allow']}
        self.assertIn(('POST', '/v1/passes/{pass_id}/modify/order-url'), optional)
        self.assertNotIn(('POST', '/v1/passes/{pass_id}/modify/order'), optional)
        self.assertNotIn(('POST', '/v1/passes/{pass_id}/modify/payment-authorization'), optional)


if __name__ == '__main__':
    unittest.main()
