import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('electron_fork', Path(__file__).parents[1] / 'manage.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ForkSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'definition'
        self.root = Path(self.temp.name) / 'work'
        self.source = self.root / 'src/electron'
        self.source.mkdir(parents=True)
        (self.directory / 'patches/electron').mkdir(parents=True)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@localhost')
        self.native = self.source / 'native.cc'
        self.native.write_text('native state unavailable\n', newline='\n')
        self.git('add', '.')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture upstream')
        revision = self.git('rev-parse', 'HEAD').strip()
        self.native.write_text('native state available\n', newline='\n')
        patch = self.directory / 'patches/electron/native.patch'
        patch.write_text(self.git('diff'), newline='\n')
        self.git('restore', '--', 'native.cc')
        self.lock_path = self.directory / 'fork.json'
        self.lock = {'schemaVersion': 1, 'version': '0.0.0', 'tag': 'v0.0.0',
                     'repository': 'unused-local-fixture', 'revision': revision,
                     'chromiumVersion': '0', 'patchDate': '2026-10-21T06:00:00Z',
                     'patches': [{'path': 'patches/electron/native.patch',
                                  'sha256': hashlib.sha256(patch.read_bytes()).hexdigest()}]}
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.autocrlf=false', '-C', str(self.source), *args], text=True)

    def fork(self):
        return module.Fork(self.directory, self.root)

    def test_materializes_exact_tree_and_is_idempotent(self):
        fork = self.fork()
        first = fork.checkout()
        second = fork.checkout()
        self.assertEqual(first, second)
        self.assertEqual(self.native.read_text(), 'native state available\n')
        self.assertTrue(first['sourceVerified'])

    def test_dirty_source_is_preserved_and_rejected(self):
        self.native.write_text('local investigation\n', newline='\n')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            self.fork().checkout()
        self.assertEqual(self.native.read_text(), 'local investigation\n')

    def test_clean_unregistered_change_is_rejected(self):
        fork = self.fork()
        fork.checkout()
        self.native.write_text('unregistered change\n', newline='\n')
        self.git('add', '.')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'unregistered')
        with self.assertRaisesRegex(ValueError, 'source tree differs'):
            fork.verify()

    def test_corrupt_patch_fails_before_source_mutation(self):
        (self.directory / 'patches/electron/native.patch').write_text('tampered\n', newline='\n')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.fork()
        self.assertEqual(self.native.read_text(), 'native state unavailable\n')

    def test_patch_path_escape_is_rejected(self):
        self.lock['patches'][0]['path'] = '../../outside.patch'
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.fork()

    def test_failed_series_does_not_create_fork_branch(self):
        patch = self.directory / 'patches/electron/native.patch'
        patch.write_text(self.git('diff') + 'not a patch\n', newline='\n')
        self.lock['patches'][0]['sha256'] = hashlib.sha256(patch.read_bytes()).hexdigest()
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')
        before = self.git('rev-parse', 'HEAD')
        with self.assertRaises(subprocess.CalledProcessError):
            self.fork().checkout()
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)
        self.assertEqual(self.git('status', '--porcelain'), '')

    def test_corrupt_nested_chromium_patch_rejected_before_checkout(self):
        nested = self.source / 'patches/chromium/test.patch'
        nested.parent.mkdir(parents=True)
        nested.write_text('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,7 +1,7 @@\n-old\n+new\n', newline='\n')
        self.git('add', '-N', 'patches/chromium/test.patch')
        outer = self.directory / 'patches/electron/nested.patch'
        outer.write_text(self.git('diff', '--', 'patches/chromium/test.patch'), newline='\n')
        self.git('reset', '-q', '--', 'patches/chromium/test.patch')
        nested.unlink()
        self.lock['patches'].append({'path':'patches/electron/nested.patch',
                                    'sha256':hashlib.sha256(outer.read_bytes()).hexdigest()})
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')
        before = self.git('rev-parse', 'HEAD')
        with self.assertRaises(subprocess.CalledProcessError):
            self.fork().checkout()
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)
        self.assertEqual(self.git('status', '--porcelain'), '')


class NativeTargetTests(unittest.TestCase):
    def test_native_build_includes_clean_distribution_archive(self):
        self.assertEqual(module.build_targets(), ['electron', 'electron:electron_dist_zip'])

    def test_native_executable_layouts_are_platform_specific(self):
        root = Path('/tmp/opencraft-electron-build-root')
        self.assertEqual(
            module.native_executable(root, 'linux'),
            root / 'src/out/OpenCraft/electron',
        )
        self.assertEqual(
            module.native_executable(root, 'win32'),
            root / 'src/out/OpenCraft/electron.exe',
        )
        self.assertEqual(
            module.native_executable(root, 'darwin'),
            root / 'src/out/OpenCraft/Electron.app/Contents/MacOS/Electron',
        )

    def test_native_platform_rejects_unknown_runner(self):
        original = module.sys.platform
        try:
            module.sys.platform = 'freebsd'
            with self.assertRaisesRegex(ValueError, 'unsupported native runner'):
                module.native_platform()
        finally:
            module.sys.platform = original


if __name__ == '__main__':
    unittest.main()
