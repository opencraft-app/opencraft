#!/usr/bin/env python3
"""Check the finite recovery model and require exact negative-control failures."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

TLC_SHA256 = "d15655eeaff4b3f7b3d65c46b838bc0f35d131b2ef4b1e473689b62c98d4726f"
CASES = [
    ("Recovery", None),
    ("Recovery-Safety", None),
    ("Recovery-DropHint", "WakeConserved"),
    ("Recovery-HoldGate", "temporal:ThreadRecovery"),
    ("Recovery-Stale", "SingleWriter"),
    ("Recovery-CrossHost", "HostIsolation"),
    ("Recovery-Replay", "NoDuplicateCommand"),
    ("Recovery-Barrier", "PhysicalBarrier"),
    ("Recovery-Witness", "NoHealthyRecoveryWitness"),
    ("Recovery-NoFairness", "temporal:ThreadRecovery"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", required=True, type=Path, help="Official TLA+ v1.8.0 tla2tools.jar")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    jar = args.jar.resolve()
    if hashlib.sha256(jar.read_bytes()).hexdigest() != TLC_SHA256:
        raise SystemExit("Unexpected TLC hash; use the exact documented release asset")
    spec = Path(__file__).resolve().parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    def source_hashes():
        return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(spec.iterdir()) if p.suffix in {".tla", ".cfg", ".py"}}
    before = source_hashes()
    results = []
    for config, violation in CASES:
        trace = output / (config + "-trace.json")
        trace.unlink(missing_ok=True)
        with tempfile.TemporaryDirectory(prefix="recovery-tlc-") as temporary:
            command = ["java", "-Xmx512m", "-XX:+UseParallelGC", "-cp", str(jar), "tlc2.TLC",
                "-workers", "1", "-fp", "0", "-noGenerateSpecTE", "-metadir", temporary,
                "-dumpTrace", "json", str(trace), "-config", config + ".cfg", "Recovery.tla"]
            try:
                run = subprocess.run(command, cwd=spec, capture_output=True, text=True, timeout=120)
                log, code = run.stdout + run.stderr, run.returncode
            except subprocess.TimeoutExpired as error:
                log = "TLC exceeded the 120s verification budget\n"
                code = -1
        (output / (config + ".log")).write_text(log)
        if violation is None:
            ok = code == 0 and "Model checking completed. No error has been found." in log
        elif violation.startswith("temporal:"):
            name = violation.split(":", 1)[1]
            ok = code == 13 and f"Error: Temporal property {name} was violated." in log
        else:
            ok = code == 12 and f"Error: Invariant {violation} is violated." in log
        if violation is not None:
            ok = ok and trace.is_file()
        if config == "Recovery-HoldGate" and trace.is_file():
            terminal = json.loads(trace.read_text())["counterexample"]["state"][-1][1]["s"]
            ok = ok and terminal["net"] and terminal["socket"] == 2 and terminal["barrier"]["a"]
            ok = ok and terminal["phase"]["a"] == "dial" and terminal["token"]["a"] == 2
            ok = ok and terminal["gate"]["a"] == 1 and terminal["baseline"] == 0
        counts = re.findall(r"([\d,]+) states generated, ([\d,]+) distinct states found", log)
        result = {"config": config, "exit": code, "passed": ok, "expectedViolation": violation}
        if counts:
            result.update(generated=int(counts[-1][0].replace(",", "")),
                distinct=int(counts[-1][1].replace(",", "")))
        results.append(result)
        print(json.dumps(result), flush=True)
    hashes = source_hashes()
    stable = hashes == before
    (output / "results.json").write_text(json.dumps({"cases": results,
        "sha256": hashes, "tlcJarSha256": TLC_SHA256, "sourceStable": stable}, indent=2) + "\n")
    if not stable or not all(result["passed"] for result in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
