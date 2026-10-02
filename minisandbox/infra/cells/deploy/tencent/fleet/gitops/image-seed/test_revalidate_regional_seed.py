#!/usr/bin/env python3
"""Exercise the regional seed CLI with a real process-level Buildah protocol double."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from image_contract import PRODUCT_REPOSITORIES, digest, load, validate_seed, validate_upstream


ROOT = Path(__file__).resolve().parent
REGISTRY = "example.tencentcloudcr.com"
DOUBLE = r'''#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
args = sys.argv[1:]
trace = Path(os.environ["TEST_TRACE"])
root = Path(args[args.index("--root") + 1])
runroot = Path(args[args.index("--runroot") + 1])
assert args[args.index("--storage-driver") + 1] == "vfs"
action = args[6]
record = {"action": action, "args": args, "root": str(root), "runroot": str(runroot)}
previous = trace.read_text().splitlines() if trace.exists() else []
if action == "pull":
    assert not root.exists() and not runroot.exists(), "graph was warm"
    assert args[args.index("--platform") + 1] == "linux/amd64"
    root.mkdir()
    runroot.mkdir()
    index = sum(json.loads(line)["action"] == "pull" for line in previous) + 1
    with trace.open("a") as stream:
        stream.write(json.dumps(record) + "\n")
    if index == int(os.environ.get("TEST_FAIL_AT", "0")):
        print("SENSITIVE_AUTH_MARKER", file=sys.stderr)
        sys.exit(9)
    if os.environ.get("TEST_ID") == "empty":
        sys.exit(0)
    print(os.environ.get("TEST_ID", "a" * 64))
elif action == "inspect":
    assert root.exists() and runroot.exists()
    with trace.open("a") as stream:
        stream.write(json.dumps(record) + "\n")
    if os.environ.get("TEST_INSPECT") == "invalid":
        print("not-json SENSITIVE_AUTH_MARKER")
    elif os.environ.get("TEST_INSPECT") == "missing":
        print("{}")
    else:
        print(json.dumps({"Docker": {"os": "linux", "architecture": os.environ.get("TEST_ARCH", "amd64")}}))
else:
    raise AssertionError("Unexpected mutation or external registry command")
'''


class RegionalSeedTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="regional-seed-test.", dir="/data/tmp")
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.inventory_path = self.folder / "inventory.json"
        self.auth = self.folder / "auth.json"
        self.auth.write_text('{"auths":{}}\n')
        self.auth.chmod(0o600)
        self.buildah = self.folder / "buildah"
        self.buildah.write_text(DOUBLE.replace("#!/usr/bin/env python3", "#!" + sys.executable, 1))
        self.buildah.chmod(0o700)
        self.trace = self.folder / "trace.jsonl"
        self.seed = self.folder / "seed.json"
        self.proof = self.folder / "proof.json"
        self.upstream = validate_upstream(load(ROOT / "upstream-images.lock.json"))
        sources = {item["repository"]: item["source"] for item in self.upstream["images"]}
        images = []
        for repository in sorted(set(sources) | PRODUCT_REPOSITORIES):
            provenance = {"kind": "mirror", "source": sources[repository]} if repository in sources else {
                "kind": "build", "sourceRevision": "a" * 40,
                "sourceManifestDigest": "sha256:" + "b" * 64,
                "buildReceiptDigest": "sha256:" + "c" * 64,
            }
            images.append({"repository": repository, "ref": REGISTRY + "/actor-fleet/" + repository
                           + "@sha256:" + "d" * 64, "provenance": provenance})
        self.inventory = {
            "schemaVersion": 1, "registry": REGISTRY, "namespace": "actor-fleet",
            "platform": "linux/amd64", "sourceLockDigest": digest(self.upstream),
            "seedReceiptDigest": "sha256:" + "e" * 64, "images": images,
        }
        self.save_inventory()

    def save_inventory(self):
        self.inventory.pop("inventoryDigest", None)
        self.inventory["inventoryDigest"] = digest(self.inventory)
        self.inventory_path.write_text(json.dumps(self.inventory))

    def run_cli(self, extra=None, environment=None):
        env = dict(os.environ, BUILDAH=str(self.buildah), TEST_TRACE=str(self.trace))
        env.update(environment or {})
        command = [
            sys.executable, str(ROOT / "revalidate-regional-seed.py"),
            "--inventory", str(self.inventory_path),
            "--expected-inventory-digest", self.inventory["inventoryDigest"],
            "--upstream-lock", str(ROOT / "upstream-images.lock.json"),
            "--registry", REGISTRY, "--registry-auth-file", str(self.auth),
            "--output", str(self.seed), "--proof-output", str(self.proof),
        ]
        return subprocess.run(command + (extra or []), env=env, capture_output=True, text=True)

    def assert_preflight_failure(self, **kwargs):
        result = self.run_cli(**kwargs)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists(), result.stderr)
        self.assertFalse(self.seed.exists())

    def test_complete_seed_uses_seventeen_distinct_empty_graphs_and_exact_refs(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        seed = validate_seed(load(self.seed), self.upstream)
        proof = load(self.proof)
        self.assertEqual(proof["inventoryDigest"], self.inventory["inventoryDigest"])
        self.assertEqual(proof["seedReceiptDigest"], digest(seed))
        self.assertEqual(proof["originEvidence"], "inherited_reviewed_inventory")
        self.assertEqual(len(proof["images"]), 17)
        self.assertTrue(all(item["coldPullVerified"] for item in proof["images"]))
        calls = [json.loads(line) for line in self.trace.read_text().splitlines()]
        pulls = [call for call in calls if call["action"] == "pull"]
        self.assertEqual(len(pulls), 17)
        self.assertEqual(len({call["root"] for call in pulls}), 17)
        expected = {item["destination"] for item in seed["images"]}
        self.assertEqual({call["args"][-1] for call in pulls}, {"docker://" + ref for ref in expected})
        for call in pulls:
            self.assertEqual(call["args"][call["args"].index("--authfile") + 1], str(self.auth))
            self.assertFalse(Path(call["root"]).exists())
            self.assertFalse(Path(call["runroot"]).exists())
        self.assertEqual(self.inventory_path.read_text(), json.dumps(self.inventory))

    def test_mid_batch_failure_does_not_publish_or_leak_stderr(self):
        result = self.run_cli(environment={"TEST_FAIL_AT": "8"})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.seed.exists())
        self.assertFalse(self.proof.exists())
        self.assertNotIn("SENSITIVE_AUTH_MARKER", result.stdout + result.stderr)

    def test_platform_inspect_and_pull_identity_fail_closed(self):
        for environment in ({"TEST_ARCH": "arm64"}, {"TEST_INSPECT": "missing"},
                            {"TEST_INSPECT": "invalid"}, {"TEST_ID": "empty"}, {"TEST_ID": "mutable-tag"}):
            with self.subTest(environment=environment):
                result = self.run_cli(environment=environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.seed.exists())
                self.assertFalse(self.proof.exists())
                self.assertNotIn("SENSITIVE_AUTH_MARKER", result.stdout + result.stderr)
                self.trace.unlink()

    def test_inventory_digest_and_explicit_target_are_checked_before_pulls(self):
        self.assert_preflight_failure(extra=["--expected-inventory-digest", "sha256:" + "f" * 64])
        self.assert_preflight_failure(extra=["--registry", "other.tencentcloudcr.com"])
        self.inventory["inventoryDigest"] = "sha256:" + "f" * 64
        self.inventory_path.write_text(json.dumps(self.inventory))
        self.assert_preflight_failure()

    def test_reviewed_upstream_lock_and_provenance_are_not_overridable(self):
        self.inventory["sourceLockDigest"] = "sha256:" + "f" * 64
        self.save_inventory()
        self.assert_preflight_failure()
        self.inventory["sourceLockDigest"] = digest(self.upstream)
        self.inventory["images"][0]["provenance"]["source"] = "untrusted.io/image@sha256:" + "f" * 64
        self.save_inventory()
        self.assert_preflight_failure()

    def test_incomplete_duplicate_or_mutable_inventory_is_rejected(self):
        original = json.loads(json.dumps(self.inventory))
        for mode in ("missing", "duplicate", "mutable", "outside"):
            self.inventory = json.loads(json.dumps(original))
            if mode == "missing":
                self.inventory["images"].pop()
            elif mode == "duplicate":
                self.inventory["images"][-1] = self.inventory["images"][0]
            else:
                self.inventory["images"][0]["ref"] = (REGISTRY + "/actor-fleet/actor-fleet-controller:latest"
                    if mode == "mutable" else "untrusted.io/image@sha256:" + "f" * 64)
            self.save_inventory()
            with self.subTest(mode=mode):
                self.assert_preflight_failure()

    def test_private_auth_is_required_before_any_pull(self):
        self.auth.chmod(0o644)
        self.assert_preflight_failure()
        self.auth.chmod(0o600)
        link = self.folder / "auth-link.json"
        link.symlink_to(self.auth)
        self.assert_preflight_failure(extra=["--registry-auth-file", str(link)])
        self.assert_preflight_failure(extra=["--registry-auth-file", str(self.folder / "absent")])

    def test_outputs_cannot_overwrite_alias_each_other_or_use_dangling_symlinks(self):
        self.assert_preflight_failure(extra=["--proof-output", str(self.seed)])
        self.assert_preflight_failure(extra=["--output", str(self.auth)])
        self.assert_preflight_failure(extra=["--output", "relative.json"])
        self.seed.symlink_to(self.folder / "absent")
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.trace.exists())
        self.assertFalse(self.proof.exists())

    def test_existing_output_is_never_changed(self):
        self.proof.write_text("existing\n")
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.proof.read_text(), "existing\n")
        self.assertFalse(self.trace.exists())
        self.assertFalse(self.seed.exists())


if __name__ == "__main__":
    unittest.main()
