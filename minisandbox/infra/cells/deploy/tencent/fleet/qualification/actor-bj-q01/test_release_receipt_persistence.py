"""Execute the production EXIT handler with isolated persistence/emitter doubles."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ReleaseReceiptPersistenceTest(unittest.TestCase):
    def test_durable_archive_accepts_identity_bound_runtime_qualification(self):
        source = Path(__file__).with_name("persist-receipt-from-builder.sh").read_text()
        self.assertIn("actor-runtime-release-qualification-([0-9a-f]{64})", source)
        self.assertIn('.qualification.cell == "actor-bj-q01"', source)
        # The outer shell expands this unquoted heredoc. Keep the jq variable
        # escaped in source so the builder receives a literal `$digest`.
        self.assertIn(r'.scope.artifactDigest == \$digest', source)

    def test_q01_release_requires_bound_gasoline_storage_profile(self):
        for name in (
            "run-user-transparent-upgrade-on-builder.sh",
            "run-user-transparent-upgrade-via-tat.sh",
        ):
            with self.subTest(name=name):
                source = Path(__file__).with_name(name).read_text()
                self.assertIn("export RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE=1", source)

    def test_first_ledger_keeps_static_recovery_enabled_after_observer_bootstrap(self):
        builder = Path(__file__).with_name("run-user-transparent-upgrade-on-builder.sh").read_text()
        via_tat = Path(__file__).with_name("run-user-transparent-upgrade-via-tat.sh").read_text()
        self.assertIn(
            'live_release_ledger=$(kubectl -n "$namespace" get configmap '
            '"$cell-release-ledger" --ignore-not-found -o name)',
            builder,
        )
        self.assertIn(
            'if [[ $reporter_image != "$live_reporter" || -z $live_release_ledger ]]',
            builder,
        )
        self.assertIn(
            'live_release_ledger=\\$(kubectl -n "\\$namespace" get configmap '
            '"\\$cell-release-ledger" --ignore-not-found -o name)',
            via_tat,
        )
        self.assertIn(
            'if [[ $quoted_reporter_image != "\\$live_reporter" || -z \\$live_release_ledger ]]',
            via_tat,
        )

    def check_case(self, original_status=0, cache_status=0, preexisting=False):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = Path(directory)
            script_dir = root / "qualification/actor-bj-q01"
            script_dir.mkdir(parents=True)
            operations = root / "operations"
            operations.mkdir()
            cache = operations / "cache-qualification-receipt.sh"
            cache.write_text('#!/bin/bash\necho cache >>"$TRACE"\nexit "$CACHE_STATUS"\n')
            cache.chmod(0o755)
            (script_dir / "approved-command-result.py").write_text(
                'import os,sys\n'
                'with open(os.environ["TRACE"], "a") as f:\n'
                ' f.write("emit:"+sys.argv[sys.argv.index("--exit-code")+1]+"\\n")\n')
            receipt = root / "receipt.json"
            receipt.write_text('{}')
            identity = f"{receipt.stat().st_dev}:{receipt.stat().st_ino}" if preexisting else ""
            source = Path(__file__).with_name("run-user-transparent-upgrade-on-builder.sh").read_text()
            handler = source[source.index("emit_command_result() {"):source.index("trap emit_command_result EXIT")]
            trace = root / "trace"
            env = dict(os.environ, TRACE=str(trace), CACHE_STATUS=str(cache_status),
                       script_dir=str(script_dir), receipt=str(receipt), receipt_kind="upgrade",
                       run_id="a"*32, receipt_file_identity=identity)
            result = subprocess.run(["bash", "-c", handler +
                                     "\ntrap emit_command_result EXIT\nexit " + str(original_status)],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    universal_newlines=True)
            return result.returncode, trace.read_text().splitlines()

    def test_success_persists_before_emitting_success(self):
        self.assertEqual(self.check_case(), (0, ["cache", "emit:0"]))

    def test_failed_candidate_is_also_preserved(self):
        self.assertEqual(self.check_case(original_status=1), (1, ["cache", "emit:1"]))

    def test_persistence_failure_prevents_success(self):
        self.assertEqual(self.check_case(cache_status=1), (70, ["cache", "emit:70"]))

    def test_preserves_original_failure(self):
        self.assertEqual(self.check_case(original_status=9, cache_status=1), (9, ["cache", "emit:9"]))

    def test_does_not_republish_a_preexisting_receipt(self):
        self.assertEqual(self.check_case(original_status=1, preexisting=True), (1, ["emit:1"]))


if __name__ == "__main__":
    unittest.main()
