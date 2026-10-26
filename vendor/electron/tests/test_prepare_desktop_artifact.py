"""Desktop artifact producer tests; no native runtime is claimed here."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'prepare-desktop-artifact.py'
spec = importlib.util.spec_from_file_location('desktop_artifact', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DesktopArtifactHelpers(unittest.TestCase):
    def test_archive_preserves_native_executable_permission(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            info = zipfile.ZipInfo('electron')
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o755) << 16
            with zipfile.ZipFile(root / 'dist.zip', 'w') as output:
                output.writestr(info, b'#!/bin/sh\nexit 0\n')
            module.extract_archive(root / 'dist.zip', root / 'dist')
            self.assertEqual((root / 'dist/electron').read_bytes(), b'#!/bin/sh\nexit 0\n')
            if os.name != 'nt':
                self.assertEqual((root / 'dist/electron').stat().st_mode & 0o777, 0o755)
                subprocess.run([str(root / 'dist/electron')], check=True)

    @unittest.skipIf(os.name == 'nt', 'macOS framework symlinks are a POSIX archive contract')
    def test_archive_preserves_framework_links_and_rejects_link_escapes_atomically(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def write_archive(links):
                with zipfile.ZipFile(root / 'dist.zip', 'w') as output:
                    output.writestr('Framework/Versions/A/binary', b'native')
                    for name, target in links.items():
                        info = zipfile.ZipInfo(name)
                        info.create_system = 3
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                        output.writestr(info, target)
            write_archive({'Framework/Versions/Current': 'A', 'Framework/binary': 'Versions/Current/binary'})
            module.extract_archive(root / 'dist.zip', root / 'dist')
            self.assertTrue((root / 'dist/Framework/binary').is_symlink())
            self.assertEqual((root / 'dist/Framework/binary').read_bytes(), b'native')
            (root / 'outside').write_bytes(b'untouched')
            for target in ['../outside', '/etc/passwd', 'loop']:
                write_archive({'loop': target})
                with self.assertRaises(ValueError):
                    module.extract_archive(root / 'dist.zip', root / 'rejected')
                self.assertFalse((root / 'rejected').exists())
                self.assertEqual((root / 'outside').read_bytes(), b'untouched')

    def test_archive_rejects_windows_aliases_and_case_collisions_before_writing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for names in [['C:/outside'], ['..\\outside'], ['/outside'], ['a/../outside'], ['a', 'A']]:
                with self.subTest(names=names):
                    with zipfile.ZipFile(root / 'dist.zip', 'w') as output:
                        for name in names:
                            output.writestr(name, 'unsafe')
                    with self.assertRaises(ValueError):
                        module.extract_archive(root / 'dist.zip', root / 'dist')
                    self.assertFalse((root / 'dist').exists())

    def test_archive_extract_requires_safe_paths_and_fresh_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'dist.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('electron', 'runtime')
            destination = root / 'distribution'
            module.extract_archive(archive, destination)
            self.assertEqual((destination / 'electron').read_text(), 'runtime')
            with self.assertRaisesRegex(ValueError, 'fresh distribution'):
                module.extract_archive(archive, destination)

            escaping = root / 'escaping.zip'
            with zipfile.ZipFile(escaping, 'w') as output:
                output.writestr('../outside', 'bad')
            with self.assertRaisesRegex(ValueError, 'escaping path'):
                module.extract_archive(escaping, root / 'safe')

            external = root / 'external'
            external.mkdir()
            linked_destination = root / 'linked-distribution'
            linked_destination.mkdir()
            with patch.object(
                module.Path,
                'is_symlink',
                autospec=True,
                side_effect=lambda path: path == linked_destination,
            ):
                with self.assertRaisesRegex(ValueError, 'must not be a symlink'):
                    module.extract_archive(archive, linked_destination)

    def test_probe_json_uses_last_json_record(self):
        value = module.probe_json('diagnostic line\n{\n  "nativeProbePassed": true\n}\n')
        self.assertEqual(value, {'nativeProbePassed': True})

    def test_inventory_records_regular_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'electron').write_bytes(b'fork')
            (root / 'resources').mkdir()
            (root / 'resources' / 'blob').write_bytes(b'bytes')
            try:
                (root / 'current').symlink_to('electron')
            except OSError:
                self.skipTest('Runner does not grant symlink creation')
            entries = module.inventory(root)
            self.assertEqual([entry['path'] for entry in entries], ['current', 'electron', 'resources/blob'])
            self.assertEqual(entries[0]['type'], 'symlink')
            self.assertEqual(entries[1]['sha256'], '8d0c7ac992af2f4913b47d425af0fe08dca35d157cbf27e40c203589b983d1fd')

    def test_marker_name_is_excluded_from_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'electron').write_bytes(b'fork')
            (root / module.MARKER).write_text(json.dumps({'nativeProbePassed': True}))
            self.assertEqual([entry['path'] for entry in module.inventory(root)], ['electron'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Fixture uses the Linux executable name')
    def test_main_stamps_only_after_verified_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            distribution = root / 'distribution'
            distribution.mkdir()
            (distribution / 'electron').write_bytes(b'native fixture')
            definition = root / 'fork.json'
            definition.write_text(json.dumps({'version': '44.8.0', 'chromiumVersion': '152.0.7977.167'}))
            probe = root / 'probe.cjs'
            probe.write_text('// fixture')
            evidence = root / 'evidence'
            source = {'sourceVerified': True, 'forkRevision': 'fixture'}
            probe_result = {'nativeProbePassed': True, 'versions': {
                'electron': '44.8.0', 'chrome': '152.0.7977.167',
            }}

            def run(argv, **kwargs):
                if 'verify' in argv:
                    return subprocess.CompletedProcess(argv, 0, json.dumps(source), '')
                return subprocess.CompletedProcess(argv, 0, json.dumps(probe_result), '')

            argv = [
                'prepare-desktop-artifact.py', '--distribution', str(distribution),
                '--source-root', str(root), '--evidence', str(evidence),
                '--fork-definition', str(definition), '--probe', str(probe),
            ]
            with patch.object(sys, 'argv', argv), patch.object(module.subprocess, 'run', run):
                module.main()
            marker = json.loads((distribution / module.MARKER).read_text())
            self.assertTrue(marker['nativeProbePassed'])
            self.assertEqual(marker['source'], source)
            self.assertEqual(marker['files'][0]['path'], 'electron')


if __name__ == '__main__':
    unittest.main()
