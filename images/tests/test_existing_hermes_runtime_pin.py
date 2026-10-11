import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_pin', Path(__file__).parents[1] / 'helpers/pin-existing-hermes-runtime.py')
pin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pin)


class RuntimePinTests(unittest.TestCase):
    def archive(self, target, version='0.21.5', extra=None):
        with tarfile.open(target, 'w:gz') as archive:
            for name, data in [('hermes-agent/pyproject.toml', ('[project]\nversion = "' + version + '"\n').encode()), ('hermes-agent/scripts/install.sh', b'#!/bin/bash\n')]:
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)

    def test_archive_rejects_escape_and_link(self):
        for name, kind in [('hermes-agent/../../outside', tarfile.REGTYPE), ('hermes-agent/escape', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as scratch:
                target = Path(scratch) / 'source.tar.gz'
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/etc/passwd'
                self.archive(target, extra=member)
                with tarfile.open(target) as archive, self.assertRaises(ValueError):
                    pin.checked_members(archive)

    def test_only_project_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / 'pyproject.toml'
            path.write_text('[tool.other]\nversion="9.9.9"\n[project]\nversion="0.21.5"\n[tool.final]\n')
            self.assertEqual(pin.source_version(path), '0.21.5')

    def test_matching_runtime_is_not_reinstalled(self):
        account = SimpleNamespace(pw_dir='/nonexistent', pw_uid=os.getuid(), pw_name='agentuser')
        values = dict.fromkeys(('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'), '0.21.5')
        with patch.object(pin, 'versions', return_value=values), patch.object(pin, 'runtime_command') as command:
            result = pin.install_pin(account, Path('/nonexistent'), '0.21.5', io.StringIO(), **self.target())
        self.assertFalse(result['changed'])
        command.assert_not_called()

    def target(self):
        return dict(blueprint='lhbp-7wrz1nyu', cos_version='hermes-agent-v20260928', display_version='2026.9.24')

    def run_upgrade(self, after_version, command_effect=None, archive_version='0.21.5'):
        account = SimpleNamespace(pw_dir='/nonexistent', pw_uid=os.getuid(), pw_name='agentuser')
        keys = ('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion')
        with tempfile.TemporaryDirectory() as scratch:
            archive = Path(scratch) / 'source.tar.gz'
            self.archive(archive, archive_version)
            with patch.object(pin, 'versions', side_effect=[dict.fromkeys(keys,'0.21.3'),dict.fromkeys(keys,after_version)]), patch.object(pin, 'active_gateway_units', return_value=(['env','systemctl'],['hermes-gateway.service'])), patch.object(pin, 'environment_checks', return_value={'valid':True}), patch.object(pin, 'runtime_command', side_effect=command_effect) as command:
                result = pin.install_pin(account, archive, '0.21.5', io.StringIO(), **self.target())
                return result, [call.args[1] for call in command.call_args_list]

    def test_refresh_precedes_official_upgrade_and_target_is_explicit(self):
        result, calls = self.run_upgrade('0.21.5')
        target = self.target()
        self.assertEqual(calls[0], ['acli','bundle-update'])
        self.assertEqual(calls[1], ['acli','backend','upgrade-start','--blueprint-id',target['blueprint'],'--cos-version',target['cos_version'],'--display-version',target['display_version'],'--wait=true','--force=true'])
        self.assertIn('is-active',calls[2])
        self.assertTrue(result['officialBackendUpgrade'])

    def test_bundle_refresh_failure_aborts_before_upgrade(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_upgrade('0.21.5', command_effect=subprocess.CalledProcessError(1,'acli bundle-update'))

    def test_exit_zero_with_old_runtime_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'actual runtime version'):
            self.run_upgrade('0.21.3')

    def test_wrong_archive_version_is_rejected_before_upgrade(self):
        with self.assertRaisesRegex(RuntimeError, 'archive source version'):
            self.run_upgrade('0.21.5', archive_version='0.21.3')

    def test_existing_repair_refreshes_even_when_backend_available_and_fails_closed(self):
        script = (Path(__file__).parents[1] / 'helpers/config-hermes-python-mirrors.sh').read_text()
        function = script[script.index('ensure_acli_backend() {'):script.index('\nconfig_dir=')]
        for fail in (False,True):
            with self.subTest(refresh_fails=fail), tempfile.TemporaryDirectory() as scratch:
                calls = Path(scratch)/'calls'
                code = 'user=agentuser\nacli_supports_backend() { return 0; }\nrun_as_target_user() { printf "%s\\n" "$1" >> "$CALLS"; if [[ "$1" == "acli bundle-update" ]]; then return "$FAIL"; fi; return 0; }\n' + function + '\nensure_acli_backend\nprintf upgraded >> "$CALLS"\n'
                result = subprocess.run(['bash','-c',code],env=dict(os.environ,CALLS=str(calls),FAIL=str(int(fail))),capture_output=True,text=True)
                commands = calls.read_text()
                self.assertIn('acli bundle-update',commands)
                self.assertEqual('upgraded' in commands,not fail)
                self.assertEqual(result.returncode,int(fail))


if __name__ == '__main__':
    unittest.main()
