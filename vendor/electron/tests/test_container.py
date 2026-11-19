"""Builder orchestration fixtures; these do not compile Chromium."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


@unittest.skipUnless(sys.platform == 'linux', 'Container builder is Linux-only')
class ContainerBuilderTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('container_builder', Path(__file__).parents[1] / 'container.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_workspace_must_be_an_explicit_writable_mount(self):
        root = Path('/workspace')
        self.assertEqual(self.module.mounted_workspace(root, '40 30 1:2 / /workspace rw - ext4 /dev/disk rw'), root)
        for text in ['', '40 30 1:2 / /workspace ro - ext4 /dev/disk ro',
                     '40 30 1:2 / /workspace-other rw - ext4 /dev/disk rw']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.module.mounted_workspace(root, text)
        with self.assertRaises(ValueError):
            self.module.mounted_workspace(Path('/'), '')
        with self.assertRaises(ValueError):
            self.module.mounted_workspace(Path('relative'), '')

    def test_caches_logs_and_source_are_inside_the_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = self.module.Build(root, 4)
            for key in ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'GIT_CACHE_PATH', 'VPYTHON_VIRTUALENV_ROOT', 'CIPD_CACHE_DIR', 'npm_config_cache', 'DEPOT_TOOLS_GSUTIL_BIN_DIR']:
                self.assertTrue(Path(build.environment[key]).is_relative_to(root))
            self.assertTrue(build.source.is_relative_to(root))
            build.record('sync')
            self.assertEqual(json.loads(build.receipt.read_text())['phase'], 'sync')
            build.record('failed', error='fixture')
            self.assertEqual(json.loads(build.receipt.read_text())['error'], 'fixture')

    def test_preflight_bootstraps_storage_downloader_before_large_source_sync(self):
        with tempfile.TemporaryDirectory() as directory:
            build = self.module.Build(Path(directory), 4)
            with patch.object(build, 'command') as command:
                build.stage('preflight')
            self.assertIn(('gsutil.py', 'version', '-l'), [call.args for call in command.call_args_list])
            self.assertIn(('cipd', 'version'), [call.args for call in command.call_args_list])
            self.assertTrue(any(call.args[0] == 'node' and str(call.args[-1]).endswith('scripts/remote-browser/focus.cjs')
                                for call in command.call_args_list))
            target = Path(build.environment['DEPOT_TOOLS_GSUTIL_BIN_DIR'])
            self.assertTrue(target.is_dir())
            self.assertTrue(target.is_relative_to(Path(directory)))

    def test_depot_tools_bootstrap_is_writable_persistent_and_revision_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installation = root / 'image-tools'
            installation.mkdir()
            (installation / 'cipd').write_text('image tool')
            (installation / '.lock').write_text('image-owned lock')
            (installation / '.cipd_client').write_text('image-owned client')
            build = self.module.Build(root, 4)
            revision = json.loads((self.module.HERE / 'container-inputs.json').read_text())['depotToolsRevision']
            with patch.object(self.module.subprocess, 'check_output', return_value=revision + '\n'):
                build.prepare_depot_tools(installation)
                tools = Path(build.state['depotToolsRoot'])
                self.assertFalse((tools / '.lock').exists())
                self.assertFalse((tools / '.cipd_client').exists())
                (tools / 'bootstrap-output').write_text('persistent')
                self.assertFalse((installation / 'bootstrap-output').exists())
                build.prepare_depot_tools(installation)
                self.assertEqual((tools / 'bootstrap-output').read_text(), 'persistent')
            self.assertEqual(build.environment['PATH'].split(self.module.os.pathsep)[0], str(tools))
            with patch.object(self.module.subprocess, 'check_output', return_value='wrong revision\n'):
                with self.assertRaisesRegex(ValueError, 'pinned revision'):
                    build.prepare_depot_tools(installation)

    def test_command_failure_keeps_a_log_and_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            build = self.module.Build(Path(directory), 4)
            with self.assertRaises(subprocess.CalledProcessError):
                build.command(sys.executable, '-c', 'print("fixture failure");raise SystemExit(9)')
            self.assertIn('fixture failure', build.log.read_text())
            self.assertIsNone(build.child)

    def test_build_uses_existing_fork_manager_and_explicit_job_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            build = self.module.Build(Path(directory), 3)
            with patch.object(build, 'command') as command:
                build.stage('build')
                args = command.call_args.args
                self.assertEqual(args[2], 'build')
                self.assertIn(build.source, args)
                self.assertEqual(args[-2:], ('--jobs', 3))

    def test_browser_artifact_does_not_publish_without_an_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            build = self.module.Build(Path(directory), 4)
            with self.assertRaisesRegex(ValueError, 'dist.zip'):
                build.stage('browser-artifact')
            self.assertFalse(build.output.exists())

    def test_resume_preserves_outputs_and_skips_artifact_when_compilation_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = self.module.Build(root, 6)
            output = build.source / 'src/out/OpenCraft/existing.o'
            output.parent.mkdir(parents=True)
            output.write_bytes(b'previous compiler output')
            stages = []
            def stage(action):
                stages.append(action)
                if action == 'build':
                    raise subprocess.CalledProcessError(1, ['ninja'])
            with patch.object(sys, 'argv', ['container.py', 'resume', '--workspace', directory, '--jobs', '6']), \
                    patch.object(self.module, 'mounted_workspace', return_value=root), \
                    patch.object(self.module, 'Build', return_value=build), \
                    patch.object(build, 'prepare_depot_tools'), \
                    patch.object(build, 'stage', side_effect=stage):
                self.assertEqual(self.module.main(), 1)
            self.assertEqual(stages, ['verify', 'build'])
            self.assertEqual(output.read_bytes(), b'previous compiler output')
            self.assertEqual(json.loads(build.receipt.read_text())['phase'], 'failed')


class ContainerInputTests(unittest.TestCase):
    def test_dependency_installer_and_fork_target_match(self):
        here = Path(__file__).parents[1]
        inputs = json.loads((here / 'container-inputs.json').read_text())
        fork = json.loads((here / 'fork.json').read_text())
        self.assertEqual(inputs['schemaVersion'], 1)
        self.assertEqual(inputs['chromiumVersion'], fork['chromiumVersion'])
        self.assertRegex(inputs['depotToolsRevision'], r'^[0-9a-f]{40}$')
        self.assertRegex(inputs['buildDependenciesSha256'], r'^[0-9a-f]{64}$')
