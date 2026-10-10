"""Real journal/files and package-tool subprocess doubles, no cloud writes."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


PREP = load("builder_preparation", "prepare-runtime-builder-host.py")
FIXTURE = load("builder_initializer_fixture", "test_initialize_runtime_builder_storage.py")
DOUBLE = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['BUILDER_STORAGE_DOUBLE'])
tool=Path(sys.argv[0]).name
with (root/'package-calls.ndjson').open('a') as stream:
    stream.write(json.dumps({'tool':tool,'args':sys.argv[1:],
        'storageConf':os.environ.get('CONTAINERS_STORAGE_CONF'),
        'tmpdir':os.environ.get('TMPDIR')})+'\n')
if (root/('fail-'+tool)).exists(): raise SystemExit(8)
if tool=='dnf':
    assert 'nodejs:20' in sys.argv or any(arg.startswith('--setopt=cachedir=') for arg in sys.argv)
elif tool=='buildah':
    assert sys.argv[1:]==['info']
    graph='/var/lib/containers/storage' if (root/'root-store').exists() else '/data/actor-build/containers/storage'
    print(json.dumps({'store':{'GraphRoot':graph}}))
elif tool=='rpm':
    packages=sys.argv[4:]
    if (root/'missing-package').exists(): packages=packages[:-1]
    print('\n'.join(package+'-0:1-1.x86_64' for package in packages))
else: assert tool in ('node','python3.11')
'''


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = FIXTURE.InitializerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        result = self.fixture.run_initializer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.paths = PREP.STORAGE.Paths(self.fixture.host)
        self.inventory_raw = (self.fixture.root / "inventory.json").read_bytes()
        self.inventory = self.fixture.inventory
        self.current = self.fixture.fixture
        self.plan = PREP.IDENTITY.validate_attachment(self.inventory, self.current,
                                                      self.current["observedAtMs"] + 1000)
        row = self.current["guest"]["lsblk"]["blockdevices"][2]
        self.mount = {"filesystems": [{"target": "/data", "source": "/dev/vdc", "fstype": "ext4",
                                      "uuid": row["uuid"], "options": "rw,noatime"}]}
        (self.fixture.host / "etc/os-release").write_text('ID="tencentos"\nVERSION_ID="3.1"\n')
        for tool in (*PREP.TOOLS, "dnf", "rpm"):
            executable = self.fixture.bin / tool
            executable.write_text(DOUBLE if tool in ("dnf", "rpm", "buildah", "node", "python3.11")
                                  else "#!/bin/sh\nexit 0\n")
            executable.chmod(0o755)

    def validate(self):
        return PREP.validate_files(self.inventory_raw, self.inventory, self.current, self.plan,
                                   self.paths, json.dumps(self.mount).encode())

    def test_exact_mounted_journal_config_and_uuid(self):
        journal, digest = self.validate()
        self.assertEqual(journal["phase"], "mounted")
        self.assertEqual(len(digest), 64)

    def test_foreign_inventory_and_nonmounted_journal_rejected(self):
        with self.assertRaises(ValueError):
            PREP.validate_files(self.inventory_raw + b" ", self.inventory, self.current, self.plan,
                                self.paths, json.dumps(self.mount).encode())
        value = json.loads(self.paths.journal.read_text())
        value["phase"] = "formatted"
        self.paths.journal.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "not mounted"):
            self.validate()

    def test_live_identity_changes_rejected_after_long_install(self):
        original = copy.deepcopy(self.current)
        for kind in ("metadata", "serial", "capacity", "by-id", "root"):
            self.current = copy.deepcopy(original)
            guest = self.current["guest"]
            if kind == "metadata": guest["instanceId"] = "ins-other01"
            if kind == "serial": guest["lsblk"]["blockdevices"][2]["serial"] = "disk-other01"
            if kind == "capacity": guest["lsblk"]["blockdevices"][2]["size"] = "10"
            if kind == "by-id": guest["byId"]["/dev/disk/by-id/virtio-disk-builder01"] = "/dev/vda"
            if kind == "root": guest["rootDevices"].append("/dev/vdc")
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.validate()

    def test_wrong_mount_or_root_buildah_config_rejected(self):
        self.mount["filesystems"][0]["source"] = "/dev/vda1"
        with self.assertRaises(ValueError): self.validate()
        self.mount["filesystems"][0]["source"] = "/dev/vdc"
        self.paths.config.write_text('[storage]\ngraphroot="/var/lib/containers/storage"\n')
        with self.assertRaises(ValueError): self.validate()

    def test_link_or_bulk_symlink_rejected(self):
        self.paths.link.unlink()
        self.paths.link.symlink_to("/var/lib/containers")
        with self.assertRaises(ValueError): self.validate()

    def test_same_filesystem_is_never_preparation_admission(self):
        with self.assertRaisesRegex(ValueError, "system filesystem"):
            PREP.reserve(self.paths)

    def package_process(self):
        driver = """import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('prep',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
try: print(m.install_packages(m.STORAGE.Paths(Path(sys.argv[2]))))
except (ValueError,OSError,KeyError,TypeError): sys.exit(1)
"""
        return subprocess.run([sys.executable, "-c", driver, str(ROOT / "prepare-runtime-builder-host.py"),
                               str(self.fixture.host)], env=self.fixture.env, capture_output=True, text=True, timeout=10)

    def test_package_protocol_propagates_storage_and_bulk_temp(self):
        result = self.package_process()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.strip()), 64)
        calls = [json.loads(x) for x in (self.fixture.root / "package-calls.ndjson").read_text().splitlines()]
        self.assertEqual(calls[0]["args"], ["-y", "module", "enable", "nodejs:20"])
        for call in calls:
            self.assertEqual(call["storageConf"], str(self.paths.config))
            self.assertEqual(call["tmpdir"], str(self.paths.mount / "tmp"))
        install = next(call for call in calls if "install" in call["args"])
        self.assertIn("--setopt=cachedir=" + str(self.paths.mount / "actor-build/dnf-cache"), install["args"])
        self.assertEqual(install["args"][-len(PREP.PACKAGES):], list(PREP.PACKAGES))

    def test_package_and_node_failures_and_bad_store_are_not_ready(self):
        for name in ("fail-dnf", "fail-node", "root-store", "missing-package"):
            marker = self.fixture.root / name
            marker.touch()
            with self.subTest(name=name): self.assertEqual(self.package_process().returncode, 1)
            marker.unlink()

    def test_wrong_distribution_never_invokes_package_manager(self):
        (self.fixture.host / "etc/os-release").write_text("ID=other\nVERSION_ID=3.1\n")
        self.assertEqual(self.package_process().returncode, 1)
        self.assertFalse((self.fixture.root / "package-calls.ndjson").exists())

    def test_cli_requires_explicit_execute_before_reading_inputs(self):
        result = subprocess.run([sys.executable, str(ROOT / "prepare-runtime-builder-host.py"),
                                 "--inventory", "/absent", "--observation", "/absent"],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --execute", result.stderr)


if __name__ == "__main__":
    unittest.main()
