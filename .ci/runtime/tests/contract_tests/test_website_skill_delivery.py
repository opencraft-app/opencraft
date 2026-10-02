import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('skill_bundle', ROOT / 'images/helpers/website_skill_bundle.py')
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class SkillDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        (self.source / 'scripts').mkdir(parents=True)
        (self.source / 'SKILL.md').write_text('skill v1')
        (self.source / 'scripts/package_fullstack.py').write_text('print("v1")')
        self.home = self.root / 'home'
        (self.home / '.hermes').mkdir(parents=True)
        self.credentials = self.home / '.hermes/.env'
        self.credentials.write_text('fixture credential bytes\n')

    def test_bundle_reproducible_and_complete(self):
        first = bundle.build(self.source)
        self.assertEqual(first, bundle.build(self.source))
        self.assertEqual(set(first['files']), {'SKILL.md', 'scripts/package_fullstack.py'})
        self.assertEqual(bundle.decode(bundle.encode(first)), first)

    def test_install_upgrade_rollback_preserves_credentials(self):
        first = bundle.build(self.source)
        self.assertEqual(bundle.install(first, self.home)['active'], first['version'])
        (self.source / 'SKILL.md').write_text('skill v2')
        second = bundle.build(self.source)
        bundle.install(second, self.home)
        self.assertEqual(bundle.install(second, self.home)['active'], second['version'])
        self.assertEqual(bundle.rollback(second['version'], self.home)['active'], first['version'])
        self.assertEqual((self.home / '.hermes/skills/website-builder/SKILL.md').read_text(), 'skill v1')
        self.assertEqual(self.credentials.read_text(), 'fixture credential bytes\n')
        with self.assertRaises(ValueError):
            bundle.rollback(second['version'], self.home)

    def test_refuses_tampering_and_symlinks(self):
        data = bundle.build(self.source)
        data['files']['SKILL.md'] = 'dGFtcGVy'
        with self.assertRaises(ValueError):
            bundle.install(data, self.home)
        (self.source / 'SKILL.md').unlink()
        (self.source / 'SKILL.md').symlink_to(self.credentials)
        with self.assertRaises(ValueError):
            bundle.build(self.source)

    def test_refuses_corrupt_installed_version(self):
        data = bundle.build(self.source)
        bundle.install(data, self.home)
        (self.home / '.hermes/skills/website-builder/SKILL.md').write_text('tamper')
        with self.assertRaises(ValueError):
            bundle.install(data, self.home)

    def test_tat_content_includes_complete_bundle_without_credentials(self):
        data = bundle.build(self.source)
        script = bundle.command(data)
        self.assertLess(len(script.encode()), 64000)
        self.assertIn('python3', script)
        self.assertNotIn('fixture credential', script)

    def test_legacy_directory_upgrade_and_rollback(self):
        active = self.home / '.hermes/skills/website-builder'
        active.mkdir(parents=True)
        (active / 'SKILL.md').write_text('legacy skill')
        (active / 'custom.txt').write_text('retain exact old directory')
        data = bundle.build(self.source)
        bundle.install(data, self.home)
        self.assertFalse(active.is_symlink())
        self.assertEqual(bundle.rollback(data['version'], self.home)['active'], 'legacy')
        self.assertEqual((active / 'custom.txt').read_text(), 'retain exact old directory')
        self.assertEqual((active / 'SKILL.md').read_text(), 'legacy skill')

    def test_self_contained_tat_payload_runs_and_is_discoverable(self):
        import os
        import subprocess
        data = bundle.build(ROOT / '.agents/skills/website-builder')
        result = subprocess.run(['bash'], input=bundle.command(data), text=True,
                                capture_output=True, env=dict(os.environ, HOME=str(self.home)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(data['version'], result.stdout)
        discovered = list((self.home / '.hermes/skills').rglob('SKILL.md'))
        self.assertEqual(discovered, [self.home / '.hermes/skills/website-builder/SKILL.md'])
        self.assertEqual(self.credentials.read_text(), 'fixture credential bytes\n')


class RolloutTests(unittest.TestCase):
    def setUp(self):
        import argparse
        spec = importlib.util.spec_from_file_location('rollout_skill', ROOT / '.ci/runtime/support/rollout_website_skill.py')
        self.rollout = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.rollout)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.args = argparse.Namespace(state_file=self.root / 'state.json', canary='ins-one', resume_after_canary=None, reconcile=[], command_id='cmd-fixture', retry_failed=False, poll_timeout=1, limit=100, batch_size=10)
        self.config = {'version': 'a' * 64, 'action': 'install'}
        self.tat = self.FakeTAT(self.config['version'])

    class FakeTAT:
        def __init__(self, version):
            self.version = version
            self.calls = []
            self.invocations = {}
            self.fail = False
            self.bad_output = False

        def verify_command(self, *args):
            pass

        def call(self, action, **params):
            self.calls.append((action, params))
            invocation = 'inv-' + str(len(self.calls))
            self.invocations[invocation] = params['InstanceIds']
            if self.fail:
                raise ValueError('simulated lost response')
            return {'InvocationId': invocation}

        def tasks(self, invocation):
            import base64
            result = {'active': self.version, 'action': 'install'}
            output = 'wrong output' if self.bad_output else 'WEBSITE_SKILL_RESULT=' + json.dumps(result)
            return [{'InstanceId': cloud, 'InvocationId': invocation, 'CommandId': 'cmd-fixture', 'TaskStatus': 'SUCCESS', 'TaskResult': {'ExitCode': 0, 'Output': base64.b64encode(output.encode()).decode(), 'Dropped': 0}} for cloud in self.invocations[invocation]]

    def run_rollout(self):
        return self.rollout.execute(self.args, ['ins-one', 'ins-two'], self.config, 'content', self.tat)

    def test_canary_gate_resume_and_idempotent_success(self):
        first = self.run_rollout()
        self.assertEqual(first['counts'], {'SUCCESS': 1, 'PENDING': 1})
        self.args.canary = None
        with self.assertRaises(ValueError):
            self.run_rollout()
        self.args.resume_after_canary = first['canary_ack']
        self.assertEqual(self.run_rollout()['counts'], {'SUCCESS': 2})
        self.run_rollout()
        self.assertEqual(len(self.tat.calls), 2)

    def test_lost_ack_fenced_then_reconciled_without_reinvoke(self):
        self.tat.fail = True
        with self.assertRaises(ValueError):
            self.run_rollout()
        self.tat.fail = False
        with self.assertRaises(ValueError):
            self.run_rollout()
        self.assertEqual(len(self.tat.calls), 1)
        self.args.reconcile = ['ins-one=inv-1']
        self.assertEqual(self.run_rollout()['counts']['SUCCESS'], 1)
        self.assertEqual(len(self.tat.calls), 1)

    def test_exit_zero_without_digest_receipt_not_success(self):
        self.tat.bad_output = True
        with self.assertRaises(ValueError):
            self.run_rollout()
        state = json.loads(self.args.state_file.read_text())
        self.assertEqual(state['rows']['ins-one']['status'], 'FAILED')
        with self.assertRaises(ValueError):
            self.run_rollout()
        self.assertEqual(len(self.tat.calls), 1)

    def test_state_cannot_reuse_for_new_version(self):
        self.run_rollout()
        self.config = dict(self.config, version='b' * 64)
        with self.assertRaises(ValueError):
            self.run_rollout()
        self.assertEqual(len(self.tat.calls), 1)

    def test_inventory_excludes_all_duplicate_members(self):
        path = self.root / 'inventory.csv'
        path.write_text('user_id,business_instance_id,sandbox_id,cvm_instance_id,environment,region,status,sandbox_instance_state,eligible\n'
                        'usr_1,inst_1,sb_1,ins-one,shprod,ap-shanghai,Running,ALLOCATED,true\n'
                        'usr_2,inst_2,sb_2,ins-one,shprod,ap-shanghai,Paused,ALLOCATED,false\n'
                        'usr_3,inst_3,sb_3,ins-two,shprod,ap-shanghai,Running,ALLOCATED,true\n')
        path.chmod(0o600)
        targets, excluded = self.rollout.inventory(path, 'shprod')
        self.assertEqual(targets, ['ins-two'])
        self.assertEqual(excluded, {'duplicate_mapping': 2})

    def test_dry_run_never_calls_tat_or_creates_state(self):
        from unittest.mock import patch
        self.test_inventory_excludes_all_duplicate_members()
        with patch.object(self.rollout, 'TAT', side_effect=AssertionError('cloud call in dry-run')):
            self.assertEqual(self.rollout.main(['--csv', str(self.root / 'inventory.csv'), '--environment', 'shprod', '--state-file', str(self.args.state_file)]), 0)
        self.assertFalse(self.args.state_file.exists())

    def test_johor_is_separate_from_singapore(self):
        path = self.root / 'regional.csv'
        path.write_text('user_id,business_instance_id,sandbox_id,cvm_instance_id,environment,region,status,sandbox_instance_state,eligible\n'
                        'usr_1,inst_1,sb_1,ins-one,sgprod,ap-johorbahru,Running,ALLOCATED,true\n'
                        'usr_2,inst_2,sb_2,ins-two,sgprod,ap-singapore,Running,ALLOCATED,true\n')
        path.chmod(0o600)
        self.assertEqual(self.rollout.inventory(path, 'sgprod', 'ap-johorbahru')[0], ['ins-one'])
        self.assertEqual(self.rollout.inventory(path, 'sgprod')[0], ['ins-two'])
        with self.assertRaises(ValueError):
            self.rollout.inventory(path, 'shprod', 'ap-johorbahru')

    def test_rollout_bounded_to_100_new_targets_per_run(self):
        targets = ['ins-one'] + ['ins-' + str(i) for i in range(150)]
        first = self.rollout.execute(self.args, targets, self.config, 'content', self.tat)
        self.args.canary = None
        self.args.resume_after_canary = first['canary_ack']
        result = self.rollout.execute(self.args, targets, self.config, 'content', self.tat)
        self.assertEqual(result['counts'], {'SUCCESS': 101, 'PENDING': 50})
        self.assertTrue(all(len(params['InstanceIds']) <= 10 for _, params in self.tat.calls))

    def test_remote_command_must_match_content_and_identity(self):
        from unittest.mock import patch
        client = self.rollout.TAT('ap-shanghai')
        command = dict(CommandId='cmd-test', Content='pinned-content', Username='agentuser', WorkingDirectory='/home/agentuser', CommandType='SHELL', EnableParameter=False, Timeout=300)
        with patch.object(client, 'call', return_value={'CommandSet': [command]}):
            client.verify_command('cmd-test', 'pinned-content')
            with self.assertRaises(ValueError):
                client.verify_command('cmd-test', 'different-content')
            command['Username'] = 'root'
            with self.assertRaises(ValueError):
                client.verify_command('cmd-test', 'pinned-content')

    def test_test_environments_do_not_select_production_inventory(self):
        path = self.root / 'testing.csv'
        path.write_text('user_id,business_instance_id,sandbox_id,cvm_instance_id,environment,region,status,sandbox_instance_state,eligible\n'
                        'usr_1,inst_1,sb_1,ins-beijing,beijing-sandbox,ap-beijing,Running,ALLOCATED,true\n'
                        'usr_2,inst_2,sb_2,ins-seoul,seoul-sandbox,ap-seoul,Running,ALLOCATED,true\n'
                        'usr_3,inst_3,sb_3,ins-prod,shprod,ap-shanghai,Running,ALLOCATED,true\n')
        path.chmod(0o600)
        self.assertEqual(self.rollout.inventory(path, 'beijing-sandbox')[0], ['ins-beijing'])
        self.assertEqual(self.rollout.inventory(path, 'seoul-sandbox')[0], ['ins-seoul'])
        with self.assertRaises(ValueError):
            self.rollout.inventory(path, 'beijing-sandbox', 'ap-shanghai')


if __name__ == '__main__':
    unittest.main()
