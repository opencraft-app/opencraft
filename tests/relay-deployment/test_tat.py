import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('sender', ROOT / 'scripts/relay-deployment/send.py')
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class TatDeploymentTests(unittest.TestCase):
    def test_rejects_corrupt_payload_before_any_remote_write(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'archive'
            archive.write_bytes(b'archive')
            tat = mock.Mock()
            with self.assertRaises(ValueError):
                sender.deploy(tat, archive, 'a' * 40, 'b' * 64)
            tat.run.assert_not_called()

    def test_lighthouse_upload_is_byte_exact_and_commands_fit_tat(self):
        commands = []
        tat = sender.Tat('lhins-fixture', 'ap-guangzhou')
        def call(action, payload):
            if action == 'RunCommand':
                self.assertLessEqual(len(payload['Content']), 65536)
                commands.append(base64.b64decode(payload['Content']).decode())
                self.assertEqual(payload['Username'], 'opencraft-deploy')
                return {'InvocationId': 'inv-fixture'}
            return {'InvocationTaskSet': [{'TaskStatus': 'SUCCESS', 'TaskResult': {'ExitCode': 0}}]}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(tat, 'call', side_effect=call):
            archive = Path(directory) / 'archive'
            contents = bytes(range(256)) * 220
            archive.write_bytes(contents)
            sender.deploy(tat, archive, 'a' * 40, hashlib.sha256(contents).hexdigest())
        # Extract uploaded chunks; their byte concatenation equals the identified archive.
        chunks = [base64.b64decode(command.split("printf '%s' ")[1].split(' |')[0].strip("'"))
                  for command in commands if "printf '%s'" in command]
        self.assertEqual(b''.join(chunks), contents)
        self.assertEqual(sum('sudo -n /usr/local/libexec/opencraft-relay-activate' in x for x in commands), 1)
        self.assertIn('rm -rf -- /home/opencraft-deploy/.relay-', commands[-1])

    def test_failed_invocation_never_replays_activation(self):
        tat = sender.Tat('ins-fixture', 'ap-guangzhou')
        with mock.patch.object(tat, 'call', side_effect=[{'InvocationId': 'inv-failed'},
                {'InvocationTaskSet': [{'TaskStatus': 'FAILED'}]}]) as call:
            with self.assertRaisesRegex(RuntimeError, 'inv-failed'):
                tat.run('false')
            self.assertEqual(sum(x.args[0] == 'RunCommand' for x in call.call_args_list), 1)

    def test_cli_error_does_not_print_credentials_or_payload(self):
        tat = sender.Tat('ins-fixture', 'ap-guangzhou')
        with mock.patch.object(sender.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'private payload', 'private diagnostic')):
            with self.assertRaisesRegex(RuntimeError, '^TAT RunCommand failed; inspect cloud audit records$'):
                tat.call('RunCommand', {'Content': 'private payload'})

    def test_bootstrap_installs_no_ssh_key_and_stops_both_listeners(self):
        bootstrap = (ROOT / 'scripts/relay-deployment/bootstrap.sh').read_text()
        self.assertIn('systemctl disable --now ssh.service ssh.socket', bootstrap)
        self.assertNotIn('authorized_keys', bootstrap)
        self.assertNotIn('sshd -t', bootstrap)
