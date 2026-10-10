import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import shutil
import subprocess

import yaml
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / '.ci/runtime/support/prepare_website_backend_release.py'


def module():
    spec = importlib.util.spec_from_file_location('website_release_bindings', SCRIPT)
    implementation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(implementation)
    return implementation


def fixture(environment='shprod'):
    return {
        'schema_version': 1,
        'environment': environment,
        'source_tree_sha256': 'a' * 64,
        'runtime': {
            'environment': environment,
            'base_url': 'https://10.66.1.9:8090',
            'ca': {'name': 'website-runtime-ca', 'key': 'ca-bundle.pem'},
            'deploy_token': {'name': 'website-runtime-secrets', 'key': 'deploy'},
            'invoke_token': {'name': 'website-runtime-secrets', 'key': 'invoke'},
        },
        'beta_users': ['usr_testowner'],
    }


class WebsiteBackendReleaseBindingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = module()

    def test_prepare_is_default_and_does_not_enable_creation(self):
        result = self.api.prepare(fixture())
        self.assertEqual(result['phase'], 'prepare')
        self.assertFalse(result['apply_executed'])
        for patches in result['service_patches'].values():
            for item in patches:
                patch = json.loads(item['patch'])
                env = patch['spec']['template']['spec']['containers'][0]['env']
                for entry in env:
                    if entry['name'] == 'WEBSITE_BACKEND_ENABLED':
                        self.assertEqual(entry['value'], '0')

    def test_enable_requires_explicit_phase_not_owner_list(self):
        result = self.api.prepare(fixture(), phase='enable')
        self.assertEqual(result['phase'], 'enable')
        cfg = fixture(); cfg['beta_users'] = []
        self.assertEqual(self.api.prepare(cfg, phase='enable')['phase'], 'enable')
        cfg['schema_version'] = 3
        cfg.pop('beta_users')
        cfg['data_enabled'] = True
        cfg['runtime']['driver'] = 'minisandbox'
        self.assertTrue(self.api.prepare(cfg, phase='enable')['data_enabled'])
        self.assertFalse(self.api.prepare(cfg)['data_enabled'])

    def test_role_separation_and_read_only_ca_in_every_consumer(self):
        result = self.api.prepare(fixture())
        patches = [json.loads(p['patch']) for patches in result['service_patches'].values() for p in patches]
        self.assertEqual(len(patches), 4)
        for patch in patches:
            pod = patch['spec']['template']['spec']
            container = pod['containers'][0]
            env = {v['name']: v for v in container['env']}
            role = 'invoke' if patch['metadata']['name'] == 'site-gateway' else 'deploy'
            own = 'WEBSITE_RUNTIME_' + role.upper() + '_TOKEN'
            other = 'WEBSITE_RUNTIME_' + ('DEPLOY' if role == 'invoke' else 'INVOKE') + '_TOKEN'
            self.assertEqual(env[own]['valueFrom']['secretKeyRef'], fixture()['runtime'][role + '_token'])
            self.assertIsNone(env[own]['value'])
            self.assertEqual(env[other]['value'], '')
            self.assertIsNone(env[other]['valueFrom'])
            self.assertTrue(container['volumeMounts'][0]['readOnly'])
            self.assertEqual(pod['volumes'][0]['secret']['items'][0]['path'], 'ca-bundle.pem')

    def test_production_targets_match_source_declared_names(self):
        for environment in ['shprod', 'sgprod']:
            with self.subTest(environment=environment):
                result = self.api.prepare(fixture(environment))
                targets = [(p['target']['namespace'], p['target']['name']) for patches in result['service_patches'].values() for p in patches]
                self.assertEqual(set(targets), {('ctl', 'ctl-api'), ('ctl', 'ctl-service'), ('ctl', 'website-deployer'), ('ctl', 'site-gateway')})

    def test_wrong_region_is_rejected(self):
        cfg = fixture(); cfg['runtime']['environment'] = 'beijing-sandbox'
        with self.assertRaises(ValueError):
            self.api.prepare(cfg)

    def test_invalid_endpoint_is_rejected(self):
        for url in ['', 'http://10.66.1.9:8090', 'https://user:pass@10.66.1.9', 'https://127.0.0.1:8090', 'https://8.8.8.8', 'https://10.66.1.9/route', 'https://10.66.1.9?token=abc', 'https://10.66.1.9#bad']:
            with self.subTest(url=url):
                cfg = fixture(); cfg['runtime']['base_url'] = url
                with self.assertRaises(ValueError):
                    self.api.prepare(cfg)

    def test_token_values_and_unknown_fields_are_rejected_without_echo(self):
        for location in ['root', 'runtime', 'reference']:
            cfg = fixture(); obj = {'root': cfg, 'runtime': cfg['runtime'], 'reference': cfg['runtime']['deploy_token']}[location]
            obj['password'] = 'NEVER_ECHO_CREDENTIAL_VALUE'
            with self.subTest(location=location):
                with self.assertRaises(ValueError) as error:
                    self.api.prepare(cfg)
                self.assertNotIn('NEVER_ECHO_CREDENTIAL_VALUE', str(error.exception))

    def test_identical_token_reference_is_rejected(self):
        cfg = fixture(); cfg['runtime']['invoke_token'] = copy.deepcopy(cfg['runtime']['deploy_token'])
        with self.assertRaises(ValueError):
            self.api.prepare(cfg)

    def test_ca_reference_cannot_mount_execution_credential(self):
        for role in ['deploy_token', 'invoke_token']:
            cfg = fixture(); cfg['runtime']['ca'] = copy.deepcopy(cfg['runtime'][role])
            with self.subTest(role=role), self.assertRaises(ValueError):
                self.api.prepare(cfg)

    def test_bad_reference_names_and_keys_are_rejected(self):
        for name, key in [('UPPER!', 'ca-bundle.pem'), ('../secret', 'deploy'), ('valid', '../../escape')]:
            cfg = fixture(); cfg['runtime']['ca'] = {'name': name, 'key': key}
            with self.assertRaises(ValueError):
                self.api.prepare(cfg)

    def test_bad_schema_source_and_allowlist_are_rejected(self):
        for key, value in [('schema_version', True), ('source_tree_sha256', 'mutable-tag'), ('beta_users', ['usr_owner,usr_other']), ('environment', 'unknown')]:
            cfg = fixture(); cfg[key] = value
            with self.assertRaises(ValueError):
                self.api.prepare(cfg)

    def test_output_is_deterministic_and_input_is_not_modified(self):
        cfg = fixture(); before = copy.deepcopy(cfg)
        self.assertEqual(self.api.prepare(cfg), self.api.prepare(cfg))
        self.assertEqual(cfg, before)

    def test_writer_refuses_existing_or_symlink_destination(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); cfg = self.api.prepare(fixture())
            output = root / 'candidate'; self.api.write_candidate(cfg, output)
            self.assertTrue((output / 'ctl/overlay-patches.json').is_file())
            self.assertTrue((output / 'manifest.json').is_file())
            with self.assertRaises(ValueError):
                self.api.write_candidate(cfg, output)
            link = root / 'linked'; link.symlink_to(output, target_is_directory=True)
            with self.assertRaises(ValueError):
                self.api.write_candidate(cfg, link)


