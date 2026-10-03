#!/usr/bin/env python3
"""Initialize only the exact standalone build disk; resume without reformatting.

The operations host must hold the existing fleet lock throughout collection,
transfer and this TAT invocation. This guest program has a separate local lock,
not a second fleet lock. It receives no cloud credentials. A verified mount is
not runtime-build admission: verify-builder-storage.py still owns that gate.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


IDENTITY = module("builder_storage_identity", "validate-runtime-builder-storage.py")
GUEST = module("builder_storage_guest", "collect-runtime-builder-guest.py")
require = IDENTITY.require
JOURNAL_KEYS = {"schema", "inventorySha256", "instanceId", "diskId", "capacityBytes",
                "filesystemUuid", "filesystemType", "mountpoint", "phase", "createdAtMs",
                "inputObservationSha256", "initializerSha256"}
PHASES = ("formatting", "formatted", "mounted")


class Paths:
    """Production paths are fixed; an internal root permits isolated file tests."""
    def __init__(self, root=Path("/")):
        self.root = root
        self.mount = root / "data"
        self.state = root / "var/lib/actor-runtime-builder-storage"
        self.unit = root / "etc/systemd/system/data.mount"
        self.link = root / "var/lib/actor-build"
        self.journal = self.state / "journal.json"
        self.config = self.state / "storage.conf"
        self.fstab = root / "etc/fstab"


def safe_path(path):
    for part in (path, *path.parents):
        require(not part.is_symlink(), "managed path contains a symlink")


def directory(path, mode):
    safe_path(path)
    created = not path.exists()
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    if created:
        path.chmod(mode)
    require(path.is_dir(), "managed path is not a directory")
    info = path.stat()
    require(info.st_uid == os.geteuid(), "managed path ownership")
    if mode in (0o700, 0o1777):
        require(stat.S_IMODE(info.st_mode) == mode, "state directory permissions")


def read_owned(path):
    safe_path(path)
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_nlink == 1 and not info.st_mode & 0o022, "managed file ownership/type")
    return IDENTITY.read_json(path)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_journal(path, value):
    # Replacing a journal is permitted only within the validated private state
    # directory and under its lock. Flush both data and rename before mkfs.
    safe_path(path)
    fd, temporary = tempfile.mkstemp(prefix=".journal-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(value, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)  # only this call's exact unrenamed temporary


def check_existing_file(path, contents):
    safe_path(path)
    if path.exists():
        info = path.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_nlink == 1 and not info.st_mode & 0o022 and info.st_size == len(contents),
                "managed configuration ownership/type")
        require(path.read_bytes() == contents, "existing configuration differs")
        return True
    return False


def exclusive_file(path, contents):
    if check_existing_file(path, contents):
        return
    fd, temporary = tempfile.mkstemp(prefix=".actor-storage-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic and exclusive: a crash cannot leave a truncated managed unit,
        # and an unrelated existing path is never overwritten by rename.
        os.link(temporary, path, follow_symlinks=False)
        os.unlink(temporary)
        sync_directory(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(arguments):
    try:
        result = subprocess.run(arguments, check=True, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError("storage command failed; preserve journal and collect original invocation") from error
    require(len(result.stdout) <= IDENTITY.MAX_INPUT_BYTES, "storage command output limit")
    return result.stdout


def fresh_attachment(inventory, evidence, collect=GUEST.collect):
    current = copy.deepcopy(evidence)
    current["guest"] = collect(inventory["instanceId"], inventory["dataDiskId"])
    plan = IDENTITY.validate_attachment(inventory, current, time.time_ns() // 1000000)
    return plan, current


def validate_journal(value, inventory_hash, plan):
    value = IDENTITY.mapping(value, "storage journal")
    require(set(value) == JOURNAL_KEYS and value["schema"] == "actor-runtime-builder-storage-journal/v1",
            "journal schema")
    require(value["inventorySha256"] == inventory_hash, "journal inventory identity")
    for key in ("instanceId", "diskId", "capacityBytes"):
        require(type(value[key]) is type(plan[key]) and value[key] == plan[key], "journal resource identity")
    require(value["filesystemType"] == "ext4" and value["mountpoint"] == "/data"
            and value["phase"] in PHASES, "journal filesystem/phase")
    try:
        require(str(uuid.UUID(value["filesystemUuid"])) == value["filesystemUuid"], "journal UUID")
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("journal UUID") from error
    require(type(value["createdAtMs"]) is int and 0 < value["createdAtMs"] <= time.time_ns() // 1000000,
            "journal creation clock")
    for key in ("inventorySha256", "inputObservationSha256", "initializerSha256"):
        IDENTITY.pattern(value[key], r"[0-9a-f]{64}", "journal input identity")
    return value


def initialized_disk(current, plan, journal):
    rows = IDENTITY.block_devices(current["guest"]["lsblk"])
    name = plan["device"].removeprefix("/dev/")
    row = rows[name]
    require(all(key == name or value.get("uuid") != journal["filesystemUuid"] for key, value in rows.items()),
            "filesystem UUID is not unique")
    require(not row.get("children") and row.get("fstype") == "ext4"
            and row.get("uuid") == journal["filesystemUuid"], "journal filesystem does not match disk")
    mounts = row.get("mountpoints", [row.get("mountpoint")])
    require(mounts is None or (isinstance(mounts, list) and all(x in (None, "/data") for x in mounts)),
            "build disk mounted outside managed mountpoint")
    require(row.get("mountpoint") in (None, "/data"), "build disk mounted outside managed mountpoint")
    signatures = current["guest"]["wipefs"]["signatures"]
    require(len(signatures) == 1 and isinstance(signatures[0], dict)
            and signatures[0].get("type") == "ext4" and signatures[0].get("uuid") == journal["filesystemUuid"],
            "journal filesystem signature mismatch")
    return row.get("mountpoint") == "/data" or (mounts is not None and "/data" in mounts)


def unit_contents(filesystem_uuid):
    return ("# Actor standalone runtime-builder storage; do not edit.\n"
            "[Unit]\nDescription=Actor standalone build storage\nBefore=local-fs.target\n"
            "[Mount]\nWhat=/dev/disk/by-uuid/" + filesystem_uuid
            + "\nWhere=/data\nType=ext4\nOptions=defaults,noatime\n"
            "[Install]\nWantedBy=local-fs.target\n").encode()


STORAGE_CONFIG = (b"# Actor standalone runtime-builder storage; do not edit.\n[storage]\n"
                  b'driver = "overlay"\nrunroot = "/run/actor-build/containers"\n'
                  b'graphroot = "/data/actor-build/containers/storage"\n')


def validate_mount(raw, plan, journal):
    try:
        value = json.loads(raw, object_pairs_hook=IDENTITY.unique_object)
    except (ValueError, UnicodeError) as error:
        raise ValueError("mount observation JSON") from error
    rows = IDENTITY.mapping(value, "mount observation").get("filesystems")
    require(isinstance(rows, list) and len(rows) == 1, "mount observation count")
    row = IDENTITY.mapping(rows[0], "mount observation row")
    require(row.get("target") == "/data" and row.get("source") == plan["device"]
            and row.get("fstype") == "ext4" and row.get("uuid") == journal["filesystemUuid"],
            "mounted filesystem identity")
    options = row.get("options")
    require(isinstance(options, str) and "rw" in options.split(",") and "ro" not in options.split(","),
            "build filesystem must be writable")


def initialize(inventory_raw, observation_raw, inventory, evidence, paths,
               collect=GUEST.collect, run=command):
    inventory = IDENTITY.validate_inventory(inventory)
    plan, current = fresh_attachment(inventory, evidence, collect)
    inventory_hash = hashlib.sha256(inventory_raw).hexdigest()
    directory(paths.state, 0o700)
    require(paths.state.stat().st_dev == paths.root.stat().st_dev, "journal must be on system filesystem")
    lock_fd = os.open(paths.state / "initialize.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "rb") as lock:
        info = os.fstat(lock.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and info.st_nlink == 1 and not info.st_mode & 0o077, "initialization lock type/owner")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Recollect after waiting for this lock; cloud observation must remain
        # fresh. A local lock never authorizes using an old cloud attachment.
        plan, current = fresh_attachment(inventory, evidence, collect)
        safe_path(paths.mount)
        require(not paths.mount.exists() or paths.mount.is_dir(), "mountpoint type")
        for name, row in IDENTITY.block_devices(current["guest"]["lsblk"]).items():
            mounts = row.get("mountpoints", [row.get("mountpoint")])
            at_data = row.get("mountpoint") == "/data" or (isinstance(mounts, list) and "/data" in mounts)
            require(not at_data or "/dev/" + name == plan["device"], "mountpoint belongs to another disk")
        safe_path(paths.fstab)
        if paths.fstab.exists():
            require(paths.fstab.is_file() and paths.fstab.stat().st_size <= IDENTITY.MAX_INPUT_BYTES,
                    "fstab observation envelope")
            for line in paths.fstab.read_text().splitlines():
                fields = line.split("#", 1)[0].split()
                require(len(fields) < 2 or os.path.normpath(fields[1]) != "/data",
                        "fstab already owns managed mountpoint")
        if paths.link.is_symlink():
            require(os.readlink(paths.link) == "/data/actor-build", "existing bulk link differs")
        else:
            require(not paths.link.exists(), "bulk path already exists")
        if paths.journal.exists() or paths.journal.is_symlink():
            _, journal = read_owned(paths.journal)
            journal = validate_journal(journal, inventory_hash, plan)
        else:
            IDENTITY.validate(inventory, current, time.time_ns() // 1000000)
            require(not paths.unit.exists() and not paths.unit.is_symlink(), "mount unit already exists without journal")
            require(not paths.mount.exists() or not any(paths.mount.iterdir()), "mountpoint is not empty")
            journal = {"schema": "actor-runtime-builder-storage-journal/v1", "inventorySha256": inventory_hash,
                       "instanceId": plan["instanceId"], "diskId": plan["diskId"], "capacityBytes": plan["capacityBytes"],
                       "filesystemUuid": str(uuid.uuid4()), "filesystemType": "ext4", "mountpoint": "/data",
                       "phase": "formatting", "createdAtMs": time.time_ns() // 1000000,
                       "inputObservationSha256": hashlib.sha256(observation_raw).hexdigest(),
                       "initializerSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
            write_journal(paths.journal, journal)

        check_existing_file(paths.unit, unit_contents(journal["filesystemUuid"]))
        check_existing_file(paths.config, STORAGE_CONFIG)

        if journal["phase"] == "formatting":
            # If mkfs completed but its response was lost, verify the recorded
            # UUID and fsck instead of executing mkfs again. Empty intent can
            # resume, but a foreign or partially valid signature cannot.
            row = IDENTITY.block_devices(current["guest"]["lsblk"])[plan["device"].removeprefix("/dev/")]
            if row.get("fstype") is None:
                IDENTITY.validate(inventory, current, time.time_ns() // 1000000)
                require(not paths.mount.exists() or not any(paths.mount.iterdir()), "mountpoint is not empty")
                plan, current = fresh_attachment(inventory, evidence, collect)
                IDENTITY.validate(inventory, current, time.time_ns() // 1000000)
                run(["mkfs.ext4", "-m", "0", "-U", journal["filesystemUuid"], "-L", "actor-build", plan["byId"]])
                plan, current = fresh_attachment(inventory, evidence, collect)
            require(not initialized_disk(current, plan, journal), "formatting journal is already mounted")
            run(["e2fsck", "-f", "-n", plan["byId"]])
            journal = dict(journal, phase="formatted")
            write_journal(paths.journal, journal)

        mounted = initialized_disk(current, plan, journal)
        if not mounted:
            require(not paths.mount.exists() or not any(paths.mount.iterdir()), "mountpoint is not empty")
        directory(paths.mount, 0o755)
        run(["udevadm", "trigger", "--action=change", plan["device"]])
        run(["udevadm", "settle", "--timeout=10"])
        uuid_device = run(["readlink", "--canonicalize-existing", "/dev/disk/by-uuid/" + journal["filesystemUuid"]])
        require(uuid_device.decode().strip() == plan["device"], "persistent mount UUID resolves to another disk")
        safe_path(paths.unit.parent)
        require(paths.unit.parent.is_dir(), "systemd directory missing")
        exclusive_file(paths.unit, unit_contents(journal["filesystemUuid"]))
        exclusive_file(paths.config, STORAGE_CONFIG)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "data.mount"])
        run(["systemctl", "start", "data.mount"])
        validate_mount(run(["findmnt", "--json", "--mountpoint", "/data", "--output",
                            "TARGET,SOURCE,FSTYPE,UUID,OPTIONS"]), plan, journal)
        plan, current = fresh_attachment(inventory, evidence, collect)
        require(initialized_disk(current, plan, journal), "mount absent from block observation")
        for relative, mode in (("tmp", 0o1777), ("actor-build", 0o700), ("actor-bootstrap", 0o700),
                               ("actor-build/containers/storage", 0o700)):
            directory(paths.mount / relative, mode)
        if not paths.link.is_symlink():
            require(not paths.link.exists(), "bulk path appeared during initialization")
            os.symlink("/data/actor-build", paths.link)
            sync_directory(paths.link.parent)
        journal = dict(journal, phase="mounted")
        write_journal(paths.journal, journal)
        return {"schema": "actor-runtime-builder-storage-initialization/v1", "verdict": "passed",
                "storageReady": False, "mountVerified": True, "instanceId": plan["instanceId"],
                "diskId": plan["diskId"], "filesystemUuid": journal["filesystemUuid"],
                "journalSha256": hashlib.sha256(paths.journal.read_bytes()).hexdigest(),
                "mountUnitSha256": hashlib.sha256(paths.unit.read_bytes()).hexdigest(),
                "buildahStorageConfigSha256": hashlib.sha256(paths.config.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--observation", required=True, type=Path)
    parser.add_argument("--execute", required=True, action="store_true")
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0, "root required")
        require(sys.version_info[:2] == (3, 11), "qualified Python 3.11 required")
        require(all(shutil.which(name) for name in ("curl", "readlink", "stat", "lsblk", "wipefs",
                    "mkfs.ext4", "e2fsck", "udevadm", "systemctl", "findmnt")), "storage tools missing")
        inventory_raw, inventory = IDENTITY.read_json(args.inventory)
        observation_raw, evidence = IDENTITY.read_json(args.observation)
        result = initialize(inventory_raw, observation_raw, inventory, evidence, Paths())
    except (OSError, ValueError, TypeError, KeyError):
        print("builder_storage_initialization=blocked: preserve journal and invocation", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
