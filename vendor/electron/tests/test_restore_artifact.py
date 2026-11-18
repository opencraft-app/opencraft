"""CI artifact extraction preserves native archives and rejects ambiguous input."""
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile


class RestoreArtifactTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('restore_artifact', Path(__file__).parents[1] / 'restore-artifact.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def fixture(self, root, name='evidence'):
        directory = root / name
        directory.mkdir()
        member = zipfile.ZipInfo('electron')
        member.create_system = 3
        member.external_attr = (stat.S_IFREG | 0o755) << 16
        with zipfile.ZipFile(directory / 'dist.zip', 'w') as archive:
            archive.writestr(member, b'fixture native binary')
        marker = directory / 'opencraft-electron-artifact.json'
        marker.write_text('{"fixture": true}')
        return directory

    def test_restores_archive_modes_and_inventory_without_repacking(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            self.module.restore(root, root / 'browser', 'browser')
            self.assertEqual((root / 'browser/electron').read_bytes(), b'fixture native binary')
            self.assertTrue((root / 'browser/electron').stat().st_mode & 0o111)
            self.assertEqual((root / 'browser/opencraft-electron-artifact.json').read_bytes(),
                             (source / 'opencraft-electron-artifact.json').read_bytes())

    def test_missing_and_duplicate_proofs_are_rejected_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                self.module.restore(root, root / 'browser', 'browser')
            self.fixture(root, 'first')
            self.fixture(root, 'second')
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                self.module.restore(root, root / 'browser', 'browser')
            self.assertFalse((root / 'browser').exists())

    def test_desktop_marker_is_distinct_and_invalid_kind_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            browser = source / 'opencraft-electron-artifact.json'
            browser.rename(source / 'opencraft-electron-desktop-artifact.json')
            self.module.restore(root, root / 'desktop', 'desktop')
            self.assertTrue((root / 'desktop/opencraft-electron-desktop-artifact.json').is_file())
            with self.assertRaisesRegex(ValueError, 'Unsupported'):
                self.module.restore(root, root / 'invalid', 'other')
            self.assertFalse((root / 'invalid').exists())

    def test_rejects_escaping_archive_without_leaving_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.fixture(root)
            with zipfile.ZipFile(source / 'dist.zip', 'w') as archive:
                archive.writestr('../escaped', 'bad')
            with self.assertRaises(ValueError):
                self.module.restore(root, root / 'browser', 'browser')
            self.assertFalse((root / 'browser').exists())
            self.assertFalse((root / 'escaped').exists())
