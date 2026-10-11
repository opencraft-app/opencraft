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
        account = SimpleNamespace(pw_dir='/nonexistent', pw_uid=os.getuid(), pw_gid=os.getgid())
        versions = dict.fromkeys(('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'), '0.21.5')
        with patch.object(pin, 'versions', return_value=versions):
            result = pin.install_pin(account, Path('/nonexistent'), '0.21.5', io.StringIO())
        self.assertFalse(result['changed'])

    def test_failed_install_restores_runtime_and_identity_preserves_config(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            data = root / '.hermes'
            runtime = data / 'hermes-agent'
            runtime.mkdir(parents=True)
            (runtime / 'old-source').write_text('preserve old tree')
            config = data / 'config.yaml'
            config.write_text('preserve user configuration')
            identity = root / 'identity.yaml'
            identity.write_text('runtime: hermes\nruntime_version: 0.21.3\n')
            archive = root / 'source.tar.gz'
            self.archive(archive)
            account = SimpleNamespace(pw_dir=str(root), pw_uid=os.getuid(), pw_gid=os.getgid())
            before = dict.fromkeys(('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'), '0.21.3')
            with patch.object(pin, 'versions', return_value=before), patch.object(pin, 'active_gateway_units', return_value=([], [])), patch.object(pin, 'runtime_command', side_effect=subprocess.CalledProcessError(1, 'installer')), (root / 'log').open('w') as log:
                with self.assertRaises(subprocess.CalledProcessError):
                    pin.install_pin(account, archive, '0.21.5', log, identity=identity)
            self.assertEqual((runtime / 'old-source').read_text(), 'preserve old tree')
            self.assertEqual(config.read_text(), 'preserve user configuration')
            self.assertEqual(pin.identity_version(identity), '0.21.3')

    def test_wrong_source_version_is_rejected_before_switch(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            runtime = root / '.hermes/hermes-agent'
            runtime.mkdir(parents=True)
            (runtime / 'old-source').touch()
            identity = root / 'identity.yaml'
            identity.write_text('runtime_version: 0.21.3\n')
            archive = root / 'source.tar.gz'
            self.archive(archive, version='0.21.3')
            account = SimpleNamespace(pw_dir=str(root), pw_uid=os.getuid(), pw_gid=os.getgid())
            with patch.object(pin, 'versions', return_value={'cliVersion': '0.21.3'}), patch.object(pin, 'active_gateway_units', return_value=([], [])), io.StringIO() as log:
                with self.assertRaisesRegex(RuntimeError, 'source version'):
                    pin.install_pin(account, archive, '0.21.5', log, identity=identity)
            self.assertTrue((runtime / 'old-source').exists())


if __name__ == '__main__':
    unittest.main()
