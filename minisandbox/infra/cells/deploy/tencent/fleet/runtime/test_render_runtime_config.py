#!/usr/bin/env python3
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class RenderRuntimeConfigTest(unittest.TestCase):
    def test_production_values_are_typed_and_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "config.jsonc"
            subprocess.run(
                [
                    str(ROOT / "render-runtime-config.py"),
                    str(ROOT / "runtime.yaml"),
                    str(output),
                    "--cell-name",
                    "actor-bj-q01",
                    "--cold-bucket",
                    "actor-depot-cold-prod-bj-q01-nv1-1388575217",
                    "--cold-endpoint",
                    "https://cos.ap-chengdu.myqcloud.com",
                    "--cold-region",
                    "ap-chengdu",
                    "--write-debt-target",
                    "10485760",
                    "--write-debt-limit",
                    "12582912",
                    "--cold-max-concurrent-requests",
                    "32",
                    "--gasoline-worker-poll-interval-ms",
                    "2000",
                    "--gasoline-worker-pull-batch-size",
                    "256",
                    "--gasoline-worker-max-active-workflows",
                    "4096",
                    "--depot-manager-refresh-max-concurrency",
                    "8",
                    "--depot-compaction-max-concurrency",
                    "2",
                    "--gasoline-worker-secondary-grace-ms",
                    "1000",
                    "--gasoline-history-prune-eligibility-seconds",
                    "900",
                    "--gasoline-terminal-prune-eligibility-seconds",
                    "604800",
                    "--gasoline-prune-interval-seconds",
                    "60",
                    "--envoy-slot-jitter",
                    "16",
                    "--envoy-allocation-max-in-flight-per-pool",
                    "1",
                ],
                check=True,
            )
            document = json.loads(output.read_text())
        debt = document["sqlite"]["workflow_write_debt"]
        self.assertEqual(debt, {"target_bytes": 10485760, "limit_bytes": 12582912})
        self.assertEqual(
            document["sqlite"]["workflow_cold_storage"]["s3"]["max_concurrent_requests"],
            32,
        )
        self.assertEqual(
            document["sqlite"]["workflow_cold_storage"]["s3"]["bucket"],
            "actor-depot-cold-prod-bj-q01-nv1-1388575217",
        )
        self.assertEqual(
            document["sqlite"]["workflow_cold_storage"]["s3"]["endpoint"],
            "https://cos.ap-chengdu.myqcloud.com",
        )
        self.assertEqual(
            document["sqlite"]["workflow_cold_storage"]["s3"]["region"],
            "ap-chengdu",
        )
        self.assertEqual(document["runtime"]["gasoline_worker_poll_interval_ms"], 2000)
        self.assertEqual(document["runtime"]["gasoline_worker_pull_batch_size"], 256)
        self.assertEqual(document["runtime"]["gasoline_worker_max_active_workflows"], 4096)
        self.assertEqual(document["runtime"]["depot_manager_refresh_max_concurrency"], 8)
        self.assertEqual(document["runtime"]["depot_compaction_max_concurrency"], 2)
        self.assertEqual(document["runtime"]["gasoline_worker_secondary_grace_ms"], 1000)
        self.assertEqual(
            document["runtime"]["gasoline_history_prune_eligibility_duration"], 900
        )
        self.assertEqual(
            document["runtime"]["gasoline_prune_eligibility_duration"], 604800
        )
        self.assertEqual(document["runtime"]["gasoline_prune_interval_duration"], 60)
        self.assertEqual(document["runtime"]["gasoline_cell_namespace"], "actor-bj-q01")
        self.assertTrue(
            all("actor-bj-q01" in address for address in document["nats"]["addresses"])
        )
        self.assertEqual(
            document["pegboard"]["envoy_load_balancer"]["hash"]["slot_jitter"],
            16,
        )
        self.assertEqual(
            document["pegboard"]["envoy_allocation_max_in_flight_per_pool"],
            1,
        )
        self.assertNotIn("__RIVET_", json.dumps(document))
        self.assertNotIn("actor-bj-k01", json.dumps(document))


if __name__ == "__main__":
    unittest.main()
