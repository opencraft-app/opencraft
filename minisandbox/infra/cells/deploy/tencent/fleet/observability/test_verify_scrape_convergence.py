#!/usr/bin/env python3
"""Execute the real workerd verification block against query protocol doubles."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class ScrapeConvergenceTests(unittest.TestCase):
    def run_gate(self, expected: str, deficient: str, missing_scrapes: int = 0):
        text = (ROOT / "verify.sh").read_text()
        block = text.split("workerd_expected=", 1)[1].split("stateless_expected=", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "remaining"
            state.write_text(str(missing_scrapes))
            script = r'''set -euo pipefail
sleep() { :; }
query_scalar() {
  if [[ $1 == "count($workerd_expected)" ]]; then
    printf 'expected-query\n' >&2
    printf '%s\n' "$EXPECTED"
  else
    remaining=$(<"$STATE")
    if (( remaining > 0 )); then
      printf '%s' "$((remaining - 1))" >"$STATE"
      printf '1\n'
    else
      printf '%s\n' "$DEFICIENT"
    fi
  fi
}
'''
            import os
            env = {**os.environ, "EXPECTED": expected, "DEFICIENT": deficient, "STATE": str(state)}
            return subprocess.run(["bash", "-c", script + "workerd_expected=" + block],
                                  env=env, capture_output=True, text=True, timeout=20)

    def test_already_healthy(self):
        result = self.run_gate("1", "0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("expected-query"), 1)

    def test_initial_scrapes_converge(self):
        result = self.run_gate("1", "0", missing_scrapes=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("expected-query"), 3)

    def test_unreachable_replica_fails_closed(self):
        result = self.run_gate("1", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.count("expected-query"), 60)
        self.assertIn("workerd metrics incomplete", result.stderr)

    def test_absent_workload_fails_closed(self):
        result = self.run_gate("0", "0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr.count("expected-query"), 60)


class StatelessScrapeConvergenceTests(unittest.TestCase):
    def run_gate(self, expected: str, deficient: str, series: str = "1", missing_scrapes: int = 0):
        text = (ROOT / "verify.sh").read_text()
        block = text.split("stateless_expected=", 1)[1].split("rules_response=", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "remaining"
            state.write_text(str(missing_scrapes))
            script = r'''set -euo pipefail
sleep() { :; }
query_scalar() {
  if [[ $1 == "count($stateless_expected)" ]]; then
    printf 'expected-query\n' >&2
    printf '%s\n' "$EXPECTED"
  elif [[ $1 == count\(rivet_stateless_* ]]; then
    printf '%s\n' "$SERIES"
  else
    remaining=$(<"$STATE")
    if (( remaining > 0 )); then
      printf '%s' "$((remaining - 1))" >"$STATE"
      printf '1\n'
    else
      printf '%s\n' "$DEFICIENT"
    fi
  fi
}
'''
            import os
            env = {
                **os.environ,
                "EXPECTED": expected,
                "DEFICIENT": deficient,
                "SERIES": series,
                "STATE": str(state),
            }
            return subprocess.run(
                ["bash", "-c", script + "stateless_expected=" + block],
                env=env,
                capture_output=True,
                text=True,
                timeout=20,
            )

    def test_stateless_scrapes_and_series_are_healthy(self):
        result = self.run_gate("1", "0")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_stateless_scrapes_converge(self):
        result = self.run_gate("1", "0", missing_scrapes=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("expected-query"), 3)

    def test_stateless_target_shortfall_fails_closed(self):
        result = self.run_gate("1", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stateless metrics incomplete", result.stderr)

    def test_stateless_series_absence_fails_closed(self):
        result = self.run_gate("1", "0", series="0")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("required stateless Prometheus series is absent", result.stderr)


if __name__ == "__main__":
    unittest.main()