def source_render_command():
    """Require a real renderer, including kubectl's embedded Kustomize in CI."""
    kustomize = shutil.which('kustomize')
    if kustomize:
        return [kustomize, 'build']
    kubectl = shutil.which('kubectl')
    if kubectl:
        return [kubectl, 'kustomize']
    raise RuntimeError('kustomize or kubectl is required for offline source acceptance')


class WebsiteBackendRenderCommandTests(unittest.TestCase):
    def test_prefers_standalone_kustomize(self):
        with mock.patch.object(shutil, 'which', side_effect=lambda name: '/tools/' + name):
            self.assertEqual(source_render_command(), ['/tools/kustomize', 'build'])

    def test_uses_embedded_kustomize_when_only_kubectl_is_available(self):
        with mock.patch.object(shutil, 'which', side_effect=lambda name: '/tools/kubectl' if name == 'kubectl' else None):
            self.assertEqual(source_render_command(), ['/tools/kubectl', 'kustomize'])

    def test_missing_renderers_fail_instead_of_skipping_source_acceptance(self):
        with mock.patch.object(shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'kustomize or kubectl'):
                source_render_command()


class WebsiteBackendSourceRenderTests(unittest.TestCase):
    """Real regional source renders; omit only KSOPS, never decrypt/read Secret values."""

    @classmethod
    def setUpClass(cls):
        cls.api = module()
        cls.render_command = source_render_command()

    def render(self, path):
        result = subprocess.run([*self.render_command, str(path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return list(yaml.safe_load_all(result.stdout))

    def copy_sources(self, mirror):
        paths = ['ctl/k8s/base', 'site-gateway/k8s/base']
        for region in ['shprod', 'sgprod']:
            paths += [f'argocd/services/{service}/{region}' for service in
                      ['ctl', 'site-gateway', 'workers-website-deployer']]
        for name in paths:
            shutil.copytree(ROOT / name, mirror / name)
        for path in mirror.rglob('kustomization.yaml'):
            cfg = yaml.safe_load(path.read_text())
            cfg.pop('generators', None)  # Only runtime KSOPS generators; references stay unchanged.
            path.write_text(yaml.safe_dump(cfg))

    def test_both_production_regions_real_source_merge_and_preservation(self):
        for region in ['shprod', 'sgprod']:
            for phase in ['prepare', 'enable']:
                with self.subTest(region=region, phase=phase), tempfile.TemporaryDirectory() as tmp:
                    mirror = Path(tmp)
                    self.copy_sources(mirror)
                    output = mirror / 'rendered-bindings'
                    cfg = fixture(region)
                    self.api.write_candidate(self.api.prepare(cfg, phase), output)
                    for service, folder in [('ctl', 'ctl'), ('website-deployer', 'workers-website-deployer'),
                                            ('site-gateway', 'site-gateway')]:
                        overlay = mirror / f'argocd/services/{folder}/{region}'
                        baseline = self.render(overlay)
                        shutil.copytree(output / service, overlay / 'website-runtime')
                        path = overlay / 'kustomization.yaml'
                        k = yaml.safe_load(path.read_text())
                        k.setdefault('patches', []).extend(json.loads((overlay / 'website-runtime/overlay-patches.json').read_text()))
                        path.write_text(yaml.safe_dump(k))
                        rendered = self.render(overlay)
                        expected_targets = [t for t in self.api.TARGETS[region] if t[0] == service]
                        self.assertEqual(len(rendered), len(baseline))
                        for _, namespace, name, container_name, role in expected_targets:
                            dep = next(x for x in rendered if x.get('kind') == 'Deployment' and
                                       x['metadata']['name'] == name and x['metadata']['namespace'] == namespace)
                            pod = dep['spec']['template']['spec']
                            container = next(x for x in pod['containers'] if x['name'] == container_name)
                            env = {x['name']: x for x in container['env']}
                            own = 'WEBSITE_RUNTIME_' + role.upper() + '_TOKEN'
                            other = 'WEBSITE_RUNTIME_' + ('DEPLOY' if role == 'invoke' else 'INVOKE') + '_TOKEN'
                            self.assertEqual(env[own], {'name': own, 'valueFrom': {
                                'secretKeyRef': cfg['runtime'][role + '_token']}})
                            self.assertEqual(env[other], {'name': other, 'value': ''})
                            self.assertEqual(env['WEBSITE_RUNTIME_BASE_URL']['value'], cfg['runtime']['base_url'])
                            self.assertEqual(env['SSL_CERT_FILE']['value'], self.api.CA_PATH)
                            data_enabled = phase == 'enable' and cfg.get('data_enabled', False)
                            if service == 'ctl':
                                self.assertEqual(env['WEBSITE_BACKEND_ENABLED']['value'],
                                                 '1' if phase == 'enable' else '0')
                                self.assertEqual(env['WEBSITE_BACKEND_DATA_ENABLED']['value'], '1' if data_enabled else '0')
                            if service == 'site-gateway':
                                self.assertEqual(env['SITE_GATEWAY_BACKEND_SHARED_READ']['value'], str(data_enabled).lower())
                            volume = next(x for x in pod['volumes'] if x['name'] == 'website-runtime-ca')
                            self.assertEqual(volume['secret'], {'secretName': 'website-runtime-ca',
                                'defaultMode': 292, 'items': [{'key': 'ca-bundle.pem', 'path': 'ca-bundle.pem'}]})
                            mount = next(x for x in container['volumeMounts'] if x['name'] == 'website-runtime-ca')
                            self.assertEqual(mount, {'name': 'website-runtime-ca',
                                'mountPath': '/etc/website-runtime-tls', 'readOnly': True})
                            # Remove exactly the additions, then all old settings must match byte-for-object.
                            before = next(x for x in baseline if x.get('kind') == 'Deployment' and
                                          x['metadata']['name'] == name)
                            annotations = dep['spec']['template']['metadata']['annotations']
                            del annotations['website.lightvela.com/source-tree-sha256']
                            if not annotations and 'annotations' not in before['spec']['template']['metadata']:
                                dep['spec']['template']['metadata'].pop('annotations')
                            container['env'] = [x for x in container['env'] if x['name'] not in
                                {own, other, 'WEBSITE_RUNTIME_BASE_URL', 'SSL_CERT_FILE', 'WEBSITE_BACKEND_ENABLED',
                                 'WEBSITE_BACKEND_DATA_ENABLED', 'SITE_GATEWAY_BACKEND_SHARED_READ'}]
                            prior_container = next(c for c in before['spec']['template']['spec']['containers']
                                                   if c['name'] == container_name)
                            container['env'].extend(copy.deepcopy(v) for v in prior_container.get('env', [])
                                                    if v['name'] in {own, other, 'WEBSITE_RUNTIME_BASE_URL',
                                                                     'SSL_CERT_FILE', 'WEBSITE_BACKEND_ENABLED',
                                 'WEBSITE_BACKEND_DATA_ENABLED', 'SITE_GATEWAY_BACKEND_SHARED_READ'})
                            if not container['env'] and 'env' not in next(c for c in before['spec']['template']['spec']['containers']
                                                                       if c['name'] == container_name):
                                container.pop('env')
                            container['volumeMounts'].remove(mount)
                            if not container['volumeMounts']:
                                container.pop('volumeMounts')
                            pod['volumes'].remove(volume)
                            if not pod['volumes']:
                                pod.pop('volumes')
                        # Kubernetes strategic lists are keyed; retain every entry despite merge reordering.
                        for documents in [rendered, baseline]:
                            for document in documents:
                                if document.get('kind') != 'Deployment':
                                    continue
                                spec = document['spec']['template']['spec']
                                if 'volumes' in spec:
                                    spec['volumes'].sort(key=lambda x: x['name'])
                                for c in spec['containers']:
                                    for field in ['env', 'volumeMounts']:
                                        if field in c:
                                            c[field].sort(key=lambda x: x['name'])
                        key = lambda x: (x.get('kind', ''), x.get('metadata', {}).get('name', ''))
                        self.assertEqual(sorted(rendered, key=key), sorted(baseline, key=key))

    def test_hidden_release_creation_gate_is_explicitly_closed_in_all_ctl_consumers(self):
        for region in ['shprod', 'sgprod']:
            with self.subTest(region=region), tempfile.TemporaryDirectory() as tmp:
                mirror = Path(tmp)
                self.copy_sources(mirror)
                documents = self.render(mirror / f'argocd/services/ctl/{region}')
                for name in ['ctl-api', 'ctl-service', 'ctl-bypass']:
                    dep = next(x for x in documents if x.get('kind') == 'Deployment' and x['metadata']['name'] == name)
                    container = dep['spec']['template']['spec']['containers'][0]
                    variables = {v['name']: v for v in container.get('env', [])}
                    self.assertEqual(variables.get('WEBSITE_BACKEND_BETA_USERS'),
                                     {'name': 'WEBSITE_BACKEND_BETA_USERS', 'value': ''})

    def test_explicit_values_override_envfrom_and_old_key_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = fixture()
            self.api.write_candidate(self.api.prepare(cfg), root / 'bindings')
            source = {'apiVersion': 'apps/v1', 'kind': 'Deployment',
                'metadata': {'name': 'site-gateway', 'namespace': 'ctl'},
                'spec': {'template': {'spec': {'containers': [{'name': 'site-gateway', 'image': 'unchanged',
                    'envFrom': [{'secretRef': {'name': 'legacy-combined-secrets'}}],
                    'env': [{'name': 'WEBSITE_RUNTIME_INVOKE_TOKEN', 'valueFrom': {
                                'configMapKeyRef': {'name': 'old-config', 'key': 'token'}}},
                            {'name': 'WEBSITE_RUNTIME_DEPLOY_TOKEN', 'valueFrom': {
                                'secretKeyRef': {'name': 'legacy-combined-secrets', 'key': 'deploy'}}}]}]}}}}
            (root / 'deployment.json').write_text(json.dumps(source))
            (root / 'kustomization.yaml').write_text(json.dumps({'apiVersion': 'kustomize.config.k8s.io/v1beta1',
                'kind': 'Kustomization', 'resources': ['deployment.json'], 'patches': json.loads((root / 'bindings/site-gateway/overlay-patches.json').read_text())}))
            pod = self.render(root)[0]['spec']['template']['spec']
            container = pod['containers'][0]
            env = {x['name']: x for x in container['env']}
            self.assertEqual(container['envFrom'], source['spec']['template']['spec']['containers'][0]['envFrom'])
            self.assertEqual(env['WEBSITE_RUNTIME_DEPLOY_TOKEN'], {'name': 'WEBSITE_RUNTIME_DEPLOY_TOKEN', 'value': ''})
            self.assertEqual(env['WEBSITE_RUNTIME_INVOKE_TOKEN'], {'name': 'WEBSITE_RUNTIME_INVOKE_TOKEN',
                'valueFrom': {'secretKeyRef': cfg['runtime']['invoke_token']}})


if __name__ == '__main__':
    unittest.main()
