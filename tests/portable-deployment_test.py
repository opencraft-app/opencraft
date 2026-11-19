import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1] / 'docker/deploy/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

def fixture(root='/srv/one'):
    env = {'OPENCRAFT_HANDS_CPUS': '2', 'OPENCRAFT_HANDS_MEMORY_BYTES': '4294967296', 'OPENCRAFT_DATA_DIR': '/var/lib/opencraft', 'OPENCRAFT_WORKSPACE_DIR': '/workspace',
           'OPENCRAFT_EXECUTION_DIR': '/var/lib/opencraft/execution', 'OPENCRAFT_LOG_DIR': '/var/log/opencraft', 'OPENCRAFT_PROXY_PORT': '46071'}
    services = {}
    for index, role in enumerate(deploy.ROLES):
        services[role] = {'user': '994:990', 'platform': 'linux/amd64', 'network_mode': 'host',
            'image': 'registry.example/team/app@sha256:' + str(index)*64, 'environment': env.copy(),
            'volumes': [{'type': 'bind', 'source': root + '/' + key.lower(), 'target': env['OPENCRAFT_'+key+'_DIR'],
                         'bind': {'create_host_path': False}} for key in ('WORKSPACE', 'EXECUTION')]}
    services['gateway']['command'] = ['--port', '11080', '--access-control']
    return {'services': services}, {'images': {role: value['image'] for role, value in services.items()}}

class Safety(unittest.TestCase):
    def test_personal_git_is_configurable_but_never_half_enabled(self):
        from copy import deepcopy
        for host, runtime in [('/srv/one/git', '/var/lib/opencraft/git-credentials'),
                              ('/mnt/disk/git', '/run/private/git')]:
            config, release = fixture()
            for role in ('gateway', 'brain', 'hands'):
                config['services'][role]['environment'].update(OPENCRAFT_GIT_RUNTIME_DIRECTORY=runtime,
                    OPENCRAFT_GIT_HOSTS='git.woa.com,github.com',
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

    def test_feature_flags_are_explicit_not_inherited_or_duplicated(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);site=root/'site.env'
            for flags, names in [('OPENCRAFT_HANDS_ROOT=1\nOPENCRAFT_PERSONAL_GIT=1\n', ['compose.root-hands.yaml','compose.personal-git.yaml']),
                                 ('OPENCRAFT_HANDS_ROOT=0\nOPENCRAFT_PERSONAL_GIT=0\n', [])]:
                site.write_text(flags)
                with patch.object(deploy,'ROOT',root),patch.object(deploy,'run') as run:
                    deploy.compose('config')
                    args=run.call_args[0][0]
                    for name in ('compose.root-hands.yaml','compose.personal-git.yaml'):
                        self.assertEqual(str(root/name) in args,name in names)
            for flags in ['OPENCRAFT_PERSONAL_GIT=yes\n', 'OPENCRAFT_PERSONAL_GIT=1\nOPENCRAFT_PERSONAL_GIT=0\n']:
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
        hands.update(user='0:0', cap_drop=['ALL'], cap_add=['SYS_ADMIN','SETUID','SETGID','SYS_CHROOT','DAC_OVERRIDE','CHOWN','FOWNER','KILL'])
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
                       lambda s:s['hands']['volumes'].append({'type':'bind','source':'/other','target':'/run/hands/execution','bind':{'create_host_path':False}})]:
            changed=deepcopy(config);mutate(changed['services'])
            with self.assertRaises(ValueError):deploy.validate(changed,release)
        args=deploy.probe_args(hands)
        self.assertIn('DAC_OVERRIDE', args)
        for cap in ['CHOWN','SYS_ADMIN','SETUID']:self.assertNotIn(cap,args)

    def test_bad_contracts(self):
        for mutate in (
            lambda s: s['hands'].update(user='0:0'),
            lambda s: s['brain']['environment'].update(OPENCRAFT_HANDS_CPUS='4'),
            lambda s: s['brain']['environment'].pop('OPENCRAFT_HANDS_MEMORY_BYTES'),
            lambda s: s['proxy'].update(image='app:latest'),
            lambda s: s['gateway'].update(build={'context':'/old/machine'}),
            lambda s: s['hands'].update(privileged=True),
            lambda s: s['gateway']['volumes'].pop(),
            lambda s: s['gateway']['volumes'][1].update(source='/other'),
            lambda s: s['brain']['volumes'][0].update(source='/'),
            lambda s: s['brain']['volumes'][0].update(read_only=True),
            lambda s: s['gateway'].update(command=['--port','46071']),
        ):
            config, release = fixture(); mutate(config['services'])
            with self.assertRaises(ValueError): deploy.validate(config, release)
    def test_join_requires_own_private_hub_enrollment(self):
        import json
        config, _ = fixture()
        with tempfile.TemporaryDirectory() as temp:
            config['services']['gateway']['volumes'].append({'source': temp, 'target': '/var/lib/opencraft'})
            with self.assertRaisesRegex(ValueError, 'independent Tencent OA'): deploy.gateway_enrollment_check(config['services'])
            state = Path(temp) / 'hub-network.json'
            state.write_text(json.dumps({'authority': {'providers': ['tencentoa']}}))
            state.chmod(0o600)
            deploy.gateway_enrollment_check(config['services'])
            state.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'independent Tencent OA'): deploy.gateway_enrollment_check(config['services'])

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

unittest.main()
