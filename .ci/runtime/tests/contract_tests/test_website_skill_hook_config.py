"""Offline real source renders for compatible bootstrap maps; no apply or KSOPS."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[4]
VARIABLE = 'WEBSITE_CREDENTIAL_TAT_COMMAND_IDS_BY_REGION'
SKILL_VARIABLE = 'WEBSITE_SKILL_TAT_COMMAND_IDS_BY_REGION'
MAPS = {
    'shprod': {'ap-shanghai': 'cmd-czxw3gau'},
    'sgprod': {'ap-singapore': 'cmd-qdb9wde1', 'ap-johorbahru': 'cmd-at6wymyk'},
}


def env_values(path):
    return dict(line.split('=', 1) for line in path.read_text().splitlines()
                if '=' in line and not line.lstrip().startswith('#'))


class WebsiteSkillHookConfigurationTests(unittest.TestCase):
    def test_production_bootstrap_maps_are_paired_and_independent_hook_disabled(self):
        for environment, expected in MAPS.items():
            for component in ('ctl', 'sandbox'):
                with self.subTest(environment=environment, component=component):
                    values = env_values(ROOT / f'argocd/services/{component}/{environment}/{component}-platform.env')
                    self.assertEqual(json.loads(values[VARIABLE]), expected)
                    self.assertEqual(values['WEBSITE_CREDENTIAL_TAT_COMMAND_ID'], next(iter(expected.values())))
                    self.assertFalse(values.get(SKILL_VARIABLE))

    def test_other_environment_sources_remain_disabled(self):
        for component in ('ctl', 'sandbox'):
            for path in (ROOT / f'argocd/services/{component}').glob(f'*/{component}-platform.env'):
                if path.parent.name not in MAPS:
                    self.assertFalse(env_values(path).get(SKILL_VARIABLE), str(path))
        base = list(yaml.safe_load_all((ROOT / 'sandbox/k8s/base/manifests.yaml').read_text()))
        config = next(item for item in base if item.get('kind') == 'ConfigMap' and item['metadata']['name'] == 'sandbox-runtime-config')
        self.assertEqual(config['data'][SKILL_VARIABLE], '')

    def test_real_source_renders_deliver_maps_to_both_consumers(self):
        renderer = shutil.which('kustomize')
        command = [renderer, 'build'] if renderer else [shutil.which('kubectl'), 'kustomize']
        self.assertTrue(command[0], 'kustomize or kubectl required for source acceptance')
        with tempfile.TemporaryDirectory() as directory:
            mirror = Path(directory)
            for component in ('ctl', 'sandbox'):
                shutil.copytree(ROOT / f'{component}/k8s/base', mirror / f'{component}/k8s/base')
                for environment in MAPS:
                    name = f'argocd/services/{component}/{environment}'
                    shutil.copytree(ROOT / name, mirror / name)
            for path in mirror.rglob('kustomization.yaml'):
                cfg = yaml.safe_load(path.read_text())
                cfg.pop('generators', None)  # Omit only KSOPS. Never decrypt/read Secret values.
                path.write_text(yaml.safe_dump(cfg))
            for environment, expected in MAPS.items():
                for component in ('ctl', 'sandbox'):
                    with self.subTest(environment=environment, component=component):
                        overlay = mirror / f'argocd/services/{component}/{environment}'
                        result = subprocess.run([*command, str(overlay)], text=True, capture_output=True, check=False)
                        self.assertEqual(result.returncode, 0, result.stderr)
                        resources = list(yaml.safe_load_all(result.stdout))
                        if component == 'sandbox':
                            cm = next(item for item in resources if item.get('kind') == 'ConfigMap' and item['metadata']['name'] == 'sandbox-runtime-config')
                            self.assertEqual(json.loads(cm['data'][VARIABLE]), expected)
                            deployment = next(item for item in resources if item.get('kind') == 'Deployment' and item['metadata']['name'] == 'sandbox-api')
                            references = deployment['spec']['template']['spec']['containers'][0]['envFrom']
                            self.assertIn({'configMapRef': {'name': 'sandbox-runtime-config'}}, references)
                        else:
                            cm = next(item for item in resources if item.get('kind') == 'ConfigMap' and item['metadata']['name'] == 'ctl-platform-values')
                            self.assertEqual(json.loads(cm['data'][VARIABLE]), expected)
                            deployment = next(item for item in resources if item.get('kind') == 'Deployment' and item['metadata']['name'] == 'ctl-service')
                            env = deployment['spec']['template']['spec']['containers'][0]['env']
                            setting = next(item for item in env if item['name'] == VARIABLE)
                            self.assertEqual(setting['valueFrom']['configMapKeyRef'], {'name': 'ctl-platform-values', 'key': VARIABLE, 'optional': True})


if __name__ == '__main__':
    unittest.main()
