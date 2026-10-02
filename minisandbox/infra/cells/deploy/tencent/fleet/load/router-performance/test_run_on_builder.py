import pathlib
import unittest


SCRIPT = (pathlib.Path(__file__).parent / "run-on-builder.sh").read_text()


class RouterPerformanceBuilderEntrypointTest(unittest.TestCase):
    def test_binds_capacity_receipt_before_load(self):
        capacity = 'capacity receipt does not prove the complete 10k active cycle'
        load = 'python3.11 "$runner"'
        self.assertIn(capacity, SCRIPT)
        self.assertLess(SCRIPT.index(capacity), SCRIPT.index(load))
        self.assertIn('not all(value["checks"].values())', SCRIPT)

    def test_resolves_live_endpoints_without_hard_coded_addresses(self):
        self.assertIn('endpoint-installation.json', SCRIPT)
        self.assertIn("--registry-service worker-registry", SCRIPT)
        self.assertIn("--registry-namespace worker-registry-system", SCRIPT)
        self.assertNotIn("registry-url", SCRIPT)
        self.assertNotIn("10.160.", SCRIPT)

    def test_load_is_cross_cell_bounded_and_captured(self):
        for invariant in (
            "--cell actor-bj-a01 --cell actor-bj-b01",
            "--duration-seconds 300 --rate 40 --objects 256 --concurrency 64",
            '--qualification-receipt "$capacity_receipt"',
            '--output-directory "$out/evidence"',
        ):
            self.assertIn(invariant, SCRIPT)
        self.assertLess(SCRIPT.index('python3.11 "$runner"'),
                        SCRIPT.index('python3.11 "$collector"'))

    def test_refuses_mutable_or_reused_output(self):
        self.assertIn("ACTOR_REVIEWED_SOURCE", SCRIPT)
        self.assertIn("q01-src-[a-f0-9]{40}-[a-f0-9]{64}", SCRIPT)
        self.assertIn('test ! -e "$out"', SCRIPT)
        self.assertIn("flock -n 9", SCRIPT)
        self.assertIn("sha256sum", SCRIPT)

    def test_does_not_leave_an_empty_run_before_preflight_passes(self):
        self.assertLess(SCRIPT.index("capacity receipt does not prove"),
                        SCRIPT.index('install -d -m 0700 "$out"'))


if __name__ == "__main__":
    unittest.main()
