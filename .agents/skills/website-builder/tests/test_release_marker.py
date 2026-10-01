import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_fullstack', Path(__file__).parents[1] / 'scripts/package_fullstack.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ReleaseMarkerTests(unittest.TestCase):
    def test_identifier_alone_is_not_a_release_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / 'public'
            public.mkdir()
            (public / 'index.html').write_text('<script>globalThis.__LIGHTVELA_RELEASE_ID__=null</script>')
            backend = root / 'app.mjs'
            backend.write_text("export default {fetch(){return new Response('ok')}}")
            with self.assertRaisesRegex(ValueError, 'quoted'):
                module.package(public, backend, root / 'site.zip')

    def test_skill_example_has_quoted_release_pin(self):
        skill = (Path(__file__).parents[1] / 'SKILL.md').read_text()
        self.assertIn('globalThis.__LIGHTVELA_RELEASE_ID__="__LIGHTVELA_RELEASE_ID__";', skill)

if __name__ == '__main__':
    unittest.main()
