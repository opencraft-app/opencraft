#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('capture_cleanup', Path(__file__).resolve().parents[1] / 'helpers/hermes_capture_cleanup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CaptureCleanupTests(unittest.TestCase):
    def test_removes_runtime_state_preserves_skill_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = home / '.hermes'
            runtime.mkdir()
            for name in ['state.db', 'state.db-wal', 'install_id', 'gateway.pid']:
                (runtime / name).write_text('temporary state')
            for name in ['sessions', 'logs', 'cache']:
                (runtime / name).mkdir()
                (runtime / name / 'entry').write_text('temporary state')
            (runtime / 'skills').mkdir()
            (runtime / 'skills/SKILL.md').write_text('keep skill')
            (runtime / 'config.yaml').write_text('keep config')
            module.clean_runtime(home)
            self.assertEqual(sorted(p.name for p in runtime.iterdir()), ['config.yaml', 'skills'])
            module.clean_runtime(home)

    def test_symlink_rejected_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            runtime = home / '.hermes'
            runtime.mkdir()
            (runtime / 'state.db').write_text('preserve on error')
            (runtime / 'sessions').symlink_to(home, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.clean_runtime(home)
            self.assertTrue((runtime / 'state.db').exists())

    def test_runtime_root_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / '.hermes').symlink_to(home, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.clean_runtime(home)

    def test_identity_cleanup_preserves_dbus_link_and_removes_bootstrap_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['etc/ssh', 'var/lib/dbus', 'root/.ssh', 'home/agentuser/.ssh']:
                (root/name).mkdir(parents=True)
            (root/'etc/machine-id').write_text('builder-id')
            (root/'var/lib/dbus/machine-id').symlink_to('/etc/machine-id')
            (root/'etc/ssh/ssh_host_ed25519_key').write_text('fixture key')
            (root/'etc/ssh/sshd_config').write_text('keep config')
            (root/'root/.ssh/authorized_keys').write_text('bootstrap key')
            (root/'home/agentuser/.ssh/authorized_keys').write_text('bootstrap key')
            module.clean_identity(root)
            self.assertEqual((root/'etc/machine-id').read_text(), '')
            self.assertTrue((root/'var/lib/dbus/machine-id').is_symlink())
            self.assertFalse((root/'etc/ssh/ssh_host_ed25519_key').exists())
            self.assertEqual((root/'etc/ssh/sshd_config').read_text(), 'keep config')
            self.assertEqual((root/'root/.ssh/authorized_keys').read_text(), '')
            self.assertEqual((root/'home/agentuser/.ssh/authorized_keys').read_text(), '')
            module.clean_identity(root)

    def test_identity_cleanup_rejects_symlink_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'etc/ssh').mkdir(parents=True)
            (root/'etc/machine-id').write_text('preserve')
            (root/'etc/ssh/ssh_host_test_key').symlink_to(root/'etc/machine-id')
            with self.assertRaises(ValueError):
                module.clean_identity(root)
            self.assertEqual((root/'etc/machine-id').read_text(), 'preserve')

if __name__ == '__main__':
    unittest.main()
