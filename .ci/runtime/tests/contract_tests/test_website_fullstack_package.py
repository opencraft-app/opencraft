import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = ROOT / '.agents/skills/website-builder/scripts/package_fullstack.py'
spec = importlib.util.spec_from_file_location('website_fullstack_package', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FullstackPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.static = self.root / 'public'
        self.static.mkdir()
        (self.static / 'index.html').write_text('<script>globalThis.__LIGHTVELA_RELEASE_ID__="__LIGHTVELA_RELEASE_ID__";</script>')
        self.backend = self.root / 'backend.mjs'
        self.backend.write_text("export default {fetch(){return new Response('ok')}}")

    def test_package_private_backend_and_reproducible_digest(self):
        output = self.root / 'site.zip'
        result = module.package(self.static, self.backend, output)
        self.assertEqual(result['kind'], 'fullstack')
        self.assertEqual(result['file_count'], 2)
        with zipfile.ZipFile(output) as z:
            self.assertEqual(sorted(z.namelist()), ['__backend/app.mjs', 'index.html'])
        again = module.package(self.static, self.backend, self.root / 'again.zip')
        self.assertEqual(result, again)

    def test_refuses_backend_inside_public_tree(self):
        self.backend = self.static / 'server.mjs'
        self.backend.write_text('private code')
        with self.assertRaises(ValueError):
            module.package(self.static, self.backend, self.root / 'site.zip')

    def test_refuses_secrets_symlinks_and_missing_version_pin(self):
        for name, content in [('.env', 'secret'), ('secret.pem', 'private key'), ('__backend/app.mjs', 'code')]:
            with self.subTest(name=name):
                path = self.static / name
                path.parent.mkdir(exist_ok=True)
                path.write_text(content)
                with self.assertRaises(ValueError):
                    module.package(self.static, self.backend, self.root / 'site.zip')
                path.unlink()
        (self.static / 'link.js').symlink_to(self.backend)
        with self.assertRaises(ValueError):
            module.package(self.static, self.backend, self.root / 'site.zip')
        (self.static / 'link.js').unlink()
        (self.static / 'index.html').write_text('no revision marker')
        with self.assertRaises(ValueError):
            module.package(self.static, self.backend, self.root / 'site.zip')

if __name__ == '__main__':
    unittest.main()
