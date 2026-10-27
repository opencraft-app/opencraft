import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('electron_ci', Path(__file__).parents[1] / 'ci.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativePlanTests(unittest.TestCase):
    def test_validation_has_four_distinct_native_targets_without_build_capacity(self):
        rows = module.plan('all', 'validate', {})['include']
        self.assertEqual(len(rows), 4)
        self.assertEqual({(r['platform'], r['arch']) for r in rows},
                         {('linux', 'x64'), ('win32', 'x64'), ('darwin', 'arm64'), ('darwin', 'x64')})

    def test_selected_target_does_not_require_other_runner_configuration(self):
        result = module.plan('windows-x64', 'build', {
            'ELECTRON_BUILD_RUNNER_WINDOWS_X64': json.dumps(['self-hosted', 'Windows', 'X64', 'electron-build'])})
        self.assertEqual(len(result['include']), 1)
        self.assertEqual(result['include'][0]['runner'][0], 'self-hosted')
        self.assertEqual(result['include'][0]['marker'], 'OPENCRAFT_ELECTRON_DISTRIBUTION_WIN32_X64')

    def test_build_fails_before_queueing_without_capacity_or_with_invalid_labels(self):
        for value in ['', 'invalid-json', '[]', 'true', '[""]', '{}']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.plan('linux-x64', 'build', {'ELECTRON_BUILD_RUNNER_LINUX_X64': value})

    def test_large_hosted_runner_label_is_supported(self):
        row = module.plan('macos-arm64', 'build', {
            'ELECTRON_BUILD_RUNNER_MACOS_ARM64': '"organization-macos-builder"'})['include'][0]
        self.assertEqual(row['runner'], 'organization-macos-builder')
