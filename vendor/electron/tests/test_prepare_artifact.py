"""Provenance fixtures only; mocked probes make no native-runtime claims."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'prepare-artifact.py'


@unittest.skipUnless(sys.platform == 'linux', 'Owned distribution producer is Linux-only')
class ArtifactProvenance(unittest.TestCase):
    def fixture(self, mutation=None):
        spec = importlib.util.spec_from_file_location('artifact_fixture', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            definition = root / 'fork.json'
            original = json.dumps({'version': '44.8.0', 'chromiumVersion': '152.0.7977.167'})
            definition.write_text(original)
            distribution = root / 'distribution'
            distribution.mkdir()
            for name in ['electron', 'LICENSE', 'LICENSES.chromium.html']:
                (distribution / name).write_text('synthetic provenance fixture')
            module.__file__ = str(root / 'prepare-artifact.py')
            verify_count = 0

            def run(argv, **_):
                nonlocal verify_count
                if 'verify' in argv:
                    verify_count += 1
                    source = {'forkRevision': 'source-B' if mutation == 'source' and verify_count > 1 else 'source-A'}
                    return subprocess.CompletedProcess(argv, 0, json.dumps(source), '')
                if mutation == 'definition':
                    definition.write_text(original + ' ')
                if argv[-1].endswith('probe-native-clipboard.cjs'):
                    value = {'nativeCopyProbePassed': True, 'cases': [{'passed': True}], 'versions': {'electron': '44.8.0', 'chrome': '152.0.7977.167'}}
                else:
                    focus = argv[-1].endswith('probe-native-ime-focus-identity.cjs')
                    value = {'passed': True, 'readOnlyFocusQueryProved': True, 'mouseDownPhaseProved': True, 'cases': [{'passed': True}] * (20 if focus else 27)}
                return subprocess.CompletedProcess(argv, 0, json.dumps(value), '')

            argv = ['prepare-artifact.py', '--distribution', str(distribution), '--source-root', str(root), '--evidence', str(root / 'evidence')]
            with patch.object(sys, 'argv', argv), patch.object(module.subprocess, 'run', run):
                if mutation:
                    with self.assertRaisesRegex(ValueError, 'changed during artifact preparation'):
                        module.main()
                    self.assertFalse((distribution / 'opencraft-electron-artifact.json').exists())
                else:
                    module.main()
                    marker = json.loads((distribution / 'opencraft-electron-artifact.json').read_text())
                    self.assertEqual(marker['forkDefinitionSha256'], hashlib.sha256(original.encode()).hexdigest())
                    self.assertEqual(marker['source'], {'forkRevision': 'source-A'})

    def test_stable_definition_and_source(self):
        self.fixture()

    def test_definition_changes_while_probes_run(self):
        self.fixture('definition')

    def test_source_changes_while_probes_run(self):
        self.fixture('source')


if __name__ == '__main__':
    unittest.main()
