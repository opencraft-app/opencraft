#!/usr/bin/env python3

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class RuntimeStageTests(unittest.TestCase):
    def test_lock_is_exact_and_source_controlled(self):
        value = json.loads((ROOT / "runtime-stage.lock.json").read_text())
        self.assertEqual(set(value), {"schemaVersion", "platform", "workerdLock", "foundationdbClient"})
        self.assertEqual((value["schemaVersion"], value["platform"]), (1, "linux/amd64"))
        self.assertEqual(value["workerdLock"], "runtimes/workerd/workerd-fdb.lock")
        fdb = value["foundationdbClient"]
        self.assertEqual(fdb["version"], "7.3.79")
        self.assertEqual(len(fdb["sha256"]), 64)
        self.assertIn("/7.3.79/", fdb["url"])

    def test_stage_builder_does_not_read_a_prior_runtime_image(self):
        script = (ROOT / "prepare-stage.sh").read_text()
        self.assertIn("verify-source-bundle.sh", script)
        self.assertIn("build-rivet-workerd-musl.sh", script)
        self.assertIn('RIVET_WORKERD_SOURCE="$build_cache_root/workerd-fdb"', script)
        self.assertIn('workspace_compat_link="$build_cache_root/rivet-history"', script)
        self.assertNotIn('$source_dir/third-party/workerd-fdb', script)
        self.assertIn('ar x "$fdb_deb"', script)
        self.assertIn("fdb_data_archives", script)
        self.assertNotIn("buildah from", script)
        self.assertNotIn("base_runtime", script)

    def test_stage_builder_reuses_a_serialized_data_volume_cache(self):
        script = (ROOT / "prepare-stage.sh").read_text()
        self.assertIn("WORKERD_BUILD_CACHE_DIR:-/data/build-cache/workerd-stage", script)
        self.assertIn('exec 9>"$build_cache_root/build.lock"', script)
        self.assertIn("flock 9", script)
        self.assertIn("$workerd_commit_expected-$workerd_tree_expected", script)
        self.assertIn('ln -sfn "$source_dir" "$workspace_compat_link"', script)

    def test_stage_builder_bounds_and_records_parallelism(self):
        script = (ROOT / "prepare-stage.sh").read_text()
        self.assertIn("build_jobs=${WORKERD_BUILD_JOBS:-16}", script)
        self.assertIn('./tools/build-rivet-workerd-musl.sh --jobs="$build_jobs"', script)
        self.assertIn('--argjson build_jobs "$build_jobs"', script)
        self.assertIn('buildJobs:$build_jobs', script)


if __name__ == "__main__":
    unittest.main()
