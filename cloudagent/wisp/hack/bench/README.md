# Benchmark Harness

This directory contains repeatable performance harnesses.

## Checkpoint / Resume Baseline

Run a repeated checkpoint/restore benchmark:

```bash
./hack/bench/checkpoint.sh
```

Optional parameters:

```bash
./hack/bench/checkpoint.sh http://127.0.0.1:8520 100
```

The benchmark:

- creates one temporary wisp
- repeats checkpoint/create/restore/restart `N` times
- verifies `/root/ck.txt` is restored to the expected `before-*` value every round
- prints per-iteration timings plus summary stats
