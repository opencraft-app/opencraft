"""Real-file and CLI regressions for the offline, non-qualification analyzer."""

import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import analyze_pressure as analysis


EPOCH = 1790980000


def metric(trace, value, offset=0, **labels):
    return {"labels": {"trace": trace, **labels}, "timestamp": EPOCH + offset,
            "finite": True, "value": str(value)}


def sample(offset=0):
    return {
        "observedAt": datetime.datetime.fromtimestamp(EPOCH + offset, datetime.timezone.utc).isoformat(),
        "cells": [{
            "cell": cell, "foundationDB": {"uid": cell + "-fdb"},
            "machineSet": {"uid": cell + "-machines"},
            "hostConfig": {"uid": cell + "-hosts", "currentRevision": "rev1", "updateRevision": "rev1"},
            "errors": [], "metricsSnapshot": {
                "requestedAtEpochSeconds": EPOCH + offset, "rateWindowSeconds": 300,
                "warnings": [], "missingSignals": [], "samples": [
                    metric("activeActors", 100 + offset, offset),
                    metric("depotPlanningReadBytesPerSecond", 1000, offset, name="depot_manager_refresh"),
                    metric("depotPlanningTransactionCompletionsPerSecond", 2, offset, name="depot_manager_refresh"),
                    metric("depotPlanningTransactionAttemptsPerSecond", 3, offset, name="depot_manager_refresh"),
                    metric("depotAdmissionSecondsPerSecond", 8, offset, activity_name="refresh_manager", result="ready"),
                    metric("depotAdmissionOutcomesPerSecond", 2, offset, activity_name="refresh_manager", result="ready"),
                    metric("depotExecutionSecondsPerSecond", 0.2, offset, activity_name="refresh_manager", result="succeeded"),
                    metric("depotExecutionOutcomesPerSecond", 2, offset, activity_name="refresh_manager", result="succeeded"),
                    metric("compactionBytesPerSecond", 8192, offset, operation="reclaim_fdb"),
                    metric("compactionObjectsPerSecond", 2, offset, operation="reclaim_fdb"),
                    metric("coldStorageBytesMin", 100 + offset, offset, **{"class": "fdb_authoritative"}),
                    metric("coldStorageBytesMax", 110 + offset, offset, **{"class": "fdb_authoritative"}),
                ],
            },
        } for cell in analysis.CELLS],
    }


class PressureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.trace = self.root / "capacity.ndjson"

    def write(self, rows):
        self.trace.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return self.trace

    def test_costs_and_bounds_not_replica_sum(self):
        path = self.write([sample(), sample(20)])
        result = analysis.analyze(path)
        self.assertFalse(result["qualificationEvidence"])
        self.assertEqual(result["input"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(result["input"]["bytes"], path.stat().st_size)
        cell = result["cells"][analysis.CELLS[0]]
        self.assertTrue(cell["capacityIdentityComplete"])
        self.assertEqual(cell["gaugePeaks"]["activeActors"], 120)
        frame = cell["lastSnapshot"]
        plan = frame["planning"]["depot_manager_refresh"]
        self.assertEqual(plan["readBytesPerCompletedTransaction"], 500)
        self.assertEqual(plan["attemptsPerCompletedTransaction"], 1.5)
        activity = frame["activities"]["refresh_manager"]
        self.assertEqual(activity["completedAdmissionMeanSeconds"], 4)
        self.assertEqual(activity["execution"]["succeeded"]["meanSeconds"], 0.1)
        self.assertIsNone(activity["execution"]["timeout"]["outcomesPerSecond"])
        self.assertEqual(frame["successfulCompaction"]["reclaim_fdb"]["logicalBytesPerObject"], 4096)
        self.assertEqual(cell["observedAuthoritySlopeBoundsBytesPerSecond"], {"min": 0.5, "max": 1.5})

    def test_slope_uses_metric_query_time(self):
        end = sample(20)
        end["observedAt"] = sample(40)["observedAt"]
        cell = analysis.analyze(self.write([sample(), end]))["cells"][analysis.CELLS[0]]
        self.assertEqual(cell["observedAuthoritySlopeBoundsBytesPerSecond"]["min"], 0.5)

    def test_explicit_window_hashes_entire_input_without_cleanup_mix(self):
        path = self.write([sample(), sample(20), sample(40), sample(60)])
        result = analysis.analyze(path, EPOCH + 20, EPOCH + 40)
        self.assertEqual(result["input"]["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(result["cells"][analysis.CELLS[0]]["samples"], 2)
        self.assertEqual(result["cells"][analysis.CELLS[0]]["gaugePeaks"]["activeActors"], 140)
        self.assertEqual(result["observationWindow"]["lastEpochSeconds"], EPOCH + 40)
        for start, end in ((EPOCH, None), (EPOCH, EPOCH), (EPOCH + 80, EPOCH + 90)):
            with self.assertRaises(ValueError):
                analysis.analyze(path, start, end)

    def test_latest_missing_never_falls_back(self):
        end = sample(20)
        for cell in end["cells"]:
            del cell["metricsSnapshot"]
            cell["errors"] = ["metrics unavailable"]
        cell = analysis.analyze(self.write([sample(), end]))["cells"][analysis.CELLS[0]]
        self.assertIsNone(cell["lastSnapshot"]["gauges"]["activeActors"])
        self.assertIsNone(cell["observedAuthoritySlopeBoundsBytesPerSecond"])
        self.assertEqual(cell["lastObservationErrors"], 1)

    def test_nonfinite_and_zero_denominator_unknown(self):
        row = sample()
        metrics = row["cells"][0]["metricsSnapshot"]["samples"]
        metrics[0]["value"] = "NaN"
        metrics[2]["value"] = "0"
        metrics[4]["finite"] = False
        frame = analysis.analyze(self.write([row]))["cells"][analysis.CELLS[0]]["lastSnapshot"]
        self.assertIsNone(frame["gauges"]["activeActors"])
        self.assertIsNone(frame["planning"]["depot_manager_refresh"]["readBytesPerCompletedTransaction"])
        self.assertIsNone(frame["activities"]["refresh_manager"]["completedAdmissionMeanSeconds"])
        for invalid in (True, "Inf", -1, "-Infinity"):
            self.assertIsNone(analysis.number(invalid))

    def test_invalid_input_rejected(self):
        def duplicate_cell(row):
            row["cells"][1] = copy.deepcopy(row["cells"][0])

        def duplicate_metric(row):
            metrics = row["cells"][0]["metricsSnapshot"]["samples"]
            metrics.append(copy.deepcopy(metrics[0]))

        def extra_label(row):
            row["cells"][0]["metricsSnapshot"]["samples"][0]["labels"]["actor_id"] = "unsafe"

        def stale_metric(row):
            row["cells"][0]["metricsSnapshot"]["samples"][0]["timestamp"] -= 5

        def wrong_window(row):
            row["cells"][0]["metricsSnapshot"]["rateWindowSeconds"] = 60

        def ledger_disagreement(row):
            row["cells"][0]["metricsSnapshot"]["samples"][-1]["value"] = "1"

        for edit in (duplicate_cell, duplicate_metric, extra_label, stale_metric, wrong_window, ledger_disagreement):
            with self.subTest(edit=edit.__name__):
                row = sample()
                edit(row)
                with self.assertRaises(ValueError):
                    analysis.analyze(self.write([row]))

    def test_identity_changes_rejected_even_in_partial_frame(self):
        for resource in ("foundationDB", "hostConfig", "machineSet"):
            with self.subTest(resource=resource):
                row = sample(20)
                row["cells"][0][resource]["uid"] = "replacement"
                del row["cells"][0]["hostConfig"]["updateRevision"]
                with self.assertRaisesRegex(ValueError, "identity changed"):
                    analysis.analyze(self.write([sample(), row]))
        row = sample(20)
        row["cells"][0]["hostConfig"]["updateRevision"] = "rollout"
        with self.assertRaisesRegex(ValueError, "identity changed"):
            analysis.analyze(self.write([sample(), row]))

    def test_missing_identity_is_explicit_unknown(self):
        row = sample(20)
        del row["cells"][0]["foundationDB"]
        cell = analysis.analyze(self.write([sample(), row]))["cells"][analysis.CELLS[0]]
        self.assertFalse(cell["capacityIdentityComplete"])
        self.assertEqual(cell["unboundIdentitySamples"], 1)
        self.assertIsNone(cell["observedAuthoritySlopeBoundsBytesPerSecond"])

    def test_partial_first_identity_still_fences_later_replacement(self):
        start, end = sample(), sample(20)
        del start["cells"][0]["machineSet"]
        end["cells"][0]["foundationDB"]["uid"] = "replaced"
        with self.assertRaisesRegex(ValueError, "identity changed"):
            analysis.analyze(self.write([start, end]))

    def test_time_replays_rejected(self):
        for rows in ([sample(), sample()], [sample(20), sample()]):
            with self.assertRaisesRegex(ValueError, "strictly increasing"):
                analysis.analyze(self.write(rows))
        row = sample()
        row["observedAt"] = sample(20)["observedAt"]
        with self.assertRaisesRegex(ValueError, "query times"):
            analysis.analyze(self.write([sample(), row]))

    def test_no_unbounded_sample_history_or_dynamic_dimensions(self):
        rows = []
        for offset in range(200):
            row = sample(offset)
            row["cells"][0]["nodes"] = [{"uid": "new-node-" + str(offset)}]
            row["cells"][0]["metricsSnapshot"]["samples"].append(metric("unused" + str(offset), 1, offset))
            rows.append(row)
        result = analysis.analyze(self.write(rows))
        self.assertEqual(result["cells"][analysis.CELLS[0]]["samples"], 200)
        self.assertLess(len(json.dumps(result)), 20000)
        self.assertNotIn("unused", json.dumps(result))

    def test_duplicate_json_and_incomplete_rows_rejected(self):
        for raw in ('{"observedAt":1,"observedAt":2}\n', json.dumps(sample()), "", "[]\n"):
            self.trace.write_text(raw)
            with self.assertRaises(ValueError):
                analysis.analyze(self.trace)

    def test_line_and_vector_bounds(self):
        self.trace.write_bytes(b"x" * (analysis.MAX_LINE_BYTES + 1) + b"\n")
        with self.assertRaisesRegex(ValueError, "oversized"):
            analysis.analyze(self.trace)
        row = sample()
        row["cells"][0]["metricsSnapshot"]["samples"] *= 30
        with self.assertRaisesRegex(ValueError, "too many"):
            analysis.analyze(self.write([row]))

    def cli(self, trace, output):
        return subprocess.run([sys.executable, str(Path(analysis.__file__)), "--trace", str(trace),
                               "--output", str(output)], capture_output=True, text=True, timeout=5)

    def test_cli_exclusive_private_output(self):
        self.write([sample(), sample(20)])
        output = self.root / "analysis.json"
        first = self.cli(self.trace, output)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertFalse(json.loads(output.read_text())["qualificationEvidence"])
        saved = output.read_bytes()
        second = self.cli(self.trace, output)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(saved, output.read_bytes())

    def test_fifo_and_symlink_do_not_block_or_read(self):
        fifo = self.root / "fifo"
        os.mkfifo(fifo)
        self.assertNotEqual(self.cli(fifo, self.root / "out").returncode, 0)
        self.write([sample()])
        link = self.root / "link"
        link.symlink_to(self.trace)
        self.assertNotEqual(self.cli(link, self.root / "out").returncode, 0)

    def test_real_file_changed_before_final_stat_rejected(self):
        path = self.write([sample()])

        class ChangedPath:
            def __fspath__(self):
                return str(path)

            def stat(self):
                with path.open("ab") as stream:
                    stream.write(b"\n")
                return path.stat()

        with self.assertRaisesRegex(ValueError, "changed during"):
            analysis.analyze(ChangedPath())


if __name__ == "__main__":
    unittest.main()
