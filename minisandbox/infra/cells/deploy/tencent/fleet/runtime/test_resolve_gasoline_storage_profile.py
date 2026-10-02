import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
SCRIPT = ROOT / "resolve-gasoline-storage-profile.py"


class ResolveGasolineStorageProfileTest(unittest.TestCase):
    def documents(self):
        spec = {
            "region": "ap-beijing",
            "gasolineRetention": {
                "historyGraceSeconds": 900,
                "terminalGraceSeconds": 604800,
                "pruneIntervalSeconds": 60,
                "fdbLogicalSoftBytes": 42949672960,
                "fdbLogicalHardBytes": 64424509440,
            },
        }
        digest = "sha256:" + hashlib.sha256(
            json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return (
            {"metadata": {"name": "actor-bj-q01"}, "spec": {"className": "class", "region": "ap-beijing"}},
            {"metadata": {"name": "class"}, "spec": {"profileRef": {"name": "profile", "digest": digest}}},
            {"metadata": {"name": "profile"}, "spec": spec},
        )

    def run_case(self, mutate=lambda cell, shard_class, profile: None):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            paths = [pathlib.Path(directory) / name for name in ("cell.json", "class.json", "profile.json")]
            documents = self.documents()
            mutate(*documents)
            for path, document in zip(paths, documents):
                path.write_text(json.dumps(document))
            return subprocess.run(
                [str(SCRIPT), *map(str, paths), "--expected-cell", "actor-bj-q01"],
                text=True, capture_output=True,
            )

    def test_resolves_exact_bound_policy(self):
        result = self.run_case()
        self.assertEqual(result.returncode, 0, result.stderr)
        resolved = json.loads(result.stdout)
        self.assertEqual(resolved["history_grace_seconds"], 900)
        self.assertEqual(resolved["cold_region"], "ap-beijing")
        self.assertEqual(resolved["cold_endpoint"], "https://cos.ap-beijing.myqcloud.com")

    def test_rejects_profile_mutated_after_binding(self):
        result = self.run_case(lambda _c, _s, p: p["spec"]["gasolineRetention"].update({"historyGraceSeconds": 899}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("digest mismatch", result.stderr)

    def test_rejects_invalid_watermark_order(self):
        def mutate(_c, s, p):
            p["spec"]["gasolineRetention"]["fdbLogicalHardBytes"] = 1
            s["spec"]["profileRef"]["digest"] = "sha256:" + hashlib.sha256(
                json.dumps(p["spec"], sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        result = self.run_case(mutate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fdbLogicalHardBytes", result.stderr)


if __name__ == "__main__":
    unittest.main()
