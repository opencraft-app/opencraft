import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
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


if __name__ == '__main__':
    unittest.main()
