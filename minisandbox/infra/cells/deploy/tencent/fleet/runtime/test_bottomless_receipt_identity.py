"""Run the real receipt finalizer against files without invoking cloud operations."""
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class ReceiptIdentityTest(unittest.TestCase):
    def test_ha_finalizer_hash_includes_cell_identity(self):
        source = Path(__file__).with_name("qualify-engine-ha.sh").read_text()
        finalizer = source.split('"$started_at" "$injected_at" "$injected_at_epoch_ms" "$finished_at" <<\'PY\'\n', 1)[1].split("\nPY", 1)[0]
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            paths = []
            for name, value in (
                ("before", {"image": "image", "topology": [{"uid": "old"}]}),
                ("after", {"image": "image", "topology": [{"uid": "new"}]}),
                ("release-before", {}), ("release-after", {}),
                ("probe", dict(object_count=10, public_api="/v1", requests=1500,
                               concurrency=10, failures=0, traffic_started_at_ms=100,
                               traffic_finished_at_ms=300, post_failure_write_count=1,
                               worker_fixture_retained=True)),
            ):
                path = root / name
                path.write_text(json.dumps(value))
                paths.append(str(path))
            receipt = root / "receipt.json"
            result = subprocess.run(
                [sys.executable, "-"] + paths + [str(receipt), "actor-fdb-cell-system",
                 "actor-bj-q01", "pod", "old", "node", "zone", "start", "inject", "200", "end"],
                input=finalizer, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            document = json.loads(receipt.read_text())
            self.assertEqual(document["cell"], document["cell_name"])
            self.assertEqual(document["cell_namespace"], document["namespace"])
            digest = document.pop("evidence_sha256")
            self.assertEqual(digest, hashlib.sha256(json.dumps(
                document, sort_keys=True, separators=(",", ":")).encode()).hexdigest())

    def test_finalizer_binds_cell_without_confusing_application_namespace(self):
        source = Path(__file__).with_name("qualify-runtime.sh").read_text()
        command = ('python3 - "$receipt" "$qualification_profile" '
                   '"$temporary/release-after-binding.json" \\\n\t"$cell_name" "$namespace" "$temporary/port-forward-transport.json"')
        finalizer = source.split(command + " <<'PY'\n", 1)[1].split("\nPY", 1)[0]
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            receipt = root / "receipt.json"
            binding = root / "binding.json"
            transport = root / "transport.json"
            receipt.write_text(json.dumps({"verdict": "failed", "namespace": "application",
                                           "error": "injected workload failure"}))
            binding.write_text(json.dumps({"runtime_digest": "sha256:example"}))
            transport.write_text(json.dumps({"engine": 2, "workers-api": 1}))
            result = subprocess.run(
                [sys.executable, "-", str(receipt), "production-cell", str(binding),
                 "actor-bj-q01", "actor-fdb-cell-system", str(transport)],
                input=finalizer, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            document = json.loads(receipt.read_text())
            self.assertEqual(document["cell"], "actor-bj-q01")
            self.assertEqual(document["cell_namespace"], "actor-fdb-cell-system")
            self.assertEqual(document["namespace"], "application")
            self.assertEqual(document["verdict"], "failed")
            self.assertEqual(document["error"], "injected workload failure")
            self.assertEqual(document["release_binding"], json.loads(binding.read_text()))
            self.assertEqual(
                document["transport"]["port_forward_restarts"],
                {"engine": 2, "workers-api": 1},
            )


if __name__ == "__main__":
    unittest.main()
