"""Real journal/files/processes with block/systemd protocol doubles, no cloud writes."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("storage_fixture", ROOT / "test_validate_runtime_builder_storage.py")
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)

DOUBLE = r'''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
root=Path(os.environ['BUILDER_STORAGE_DOUBLE'])
fixture=json.loads((root/'fixture.json').read_text())
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with (root/'calls.ndjson').open('a') as stream:
    stream.write(json.dumps([name,args])+'\n')
row=fixture['guest']['lsblk']['blockdevices'][2]
def save(): (root/'fixture.json').write_text(json.dumps(fixture))
if name=='curl': print(fixture['guest']['instanceId'])
elif name=='readlink':
    if args[-1].startswith('/dev/disk/by-uuid/'):
        print('/dev/vdb' if (root/'wrong-uuid-link').exists() else '/dev/vdc')
    else: print(fixture['guest']['byId'][args[-1]])
elif name=='stat': print('block special file')
elif name=='lsblk': print(json.dumps(fixture['guest']['lsblk']))
elif name=='wipefs': print(json.dumps({'signatures':fixture['guest']['wipefs']['signatures']}))
elif name=='mkfs.ext4':
    assert args==['-m','0','-U',args[3],'-L','actor-build','/dev/disk/by-id/virtio-disk-builder01']
    assert row['fstype'] is None
    row.update(fstype='ext4',uuid=args[3])
    fixture['guest']['wipefs']['signatures']=[{'type':'ext4','uuid':args[3]}]
    save()
    if (root/'lose-format-response').exists(): raise SystemExit(17)
elif name=='e2fsck':
    assert args==['-f','-n','/dev/disk/by-id/virtio-disk-builder01']
    if (root/'fsck-error').exists(): raise SystemExit(4)
elif name=='udevadm':
    assert args in (['trigger','--action=change','/dev/vdc'],['settle','--timeout=10'])
elif name=='systemctl':
    if args==['start','data.mount']:
        if (root/'mount-error').exists(): raise SystemExit(1)
        row['mountpoint']='/data'
        save()
    else: assert args in (['daemon-reload'],['enable','data.mount'])
elif name=='findmnt':
    assert args==['--json','--mountpoint','/data','--output','TARGET,SOURCE,FSTYPE,UUID,OPTIONS']
    data={'target':'/data','source':'/dev/vdc','fstype':'ext4','uuid':row['uuid'],'options':'rw,noatime'}
    if (root/'wrong-mount').exists(): data['source']='/dev/vdb'
    print(json.dumps({'filesystems':[data]}))
else: raise SystemExit('unexpected storage command')
'''

DRIVER = r'''
import importlib.util,json,os,sys
from pathlib import Path
script=Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('initializer',script)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(os.environ['BUILDER_STORAGE_DOUBLE'])
inventory_raw,inventory=m.IDENTITY.read_json(root/'inventory.json')
observation_raw,observation=m.IDENTITY.read_json(root/'observation.json')
try:
    result=m.initialize(inventory_raw,observation_raw,inventory,observation,m.Paths(root/'host'))
except (ValueError,OSError,TypeError,KeyError):
    print('storage_initialization_blocked',file=sys.stderr);sys.exit(1)
print(json.dumps(result,sort_keys=True))
'''


class InitializerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.host = self.root / "host"
        (self.host / "etc/systemd/system").mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name in ("curl", "readlink", "stat", "lsblk", "wipefs", "mkfs.ext4", "e2fsck", "udevadm", "systemctl", "findmnt"):
            executable = self.bin / name
            executable.write_text(DOUBLE)
            executable.chmod(0o755)
        self.inventory = FIXTURE.inventory()
        self.evidence = FIXTURE.observation(time.time_ns() // 1000000 - 1000)
        self.fixture = copy.deepcopy(self.evidence)
        self.env = dict(os.environ, BUILDER_STORAGE_DOUBLE=str(self.root),
                        PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.journal = self.host / "var/lib/actor-runtime-builder-storage/journal.json"

    def run_initializer(self):
        (self.root / "inventory.json").write_text(json.dumps(self.inventory))
        (self.root / "observation.json").write_text(json.dumps(self.evidence))
        (self.root / "fixture.json").write_text(json.dumps(self.fixture))
        result = subprocess.run([sys.executable, "-c", DRIVER, str(ROOT / "initialize-runtime-builder-storage.py")],
                                capture_output=True, text=True, env=self.env, timeout=10)
        self.fixture = json.loads((self.root / "fixture.json").read_text())
        return result

    def calls(self):
        path = self.root / "calls.ndjson"
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def formats(self):
        return [args for name, args in self.calls() if name == "mkfs.ext4"]

    def assert_blocked(self, result):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "storage_initialization_blocked\n")

    def test_exact_disk_journal_uuid_mount_and_storage_config_not_build_admission(self):
        result = self.run_initializer()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        journal = json.loads(self.journal.read_text())
        self.assertEqual(journal["phase"], "mounted")
        self.assertFalse(receipt["storageReady"])
        self.assertTrue(receipt["mountVerified"])
        self.assertEqual(receipt["diskId"], "disk-builder01")
        self.assertEqual(self.formats(), [["-m", "0", "-U", journal["filesystemUuid"], "-L", "actor-build",
                                         "/dev/disk/by-id/virtio-disk-builder01"]])
        self.assertEqual(self.fixture["guest"]["lsblk"]["blockdevices"][1]["uuid"], "existing-pv-uuid")
        unit = (self.host / "etc/systemd/system/data.mount").read_text()
        self.assertIn("What=/dev/disk/by-uuid/" + journal["filesystemUuid"], unit)
        self.assertNotIn("nofail", unit)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.host / "data/tmp").stat().st_mode & 0o7777, 0o1777)
        self.assertEqual(os.readlink(self.host / "var/lib/actor-build"), "/data/actor-build")
        self.assertIn('graphroot = "/data/actor-build/containers/storage"',
                      self.journal.with_name("storage.conf").read_text())

    def test_cli_requires_explicit_execute_before_reading_inputs_or_devices(self):
        result = subprocess.run([sys.executable, str(ROOT / "initialize-runtime-builder-storage.py"),
                                 "--inventory", str(self.root / "absent.json"), "--observation",
                                 str(self.root / "absent-observation.json")],
                                capture_output=True, text=True, env=self.env, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.calls())
        self.assertFalse(self.journal.exists())

    def test_repeat_and_reboot_resume_never_format_again(self):
        first = self.run_initializer()
        self.assertEqual(first.returncode, 0, first.stderr)
        journal = self.journal.read_bytes()
        repeat = self.run_initializer()
        self.assertEqual(repeat.returncode, 0, repeat.stderr)
        self.assertEqual(journal, self.journal.read_bytes())
        # A reboot's empty mountpoint is a command double, not a real unmount.
        self.fixture["guest"]["lsblk"]["blockdevices"][2]["mountpoint"] = None
        # Move fixture-only directory entries aside to simulate that data is on
        # the absent filesystem rather than the underlying empty mountpoint.
        (self.host / "data").rename(self.host / "unmounted-data")
        resumed = self.run_initializer()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(len(self.formats()), 1)

    def test_format_succeeded_response_lost_recovers_exact_uuid_without_reformat(self):
        marker = self.root / "lose-format-response"
        marker.touch()
        self.assert_blocked(self.run_initializer())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "formatting")
        marker.unlink()
        resumed = self.run_initializer()
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(len(self.formats()), 1)
        self.assertTrue(any(name == "e2fsck" for name, _ in self.calls()))

    def test_mount_failure_resumes_formatted_disk_without_reformat(self):
        marker = self.root / "mount-error"
        marker.touch()
        self.assert_blocked(self.run_initializer())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "formatted")
        marker.unlink()
        self.assertEqual(self.run_initializer().returncode, 0)
        self.assertEqual(len(self.formats()), 1)

    def test_fsck_failure_never_mounts_and_preserves_formatting_journal(self):
        (self.root / "fsck-error").touch()
        self.assert_blocked(self.run_initializer())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "formatting")
        self.assertFalse(any(name == "systemctl" for name, _ in self.calls()))

    def test_used_disk_without_journal_never_formats(self):
        row = self.fixture["guest"]["lsblk"]["blockdevices"][2]
        row.update(fstype="ext4", uuid="foreign-uuid")
        self.fixture["guest"]["wipefs"]["signatures"] = [{"type": "ext4", "uuid": "foreign-uuid"}]
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())
        self.assertFalse(self.journal.exists())

    def test_stale_cloud_observation_never_creates_journal(self):
        self.evidence["observedAtMs"] -= 120001
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())
        self.assertFalse(self.journal.exists())

    def test_guest_cannot_redirect_to_root_or_kubernetes_pv(self):
        for device in ("/dev/vda", "/dev/vdb"):
            with self.subTest(device=device):
                self.fixture["guest"]["byId"]["/dev/disk/by-id/virtio-disk-builder01"] = device
                self.assert_blocked(self.run_initializer())
                self.assertFalse(self.formats())

    def test_nonempty_data_and_existing_build_directory_are_not_moved_or_deleted(self):
        data = self.host / "data"
        data.mkdir()
        existing = data / "preserve"
        existing.write_text("existing content")
        self.assert_blocked(self.run_initializer())
        self.assertEqual(existing.read_text(), "existing content")
        self.assertFalse(self.formats())
        existing.unlink()
        build = self.host / "var/lib/actor-build"
        build.mkdir()
        self.assert_blocked(self.run_initializer())
        self.assertTrue(build.is_dir())
        self.assertFalse(self.formats())

    def test_uuid_inventory_and_journal_phase_fence_resume(self):
        self.assertEqual(self.run_initializer().returncode, 0)
        before = self.journal.read_text()
        for key, value in (("filesystemUuid", "00000000-0000-0000-0000-000000000001"),
                           ("inventorySha256", "0" * 64), ("phase", "unknown"),
                           ("diskId", "disk-existing01")):
            with self.subTest(key=key):
                candidate = json.loads(before)
                candidate[key] = value
                self.journal.write_text(json.dumps(candidate))
                self.assert_blocked(self.run_initializer())
                self.assertEqual(len(self.formats()), 1)
        self.journal.write_text(before)

    def test_changed_unit_is_not_overwritten(self):
        self.assertEqual(self.run_initializer().returncode, 0)
        unit = self.host / "etc/systemd/system/data.mount"
        unit.write_text("unrelated mount")
        self.assert_blocked(self.run_initializer())
        self.assertEqual(unit.read_text(), "unrelated mount")
        self.assertEqual(len(self.formats()), 1)

    def test_wrong_mount_receipt_never_marks_mounted(self):
        (self.root / "wrong-mount").touch()
        self.assert_blocked(self.run_initializer())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "formatted")

    def test_uuid_link_to_other_disk_never_starts_mount(self):
        (self.root / "wrong-uuid-link").touch()
        self.assert_blocked(self.run_initializer())
        self.assertEqual(json.loads(self.journal.read_text())["phase"], "formatted")
        self.assertFalse(any(name == "systemctl" for name, _ in self.calls()))

    def test_duplicate_uuid_is_rejected_on_resume(self):
        self.assertEqual(self.run_initializer().returncode, 0)
        self.fixture["guest"]["lsblk"]["blockdevices"][1]["uuid"] = json.loads(self.journal.read_text())["filesystemUuid"]
        self.assert_blocked(self.run_initializer())
        self.assertEqual(len(self.formats()), 1)

    def test_local_lock_conflict_never_formats(self):
        state = self.host / "var/lib/actor-runtime-builder-storage"
        state.mkdir(parents=True, mode=0o700)
        with (state / "initialize.lock").open("wb") as lock:
            (state / "initialize.lock").chmod(0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())
        self.assertFalse(self.journal.exists())

    def test_symlink_mount_and_journal_are_rejected(self):
        (self.host / "data").symlink_to(self.root)
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())
        (self.host / "data").unlink()
        state = self.host / "var/lib/actor-runtime-builder-storage"
        (state / "journal.json").symlink_to(self.root / "inventory.json")
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())

    def test_other_disk_mounted_at_data_and_existing_fstab_owner_fail_before_format(self):
        row = self.fixture["guest"]["lsblk"]["blockdevices"][1]
        original = row["mountpoint"]
        row["mountpoint"] = "/data"
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())
        row["mountpoint"] = original
        fstab = self.host / "etc/fstab"
        fstab.write_text("UUID=existing-pv-uuid /data/ ext4 defaults 0 2\n")
        self.assert_blocked(self.run_initializer())
        self.assertFalse(self.formats())

    def test_foreign_signature_after_response_loss_never_reformats(self):
        (self.root / "lose-format-response").touch()
        self.assert_blocked(self.run_initializer())
        row = self.fixture["guest"]["lsblk"]["blockdevices"][2]
        row["uuid"] = "00000000-0000-0000-0000-000000000001"
        self.fixture["guest"]["wipefs"]["signatures"][0]["uuid"] = row["uuid"]
        self.assert_blocked(self.run_initializer())
        self.assertEqual(len(self.formats()), 1)

    @unittest.skipUnless(all(shutil.which(x) for x in ("mkfs.ext4", "e2fsck", "wipefs")), "native ext4 tools required")
    def test_native_sparse_file_signature_and_readonly_fsck_match_journal_contract(self):
        # This regular-file formatter probe is not block/mount qualification.
        # -F is permitted only for this new disposable test image; production
        # initializer never passes -F or accepts a regular-file disk target.
        image = self.root / "native-ext4-probe.img"
        with image.open("xb") as stream:
            stream.truncate(32 * 1024 * 1024)
        filesystem_uuid = str(uuid.uuid4())
        commands = (
            [shutil.which("mkfs.ext4"), "-F", "-m", "0", "-U", filesystem_uuid, "-L", "actor-build", str(image)],
            [shutil.which("e2fsck"), "-f", "-n", str(image)],
        )
        for command in commands:
            result = subprocess.run(command, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run([shutil.which("wipefs"), "--json", "--no-act", str(image)],
                                capture_output=True, text=True, timeout=10, check=True)
        signatures = json.loads(result.stdout)["signatures"]
        self.assertEqual(len(signatures), 1)
        self.assertEqual(signatures[0]["type"], "ext4")
        self.assertEqual(signatures[0]["uuid"], filesystem_uuid)


if __name__ == "__main__":
    unittest.main()
