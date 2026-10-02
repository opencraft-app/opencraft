import importlib.util
import pathlib
import sys
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_rss_cycles.py")
SPEC = importlib.util.spec_from_file_location("qualify_rss_cycles", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
rss = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rss
SPEC.loader.exec_module(rss)


class RssCycleTests(unittest.TestCase):
    def cycles(self, values):
        return [
            {"post_settle_memory": {"engine": {"vm_rss_bytes": value}}}
            for value in values
        ]

    def test_converged_plateau_passes_after_warmup(self):
        result = rss.assess_convergence(
            self.cycles([100, 400, 410, 405, 412]),
            warmup_cycles=2,
            max_slope_bytes=10,
            max_plateau_span_bytes=20,
        )
        self.assertTrue(result["engine"]["passed"])

    def test_linear_retention_growth_fails(self):
        result = rss.assess_convergence(
            self.cycles([100, 200, 300, 400, 500]),
            warmup_cycles=1,
            max_slope_bytes=50,
            max_plateau_span_bytes=1000,
        )
        self.assertFalse(result["engine"]["passed"])
        self.assertEqual(result["engine"]["slope_bytes_per_cycle"], 100)

    def test_proc_and_cgroup_attribution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            proc = root / "proc"
            cgroup = root / "cgroup"
            (proc / "7").mkdir(parents=True)
            (proc / "7" / "status").write_text(
                "VmRSS:\t100 kB\nRssAnon:\t60 kB\nRssFile:\t40 kB\n"
            )
            (proc / "7" / "smaps_rollup").write_text(
                "Pss:\t80 kB\nPrivate_Dirty:\t50 kB\nAnonymous:\t60 kB\n"
            )
            (proc / "7" / "cgroup").write_text("0::/actor.slice\n")
            (cgroup / "actor.slice").mkdir(parents=True)
            (cgroup / "actor.slice" / "memory.current").write_text("204800\n")
            (cgroup / "actor.slice" / "memory.peak").write_text("409600\n")
            (cgroup / "actor.slice" / "memory.stat").write_text(
                "anon 102400\nfile 51200\nkernel 25600\n"
            )

            value = rss.process_memory(7, proc, cgroup)

        self.assertEqual(value["vm_rss_bytes"], 102400)
        self.assertEqual(value["pss_bytes"], 81920)
        self.assertEqual(value["cgroup"]["current_bytes"], 204800)
        self.assertEqual(value["cgroup"]["anon_bytes"], 102400)


if __name__ == "__main__":
    unittest.main()
