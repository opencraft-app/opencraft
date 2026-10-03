"""Real files and executable renderer protocol processes; no cloud writes."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("builder_render", ROOT / "install-runtime-builder-render-tool.py")
RENDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER)
BINARY = br'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
assert os.environ['KUBECONFIG']=='/dev/null'
args=sys.argv[1:]
if args==['version','--client','-o','json']:
    print(json.dumps({'clientVersion':{'gitVersion':'v1.30.14','platform':'linux/amd64'}}))
elif args[0]=='kustomize':
    root=Path(args[1])
    assert (root/'kustomization.yaml').is_file() and (root/'canary.yaml').is_file()
    print('\n'.join(['apiVersion: v1','kind: ConfigMap','metadata:',
                     '  name: actor-builder-render-canary','data:','  purpose: offline']))
else: raise SystemExit('unexpected renderer command')
'''


class RenderToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source/kubectl"
        self.source.parent.mkdir()
        self.source.write_bytes(BINARY)
        self.source.chmod(0o700)
        self.target = self.root / "data/actor-build/tools/render-kubectl/v1.30.14/bin/kubectl"
        self.sha = hashlib.sha256(BINARY).hexdigest()

    def install(self, version=RENDER.VERSION):
        return RENDER.install_binary(self.source, self.target, self.sha, version)

    def test_atomic_install_repeat_and_offline_canary(self):
        env = self.install()
        self.assertEqual(self.target.read_bytes(), BINARY)
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o555)
        inode = self.target.stat().st_ino
        self.install()
        self.assertEqual(self.target.stat().st_ino, inode)
        temporary = self.root / "data/tmp"
        temporary.mkdir()
        digest = RENDER.render_canary(self.target, temporary, env)
        self.assertEqual(len(digest), 64)
        self.assertFalse(list(temporary.iterdir()))
        self.assertFalse(list(self.target.parent.glob(".render-tool-*")))

    def test_checksum_mismatch_has_no_destination(self):
        self.source.write_bytes(BINARY + b"# mutation\n")
        with self.assertRaisesRegex(ValueError, "checksum"): self.install()
        self.assertFalse(self.target.exists())

    def test_existing_unrelated_binary_is_never_overwritten(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"unrelated")
        self.target.chmod(0o555)
        with self.assertRaises(ValueError): self.install()
        self.assertEqual(self.target.read_bytes(), b"unrelated")

    def test_symlink_hardlink_and_writable_artifacts_are_rejected(self):
        self.source.chmod(0o777)
        with self.assertRaises(ValueError): self.install()
        self.source.chmod(0o700)
        other = self.source.with_name("other")
        os.link(self.source, other)
        with self.assertRaises(ValueError): self.install()
        other.unlink()
        self.source.rename(other)
        self.source.symlink_to(other)
        with self.assertRaises(ValueError): self.install()
        self.assertFalse(self.target.exists())

    def test_version_failure_is_not_render_readiness(self):
        with self.assertRaisesRegex(ValueError, "version/platform"): self.install(version="v0.0.0")

    def test_existing_permissions_are_not_silently_repaired(self):
        self.install()
        self.target.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "permissions"): self.install()
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)

    def test_cli_requires_execute_before_reading_inputs(self):
        result = subprocess.run([sys.executable, str(ROOT / "install-runtime-builder-render-tool.py"),
                                 "--inventory", "/absent", "--observation", "/absent", "--binary", "/absent"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --execute", result.stderr)


if __name__ == "__main__":
    unittest.main()
