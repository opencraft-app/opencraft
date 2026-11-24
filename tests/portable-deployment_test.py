import importlib.util
import os
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'deploy/docker/deploy/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

def bind(source, target, **extra):
    return dict({'type': 'bind', 'source': source, 'target': target, 'bind': {'create_host_path': False}}, **extra)

def fixture(root='/srv/one'):
    # Mirrors `docker compose config` of compose.yaml + compose.role-images.yaml + compose.portable.yaml.
    base = {'OPENCRAFT_DATA_DIR': '/var/lib/opencraft', 'OPENCRAFT_WORKSPACE_DIR': '/workspace',
            'OPENCRAFT_EXECUTION_DIR': '/var/lib/opencraft/execution', 'OPENCRAFT_LOG_DIR': '/var/log/opencraft'}
    budget = {'OPENCRAFT_HANDS_CPUS': '2', 'OPENCRAFT_HANDS_MEMORY_BYTES': '4294967296'}
    agent = {'OPENCRAFT_AGENT_RUN_DIR': '/run/opencraft-agent', 'OPENCRAFT_AGENT_LINK_DIR': '/run/opencraft-link'}
    env = {'gateway': dict(base, **budget, OPENCRAFT_BRAIN_CPUS='2', OPENCRAFT_BRAIN_MEMORY_BYTES='4294967296',
                           OPENCRAFT_WORKSPACE_ENVIRONMENTS='static-docker://brain static-docker://hands',
                           OPENCRAFT_WORKSPACE_LINK_ROOT='/run/opencraft-links', OPENCRAFT_GATEWAY_RUN_DIR='/run/opencraft-gateway',
                           OPENCRAFT_AGENT_RUN_DIR='/run/opencraft-agent'),
           'brain': dict(base, **budget, **agent, OPENCRAFT_PROXY_MODE='external', OPENCRAFT_PROXY_PORT='46071'),
           'hands': dict(base, **budget, **agent),
           'proxy': dict(base, OPENCRAFT_PROXY_PORT='46071')}
    mounts = {'DATA': bind(root + '/state', '/var/lib/opencraft'), 'EXECUTION': bind(root + '/execution', '/var/lib/opencraft/execution'),
              'WORKSPACE': bind(root + '/workspace', '/workspace')}
    services = {}
    for index, role in enumerate(deploy.ROLES):
        services[role] = {'user': '994:990', 'platform': 'linux/amd64', 'network_mode': 'host',
            'image': 'registry.example/team/app@sha256:' + str(index)*64, 'environment': env[role],
            'volumes': [dict(mounts[key]) for key in deploy.SHARED[role]]}
    for role in ('brain', 'hands'):
        services[role].update(tmpfs=['/run/opencraft-agent:uid=994,gid=990,mode=0700,size=16m'], cpus=2, mem_limit='4294967296')
        services[role]['volumes'].append({'type': 'volume', 'source': role + '-link', 'target': '/run/opencraft-link'})
        services['gateway']['volumes'].append({'type': 'volume', 'source': role + '-link', 'target': '/run/opencraft-links/' + role})
    services['gateway'].update(tmpfs=['/run/opencraft-gateway:uid=994,gid=990,mode=0700,size=1m'],
        command=['--host', '127.0.0.1', '--port', '11080', '--access-control'],
        healthcheck={'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:11080/health')"]})
    link = {'driver': 'local', 'driver_opts': {'type': 'tmpfs', 'device': 'tmpfs', 'o': 'uid=994,gid=990,mode=0700,size=1m'}}
    config = {'services': services, 'volumes': {'brain-link': deepcopy(link), 'hands-link': deepcopy(link)}}
    return config, {'images': {role: value['image'] for role, value in services.items()}}

def mount(service, target):
    return next(v for v in service['volumes'] if v['target'] == target)

class Safety(unittest.TestCase):
    def test_workspace_socket_accepts_distinct_container_paths_and_requires_a_bind(self):
        config, release = fixture()
        gateway, brain = (config['services'][role] for role in ('gateway', 'brain'))
        variable = 'OPENCRAFT_WORKSPACE_AUTHORITY_SOCKET'
        gateway['environment'][variable] = '/var/lib/opencraft/run/workspace-authority.sock'
        brain['environment'][variable] = '/var/lib/opencraft/alias/workspace-authority.sock'
        deploy.validate(config, release)
        brain['environment'][variable] = '/run/opencraft-link/workspace-authority.sock'
        with self.assertRaisesRegex(ValueError, 'inside a shared bind'):
            deploy.validate(config, release)
        brain['environment'].pop(variable)
        with self.assertRaisesRegex(ValueError, 'for brain'):
            deploy.validate(config, release)

    def test_manifest_locks_both_gateway_artifacts(self):
        config, release = fixture()
        gateway = config['services']['gateway']
        env = gateway['environment']
        env.update(
            OPENCRAFT_GATEWAY_COMPOSITION_DIRECTORY='/run/opencraft-composition',
            OPENCRAFT_GATEWAY_COMPOSITION_SHA256='a' * 64,
            OPENCRAFT_GATEWAY_WEB_RELEASE_DIRECTORY='/run/product-web',
            OPENCRAFT_GATEWAY_WEB_RELEASE_SHA256='b' * 64,
        )
        gateway['volumes'] += [
            bind('/release/composition', '/run/opencraft-composition', read_only=True),
            bind('/release/web', '/run/product-web', read_only=True),
        ]
        release['gatewayArtifacts'] = {'compositionSha256': 'a' * 64, 'webSha256': 'b' * 64}
        deploy.validate(config, release)
        gateway['volumes'][-1]['read_only'] = False
        with self.assertRaisesRegex(ValueError, 'Web release requires a Gateway-only read-only bind'):
            deploy.validate(config, release)
        gateway['volumes'][-1]['read_only'] = True
        env['OPENCRAFT_GATEWAY_WEB_RELEASE_SHA256'] = 'c' * 64
        with self.assertRaisesRegex(ValueError, 'differ from release.json'):
            deploy.validate(config, release)

    def test_personal_git_is_configurable_but_never_half_enabled(self):
        from copy import deepcopy
        for host, runtime in [('/srv/one/git', '/var/lib/opencraft/git-credentials'),
                              ('/mnt/disk/git', '/run/private/git')]:
            config, release = fixture()
            for role in ('gateway', 'brain', 'hands'):
                config['services'][role]['environment'].update(OPENCRAFT_GIT_RUNTIME_DIRECTORY=runtime,
                    OPENCRAFT_GIT_HOSTS='git.example.com,github.com',
                    OPENCRAFT_GIT_WORKER_FILE='/opt/opencraft/runtime/personal-git-worker.mjs')
                config['services'][role]['volumes'].append({'type':'bind','source':host,'target':runtime,'bind':{'create_host_path':False}})
            deploy.validate(config, release)
            self.assertEqual(deploy.directory_plan(config['services'], (994,990))[host], (994,990))
            for mutate in [lambda s:s['brain']['environment'].pop('OPENCRAFT_GIT_RUNTIME_DIRECTORY'),
                           lambda s:s['hands']['environment'].update(OPENCRAFT_GIT_HOSTS='github.com'),
                           lambda s:s['gateway']['environment'].update(OPENCRAFT_GIT_HOSTS='github.com,'),
                           lambda s:s['gateway']['environment'].update(OPENCRAFT_GIT_WORKER_FILE='/tmp/custom.mjs'),
                           lambda s:s['brain']['volumes'][-1].update(source='/other'),
                           lambda s:s['hands']['volumes'][-1].update(read_only=True),
                           lambda s:s['hands']['volumes'].pop()]:
                changed=deepcopy(config);mutate(changed['services'])
                with self.assertRaises(ValueError):deploy.validate(changed,release)

    def test_environment_delivery_is_one_gateway_and_brain_decision(self):
        from copy import deepcopy
        def state(config):
            return config  # Gateway and Brain already share the state mount.
        config, release = fixture()
        deploy.validate(config, release)
        for gateway, brain in [('opaque', 'opaque'), ('vault-owner', 'opaque'), ('opaque', 'vault-owner')]:
            changed = state(deepcopy(config))
            changed['services']['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY=gateway,
                OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION='2026-11',
                OPENCRAFT_ENVIRONMENT_ISSUER_FILE='/var/lib/opencraft/run/environment-issuer.json')
            changed['services']['brain']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY=brain)
            deploy.validate(changed, release)
        enabled = state(deepcopy(config))
        for role in ('gateway', 'brain'):
            enabled['services'][role]['environment']['OPENCRAFT_ENVIRONMENT_DELIVERY'] = 'opaque'
        deploy.validate(enabled, release)
        for base, mutate in [(enabled, lambda s:s['brain']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY='')),
                             (enabled, lambda s:s['brain']['environment'].pop('OPENCRAFT_ENVIRONMENT_DELIVERY')),
                             (enabled, lambda s:s['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY='')),
                             (enabled, lambda s:[s[r]['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY='sync') for r in ('gateway','brain')]),
                             (enabled, lambda s:s['hands']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY='other')),
                             (enabled, lambda s:s['brain']['environment'].update(OPENCRAFT_EXECUTION_CONTEXT='legacy')),
                             (enabled, lambda s:s['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_ISSUER_FILE='/elsewhere/issuer.json')),
                             (enabled, lambda s:s['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION='a b')),
                             (enabled, lambda s:mount(s['brain'], '/var/lib/opencraft').update(source='/srv/other/state')),
                             (enabled, lambda s:s['brain']['volumes'].remove(mount(s['brain'], '/var/lib/opencraft'))),
                             (config, lambda s:s['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_DELIVERY='opaque')),
                             (config, lambda s:s['gateway']['environment'].update(OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION='2'))]:
            changed = deepcopy(base); mutate(changed['services'])
            with self.assertRaises(ValueError): deploy.validate(changed, release)

    def test_feature_flags_are_explicit_not_inherited_or_duplicated(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);site=root/'site.env'
            (root / 'release.json').write_text('{}')
            for flags, names in [('OPENCRAFT_HANDS_ROOT=1\nOPENCRAFT_PERSONAL_GIT=1\n', ['compose.root-hands.yaml','compose.personal-git.yaml']),
                                 ('OPENCRAFT_HANDS_ROOT=0\nOPENCRAFT_PERSONAL_GIT=0\n', [])]:
                site.write_text(flags)
                with patch.object(deploy,'ROOT',root),patch.object(deploy,'run') as run:
                    deploy.compose('config')
                    args=run.call_args[0][0]
                    for name in deploy.COMPOSE_FILES:
                        self.assertIn(str(root/name), args)
                    for name in ('compose.root-hands.yaml','compose.personal-git.yaml'):
                        self.assertEqual(str(root/name) in args,name in names)
            for flags in ['OPENCRAFT_PERSONAL_GIT=yes\n', 'OPENCRAFT_PERSONAL_GIT=1\nOPENCRAFT_PERSONAL_GIT=0\n',
                          'OPENCRAFT_BROWSER_OWNER_SOCKET=/var/lib/opencraft/execution/owner.sock\n']:
                site.write_text(flags)
                with patch.object(deploy,'ROOT',root),patch.object(deploy,'run') as run:
                    with self.assertRaises(ValueError):deploy.compose('config')
                    run.assert_not_called()

    def test_portable_host_layouts(self):
        for root in ('/srv/one', '/mnt/another/disk'):
            config, release = fixture(root)
            identity, paths, ports = deploy.validate(config, release)
            self.assertEqual(identity, (994, 990)); self.assertEqual(ports, [11080, 46071])
            self.assertTrue(all(path.startswith(root) for path in paths))
    def test_retained_probe_uses_every_rendered_role_identity_and_mount(self):
        from unittest.mock import patch
        import json
        config, _ = fixture()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'retained-workspaces.json').write_text(json.dumps([{'cwd': '/data'}]))
            (root / 'workspace-preflight.mjs').write_text('probe-source')
            with patch.object(deploy, 'ROOT', root), patch.object(deploy, 'run') as run:
                deploy.retained_workspace_check(config['services'])
                self.assertEqual(run.call_count, 4)
                for call, role in zip(run.call_args_list, deploy.ROLES):
                    args = call.args[0]
                    self.assertEqual(args[args.index('--user') + 1], config['services'][role]['user'])
                    self.assertIn(config['services'][role]['image'], args)
                    self.assertIn('type=bind,source=/srv/one/workspace,target=/workspace', args)
                    self.assertEqual(json.loads(call.kwargs['input']), [{'cwd': '/data'}])
                    self.assertEqual(args[-2:], ['--', '--retained-workspace-probe'])
            (root / 'retained-workspaces.json').unlink()
            with patch.object(deploy, 'ROOT', root), patch.object(deploy, 'run') as run:
                deploy.retained_workspace_check(config['services'])
                run.assert_not_called()

    def test_root_hands_preserves_clients_and_private_directory_owners(self):
        from copy import deepcopy
        config, release = fixture(); hands = config['services']['hands']; env = hands['environment']
        hands.update(user='0:0', cap_drop=['ALL'], cap_add=['SYS_ADMIN','SETUID','SETGID','SYS_CHROOT','DAC_OVERRIDE','CHOWN','FOWNER','KILL'],
                     tmpfs=['/run/opencraft-agent:uid=0,gid=0,mode=0700,size=16m'])
        env.update(OPENCRAFT_HANDS_CLIENT_UID='994', OPENCRAFT_HANDS_CLIENT_GID='990',
                   OPENCRAFT_HANDS_CLIENT_DIRECTORY=env['OPENCRAFT_EXECUTION_DIR'],
                   OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY='/run/hands/server',
                   OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY='/run/hands/execution', OPENCRAFT_EXECUTION_DIR='/run/hands/server')
        hands['volumes'].append({'type':'bind','source':'/srv/one','target':'/run/hands','bind':{'create_host_path':False}})
        hands['volumes'].append({'type':'bind','source':'/srv/one/log/hands','target':'/var/log/opencraft/hands','bind':{'create_host_path':False}})
        identity, _, _ = deploy.validate(config, release)
        self.assertEqual(identity, (994,990))
        plan = deploy.directory_plan(config['services'], identity)
        self.assertEqual(plan['/srv/one/server'], (0,0))
        self.assertEqual(plan['/srv/one/execution'], (994,990))
        self.assertEqual(plan['/srv/one/log/hands'], (0,0))
        for mutate in [lambda s:s['gateway'].update(user='0:0'),
                       lambda s:s['hands'].update(user='0:990'),
                       lambda s:s['hands']['environment'].update(OPENCRAFT_HANDS_CLIENT_UID='0'),
                       lambda s:s['hands']['environment'].update(OPENCRAFT_HANDS_BROWSER_NAME='../elsewhere'),
                       lambda s:s['hands']['environment'].update(OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY='/elsewhere/client'),
                       lambda s:s['hands'].update(cap_add=['SYS_ADMIN']),
                       # An old Compose merges the root tmpfs with the client one instead of replacing it.
                       lambda s:s['hands']['tmpfs'].append('/run/opencraft-agent:uid=994,gid=990,mode=0700,size=16m'),
                       lambda s:s['hands'].update(tmpfs=['/run/opencraft-agent:uid=994,gid=990,mode=0700,size=16m']),
                       lambda s:s['hands']['volumes'].append({'type':'bind','source':'/other','target':'/run/hands/execution','bind':{'create_host_path':False}})]:
            changed=deepcopy(config);mutate(changed['services'])
            with self.assertRaises(ValueError):deploy.validate(changed,release)
        args=deploy.probe_args(hands)
        self.assertIn('DAC_OVERRIDE', args)
        for cap in ['CHOWN','SYS_ADMIN','SETUID']:self.assertNotIn(cap,args)

    def test_workspace_model_links_tmpfs_budgets_and_retired_variables(self):
        config, release = fixture()
        identity, _, _ = deploy.validate(config, release)
        plan = deploy.directory_plan(config['services'], identity)
        # The separate execution directory's mount point inside the state mount is created privately.
        self.assertEqual(plan['/srv/one/state/execution'], (994, 990))
        self.assertEqual(plan['/srv/one/execution'], (994, 990))
        for mutate in [
            lambda c: c['services']['brain'].pop('tmpfs'),
            lambda c: c['services']['brain'].update(tmpfs=['/run/opencraft-agent:uid=994,gid=990,mode=0755,size=16m']),
            lambda c: c['services']['hands']['volumes'].append(bind('/srv/one/run', '/run/opencraft-agent')),
            lambda c: c['services']['hands']['environment'].pop('OPENCRAFT_AGENT_LINK_DIR'),
            lambda c: c['services']['proxy']['volumes'].append({'type': 'volume', 'source': 'hands-link', 'target': '/run/opencraft-link'}),
            lambda c: c['services']['brain']['volumes'].append({'type': 'volume', 'source': 'hands-link', 'target': '/run/x'}),
            lambda c: c['services']['gateway']['volumes'].pop(),
            lambda c: c['services']['gateway'].pop('tmpfs'),
            lambda c: c['services']['proxy'].update(tmpfs=['/run/opencraft-agent:uid=994,gid=990,mode=0700']),
            lambda c: c['volumes']['brain-link']['driver_opts'].update(type='none', device='/srv/one/link'),
            lambda c: c['volumes']['hands-link']['driver_opts'].update(o='uid=0,gid=0,mode=0700'),
            lambda c: c['services']['gateway']['environment'].update(OPENCRAFT_WORKSPACE_ENVIRONMENTS='static-docker://brain'),
            lambda c: c['services']['gateway']['environment'].update(OPENCRAFT_BROWSER_OWNER_SOCKET='/var/lib/opencraft/execution/browser/owner.sock'),
            lambda c: c['services']['brain']['environment'].update(OPENCRAFT_PROXY_MODE='embedded'),
            lambda c: c['services']['brain']['environment'].update(OPENCRAFT_PROXY_PORT='45071'),
            lambda c: c['services']['brain'].update(cpus=4),
            lambda c: c['services']['hands'].update(mem_limit='8589934592'),
            lambda c: c['services']['gateway']['environment'].pop('OPENCRAFT_BRAIN_MEMORY_BYTES'),
            lambda c: c['services']['gateway'].update(healthcheck={'test': ["fetch('http://127.0.0.1:10000/health')"]}),
            lambda c: c['services']['gateway']['volumes'].remove(mount(c['services']['gateway'], '/var/lib/opencraft/execution')),
            lambda c: mount(c['services']['proxy'], '/var/lib/opencraft').update(source='/srv/other/state'),
        ]:
            changed = deepcopy(config); mutate(changed)
            with self.assertRaises(ValueError): deploy.validate(changed, release)

    def test_compose_version_gates_reset_and_root_hands_override(self):
        nonroot, root = {}, {'OPENCRAFT_HANDS_ROOT': '1'}
        self.assertEqual(deploy.compose_version_check('v2.24.0\n', nonroot), (2, 24, 0))
        self.assertEqual(deploy.compose_version_check('5.7.1', root), (5, 7, 1))
        self.assertEqual(deploy.compose_version_check('2.24.4-desktop.1', root), (2, 24, 4))
        for version, settings in [('2.23.3', nonroot), ('2.24.3', root), ('1.29.2', nonroot), ('unknown', nonroot)]:
            with self.assertRaises(ValueError): deploy.compose_version_check(version, settings)
        with self.assertRaisesRegex(ValueError, 'OPENCRAFT_HANDS_ROOT=1'): deploy.compose_version_check('2.24.1', root)

    def test_bad_contracts(self):
        for mutate in (
            lambda s: s['hands'].update(user='0:0'),
            lambda s: s['brain']['environment'].update(OPENCRAFT_HANDS_CPUS='4'),
            lambda s: s['brain']['environment'].pop('OPENCRAFT_HANDS_MEMORY_BYTES'),
            lambda s: s['proxy'].update(image='app:latest'),
            lambda s: s['gateway'].update(build={'context':'/old/machine'}),
            lambda s: s['hands'].update(privileged=True),
            # Execution identity is reported over workspace endpoints, never read from another role's /proc.
            lambda s: s['gateway'].update(pid='host'),
            lambda s: s['brain'].update(pid='host'),
            lambda s: s['hands'].update(pid='service:brain'),
            lambda s: s['gateway']['volumes'].pop(),
            lambda s: s['gateway']['volumes'][1].update(source='/other'),
            lambda s: s['brain']['volumes'][0].update(source='/'),
            lambda s: s['brain']['volumes'][0].update(read_only=True),
            lambda s: s['gateway'].update(command=['--port','46071']),
        ):
            config, release = fixture(); mutate(config['services'])
            with self.assertRaises(ValueError): deploy.validate(config, release)
    def test_private_dirs_no_silent_reown_or_symlinks(self):
        identity = os.getuid(), os.getgid()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'data'; path.mkdir(mode=0o700)
            deploy.ensure_directory(str(path), identity)
            path.chmod(0o755)
            with self.assertRaises(ValueError): deploy.ensure_directory(str(path), identity, create=True)
            self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            alias = Path(temp) / 'alias'; alias.symlink_to(path, target_is_directory=True)
            with self.assertRaises(ValueError): deploy.ensure_directory(str(alias), identity)
            with self.assertRaises(ValueError): deploy.ensure_directory(str(alias / 'child'), identity, create=True)
            self.assertFalse((path / 'child').exists())

if __name__ == "__main__":
    unittest.main()
