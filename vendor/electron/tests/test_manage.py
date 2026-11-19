import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


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

    def append_patch(self):
        self.native.write_text('native state fenced\n', newline='\n')
        path = self.directory / 'patches/electron/fence.patch'
        path.write_text(self.git('diff'), newline='\n')
        self.git('restore', '--', 'native.cc')
        self.lock['patches'].append({'path': 'patches/electron/fence.patch',
                                    'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')

    def test_persistent_source_advances_only_from_exact_patch_prefix(self):
        before = self.fork().checkout()
        self.append_patch()
        fork = self.fork()
        after = fork.checkout()
        self.assertEqual(after['patchCount'], 2)
        self.assertEqual(self.native.read_text(), 'native state fenced\n')
        self.git('merge-base', '--is-ancestor', before['forkRevision'], after['forkRevision'])
        self.assertEqual(self.git('rev-list', '--count', before['forkRevision'] + '..HEAD').strip(), '1')
        self.assertEqual(after, fork.checkout())
        # A fresh build produces precisely the same commits and tree.
        fresh = Path(self.temp.name) / 'fresh'
        (fresh / 'src').mkdir(parents=True)
        subprocess.run(['git', '-c', 'core.autocrlf=false', 'clone', '--no-local', str(self.source),
                        str(fresh / 'src/electron')], check=True, capture_output=True)
        subprocess.run(['git', '-c', 'core.autocrlf=false', '-C', str(fresh / 'src/electron'), 'checkout',
                        '--detach', self.lock['revision']], check=True, capture_output=True)
        # The fixture clone already contains the branch; remove only that fixture ref.
        subprocess.run(['git', '-C', str(fresh / 'src/electron'), 'branch', '-D',
                        'opencraft/' + self.lock['tag']], check=True, capture_output=True)
        self.assertEqual(after, module.Fork(self.directory, fresh).checkout())

    def test_persistent_source_does_not_remove_registered_patches(self):
        self.fork().checkout()
        self.append_patch()
        before = self.fork().checkout()
        self.lock['patches'].pop()
        self.lock_path.write_text(json.dumps(self.lock), newline='\n')
        with self.assertRaisesRegex(ValueError, 'source tree differs'):
            self.fork().checkout()
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), before['forkRevision'])
        self.assertEqual(self.native.read_text(), 'native state fenced\n')

    def test_dirty_persistent_source_is_not_reset_for_new_patch(self):
        before = self.fork().checkout()
        self.append_patch()
        self.native.write_text('local investigation\n', newline='\n')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            self.fork().checkout()
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), before['forkRevision'])
        self.assertEqual(self.native.read_text(), 'local investigation\n')

    def test_sync_keeps_pinned_source_and_does_not_request_all_remote_refs(self):
        fork = self.fork()
        before = fork.checkout()
        original_run = module.run
        calls = []

        def run(args, **kwargs):
            if str(args[0]) == '/fixture/gclient':
                calls.append(args)
                self.assertEqual(Path(kwargs['cwd']).resolve(), self.root.resolve())
                self.assertTrue((self.root / '.gclient').is_file())
                return ''
            return original_run(args, **kwargs)

        with patch.object(module.shutil, 'which', return_value='/fixture/gclient'), patch.object(module, 'run', run):
            after = fork.sync()
        self.assertEqual(before, after)
        self.assertEqual(len(calls), 1)
        self.assertIn('--no-history', calls[0])
        self.assertNotIn('--with_tags', calls[0])
        self.assertNotIn('--with_branch_heads', calls[0])

    def test_dirty_source_is_preserved_and_rejected(self):
        self.native.write_text('local investigation\n', newline='\n')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            self.fork().checkout()
        self.assertEqual(self.native.read_text(), 'local investigation\n')

    @unittest.skipUnless(sys.platform.startswith('linux'), 'Linux container tool resolution')
    def test_build_children_use_synced_gn_instead_of_depot_wrapper(self):
        fork = self.fork()
        fork.checkout()
        (self.root / 'src/DEPS').write_text('# synchronized fixture\n')
        (self.directory / 'args.gn').write_text('# fixture\n')
        gn = self.root / 'src/buildtools/linux64/gn'
        ninja = self.root / 'src/third_party/ninja/ninja'
        shadow = Path(self.temp.name) / 'depot-wrapper/gn'
        scripts = {
            gn: 'import sys\nif sys.argv[1] != "gen": print("synced-gn")\n',
            shadow: 'raise SystemExit("uninitialized depot wrapper selected")\n',
            ninja: ('import subprocess\nfrom pathlib import Path\n'
                    'assert subprocess.check_output(["gn", "args"], text=True).strip() == "synced-gn"\n'
                    'out = Path("out/OpenCraft")\nout.mkdir(parents=True, exist_ok=True)\n'
                    '(out / "electron").write_bytes(b"fixture executable")\n'
                    '(out / "dist.zip").write_bytes(b"fixture distribution")\n'),
        }
        for path, body in scripts.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('#!' + sys.executable + '\n' + body)
            path.chmod(0o755)
        with patch.dict(module.os.environ, {'PATH': str(shadow.parent) + module.os.pathsep + module.os.environ.get('PATH', '')}):
            result = fork.build(6)
        self.assertTrue(result['compiled'])

    def test_clean_unregistered_change_is_rejected(self):
        fork = self.fork()
        fork.checkout()
        self.native.write_text('unregistered change\n', newline='\n')
        self.git('add', '.')
        self.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'unregistered')
        with self.assertRaisesRegex(ValueError, 'source tree differs'):
            fork.verify()
        before = self.git('rev-parse', 'HEAD')
        with self.assertRaisesRegex(ValueError, 'source tree differs'):
            fork.checkout()
        self.assertEqual(self.git('rev-parse', 'HEAD'), before)

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


class OperationLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / '.opencraft-operation.lock'

    def exited_pid(self):
        process = subprocess.Popen([sys.executable, '-c', 'pass'])
        process.wait()
        return process.pid

    def test_lock_is_released_after_operation(self):
        with module.operation_lock(self.root):
            self.assertEqual(self.path.read_text().strip(), str(os.getpid()))
        self.assertFalse(self.path.exists())

    def test_live_owner_is_respected(self):
        self.path.write_text(f'{os.getppid()}\n')
        with self.assertRaisesRegex(ValueError, 'another operation owns'):
            with module.operation_lock(self.root):
                pass
        self.assertEqual(self.path.read_text().strip(), str(os.getppid()))

    def test_unreadable_owner_is_respected(self):
        self.path.write_text('')
        with self.assertRaisesRegex(ValueError, 'another operation owns'):
            with module.operation_lock(self.root):
                pass
        self.assertTrue(self.path.exists())

    def test_lock_left_by_exited_process_is_taken_over(self):
        self.path.write_text(f'{self.exited_pid()}\n')
        with module.operation_lock(self.root):
            self.assertEqual(self.path.read_text().strip(), str(os.getpid()))
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.root.iterdir()), [])


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
