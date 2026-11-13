import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import os
import secrets
import socket
import subprocess
import time
import urllib.request
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('receiver', ROOT / 'scripts/relay-deployment/receive.py')
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
REVISION = 'a' * 40


class DeploymentArchiveTests(unittest.TestCase):
    def archive(self, mutate=None):
        contents = {name: b'fixture' for name in receiver.FILES}
        manifest = {'schemaVersion': 1, 'application': 'opencraft-relay', 'sourceRevision': REVISION,
                    'files': {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()}}
        contents['build-manifest.json'] = json.dumps(manifest).encode()
        if mutate:
            mutate(contents)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / 'release.tgz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in contents.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_verified_release_keeps_exact_manifest_identity(self):
        path, digest = self.archive()
        self.assertEqual(set(receiver.verify_archive(path, REVISION, digest)), receiver.FILES | {'build-manifest.json'})

    def test_revision_and_outer_checksum_are_not_optional(self):
        path, digest = self.archive()
        for revision, checksum in [(REVISION, 'b' * 64), ('b' * 40, digest), ('main', digest)]:
            with self.assertRaises(ValueError):
                receiver.verify_archive(path, revision, checksum)

    def test_archive_cannot_write_outside_the_release(self):
        path, digest = self.archive(lambda files: files.update({'../outside': b'no'}))
        with self.assertRaises(ValueError):
            receiver.verify_archive(path, REVISION, digest)

    def test_changed_payload_does_not_inherit_a_valid_manifest(self):
        path, digest = self.archive(lambda files: files.update({'relay.mjs': b'changed'}))
        with self.assertRaises(ValueError):
            receiver.verify_archive(path, REVISION, digest)

    def test_links_are_not_extractable_payloads(self):
        path, _ = self.archive()
        with tarfile.open(path, 'w:gz') as archive:
            entry = tarfile.TarInfo('relay.mjs')
            entry.type = tarfile.SYMTYPE
            entry.linkname = '/etc/passwd'
            archive.addfile(entry)
        with self.assertRaises(ValueError):
            receiver.verify_archive(path, REVISION, hashlib.sha256(path.read_bytes()).hexdigest())

    def test_failed_candidate_restores_the_previous_release_without_touching_state(self):
        path, digest = self.archive()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'releases').mkdir()
            previous = root / 'releases' / 'previous'
            previous.mkdir()
            (previous / 'build-manifest.json').write_text(json.dumps({'sourceRevision': 'b' * 40}))
            (root / 'current').symlink_to(previous)
            state = root / 'persistent-state'
            state.write_bytes(b'identity and route state')
            with mock.patch.object(receiver, 'ROOT', root), mock.patch.object(receiver.subprocess, 'run') as command, mock.patch.object(receiver, 'health', side_effect=[RuntimeError('fixture failure'), None]) as health:
                with self.assertRaisesRegex(RuntimeError, 'previous release restored'):
                    receiver.activate(path, REVISION, digest)
            self.assertEqual((root / 'current').resolve(), previous.resolve())
            self.assertEqual(state.read_bytes(), b'identity and route state')
            self.assertEqual(health.call_args_list, [mock.call(REVISION), mock.call('b' * 40)])
            self.assertEqual(sum(call.args[0][:2] == ['systemctl', 'restart'] for call in command.call_args_list), 2)

    def test_first_failed_deployment_stops_instead_of_leaving_a_broken_service(self):
        path, digest = self.archive()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'releases').mkdir()
            with mock.patch.object(receiver, 'ROOT', root), mock.patch.object(receiver.subprocess, 'run') as command, mock.patch.object(receiver, 'health', side_effect=RuntimeError('fixture failure')):
                with self.assertRaises(RuntimeError):
                    receiver.activate(path, REVISION, digest)
            self.assertFalse((root / 'current').is_symlink())
            self.assertIn(mock.call(['systemctl', 'stop', receiver.SERVICE], check=True), command.call_args_list)

    @unittest.skipUnless(os.environ.get('OPENCRAFT_RELAY_ARTIFACT'), 'Set the built relay artifact for real bootstrap integration')
    def test_initial_configuration_uses_the_actual_running_operator_contract(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            operator = root / 'operator.json'
            operator.write_text(json.dumps({'credential': secrets.token_urlsafe(32)}))
            operator.chmod(0o600)
            endpoint = 'https://relay.fixture.test'
            (root / 'endpoint').write_text(endpoint)
            config = root / 'relay.json'
            config.write_text(json.dumps({'schemaVersion': 1, 'host': '127.0.0.1', 'port': port, 'routes': [], 'hubNetwork': {'stateFile': str(root / 'hub.json'), 'operatorCredentialFile': str(operator)}}))
            config.chmod(0o600)
            process = subprocess.Popen(['node', os.environ['OPENCRAFT_RELAY_ARTIFACT'], str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            origin = 'http://127.0.0.1:' + str(port)
            try:
                for attempt in range(100):
                    try:
                        with urllib.request.urlopen(origin + '/__opencraft_relay/health', timeout=1) as response:
                            self.assertTrue(json.load(response)['ok'])
                        break
                    except OSError:
                        if process.poll() is not None or attempt == 99:
                            self.fail('The real relay artifact did not start')
                        time.sleep(.05)
                receiver.initialize_hub(root, origin)
                request = urllib.request.Request(origin + '/__opencraft_hub/operator', headers={'Authorization': 'Bearer ' + json.loads(operator.read_text())['credential']})
                with urllib.request.urlopen(request, timeout=2) as response:
                    snapshot = json.load(response)
                self.assertTrue(snapshot['accepting'])
                self.assertTrue(snapshot['forwarding'])
                self.assertEqual(snapshot['endpoint'], endpoint)
                self.assertFalse(snapshot['localService'])
            finally:
                process.terminate()
                process.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
