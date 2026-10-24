#!/usr/bin/env python3
"""Check finite credit/recovery models and require counterexamples from mutants."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--jar", required=True, type=Path, help="Official tla2tools.jar")
parser.add_argument("--output", required=True, type=Path)
args = parser.parse_args()
jar = args.jar.resolve()
expected = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
if hashlib.sha256(jar.read_bytes()).hexdigest() != expected:
    raise SystemExit("Unexpected TLC binary hash")
spec = Path(__file__).resolve().parent
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
cases = [
    ("CreditWindow", "CreditWindow", None),
    ("CreditWindow", "CreditWindow-Bad", "ActualWindowBound"),
    ("MediaRecovery", "MediaRecovery", None),
    ("MediaRecovery", "MediaRecovery-Refund", "NoUnconfirmedRefund"),
    ("MediaRecovery", "MediaRecovery-Stale", "NoUnconfirmedRefund"),
    ("MediaRecovery", "MediaRecovery-Unlimited", "Temporal properties were violated"),
]
results = []
for model, config, violation in cases:
    with tempfile.TemporaryDirectory(prefix="interaction-tlc-") as state:
        run = subprocess.run(["java", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC",
            "-workers", "1", "-metadir", state, "-config", config + ".cfg", model + ".tla"],
            cwd=spec, capture_output=True, text=True, timeout=120)
    log = run.stdout + run.stderr
    (output / (config + ".log")).write_text(log)
    if violation is None:
        ok = run.returncode == 0 and "No error has been found" in log
    elif violation.startswith("Temporal"):
        ok = run.returncode == 13 and "Error: Temporal properties were violated." in log
    else:
        ok = run.returncode == 12 and ("Error: Invariant " + violation + " is violated.") in log
    results.append({"model": model, "config": config, "exit": run.returncode, "passed": ok,
        "expectedViolation": violation})
hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
          for p in sorted(spec.iterdir()) if p.suffix in {".tla", ".cfg", ".py"}}
(output / "results.json").write_text(json.dumps({"cases": results, "sha256": hashes,
    "tlcJarSha256": expected}, indent=2) + "\n")
print(json.dumps(results, indent=2))
if not all(result["passed"] for result in results):
    raise SystemExit(1)
