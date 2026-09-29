"""Keep ticket's production DB and GitOps release scoped to its own service."""

from pathlib import Path
import unittest

import yaml


ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / '.ci/runtime').is_dir())


class TicketProdReleaseTests(unittest.TestCase):
    def test_production_pipeline_requires_approvals_and_does_not_auto_pin(self) -> None:
        workflow = yaml.safe_load((ROOT / '.ci/ticket.yml').read_text())
        self.assertEqual(workflow['extends']['template'], 'service-release.yml')
        params = workflow['extends']['parameters']
        self.assertEqual(params['MASTER_BUILD_ENVS'], 'shprod,sgprod')
        self.assertEqual(params['MASTER_AUTO_PIN_ENVS'], 'none')
        self.assertIs(params['ENABLE_MASTER_PROD_DB_MIGRATION'], True)
        self.assertIs(params['ENABLE_MASTER_SHPROD_DB_MIGRATION'], True)
        self.assertIs(params['ENABLE_MASTER_SGPROD_DB_MIGRATION'], True)
        self.assertTrue(yaml.safe_load(params['PROD_REVIEWERS']))

    def test_two_prod_applications_keep_regions_and_secrets_separate(self) -> None:
        bundle = yaml.safe_load((ROOT / '.ci/runtime/bundles/ticket.bundle').read_text())['bundles']['ticket']
        self.assertEqual(bundle['db_contract']['mode'], 'migration')
        self.assertEqual(bundle['db_contract']['expected_migration_source'], 'ticket/migrations')
        for env, registry in [('shprod', 'lightclaw-shprod'), ('sgprod', 'lightclaw-sgprod')]:
            with self.subTest(env=env):
                app = yaml.safe_load((ROOT / f'argocd/apps/{env}/ticket.yaml').read_text())
                self.assertEqual(app['spec']['source']['path'], f'argocd/services/ticket/{env}')
                self.assertEqual(app['spec']['source']['targetRevision'], 'gitops')
                self.assertEqual(app['spec']['destination'], {'namespace': 'ticket', 'name': env})
                env_values = dict(line.split('=', 1) for line in
                                  (ROOT / f'argocd/services/ticket/{env}/ticket-platform.env').read_text().splitlines()
                                  if line and not line.startswith('#'))
                self.assertTrue(env_values['TICKET_IMAGE'].startswith(f'{registry}.tencentcloudcr.com/'))
                self.assertEqual(env_values['TICKET_SUPPORT_AGENT_IDS'], 'admin')
                encrypted = yaml.safe_load((ROOT / f'argocd/secrets/{env}/ticket-runtime-secrets.sops.yaml').read_text())
                self.assertIn('sops', encrypted)
                self.assertTrue(encrypted['stringData']['TICKET_DB_PASSWORD'].startswith('ENC['))
                self.assertTrue(encrypted['stringData']['TICKET_ADMIN_TOKEN'].startswith('ENC['))
                self.assertIn('argocd/secrets/{env}/ticket-runtime-secrets.sops.yaml', bundle['publish_paths'])


if __name__ == '__main__':
    unittest.main()
