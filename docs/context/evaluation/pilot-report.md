# Isolated Pilot Report

> **Superseded:** this is the 22-sample interim report. The completed 50-sample fixed-model report is [final-report.md](final-report.md).

## Status

Rebuilding. The original 16-record pilot is invalidated by [contamination-audit.md](contamination-audit.md). A leakage-safe runner is now in use.

## Clean Tool-Assisted Pilot

Current valid sample count: 22.

| Sample | Control Top-5 Recall | Treatment Top-5 Recall | Control tokens | Treatment tokens | Control time | Treatment time |
|---|---:|---:|---:|---:|---:|---:|
| `mono2-mr-210#run1` | 0.600 | 0.200 | 67,848 | 91,580 | 73.8s | 239.6s |
| `mono2-mr-904#run1` | 0.750 | 1.000 | 28,119 | 25,072 | 78.3s | 95.9s |
| `mono2-mr-1065#run1` | 0.143 | 0.714 | 41,104 | 38,468 | 116.2s | 135.5s |
| `mono2-mr-1253#run1` | 0.182 | 0.091 | 28,467 | 27,561 | 100.0s | 98.7s |
| `mono2-mr-1305#run1` | 0.000 | 0.500 | 46,769 | 47,220 | 211.9s | 254.5s |
| `mono2-mr-1312#run1` | 0.167 | 0.667 | 26,187 | 30,054 | 105.5s | 116.8s |
| `mono2-mr-1326#run1` | 1.000 | 0.400 | 45,303 | 29,154 | 132.8s | 110.8s |
| `mono2-mr-1457#run1` | 0.000 | 0.800 | 39,746 | 38,240 | 160.2s | 75.0s |
| `mono2-mr-1465#run1` | 1.000 | 1.000 | 35,743 | 36,802 | 58.6s | 199.7s |
| `mono2-mr-1469#run1` | 0.000 | 0.154 | 35,381 | 29,985 | 93.0s | 57.2s |
| `mono2-mr-1503#run1` | 0.357 | 0.286 | 48,172 | 30,056 | 117.3s | 151.3s |
| `mono2-mr-1598#run1` | 0.286 | 0.286 | 55,599 | 56,622 | 111.9s | 165.0s |
| `mono2-mr-1675#run1` | 1.000 | 1.000 | 43,558 | 62,018 | 112.4s | 90.7s |
| `mono2-mr-1843#run1` | 0.111 | 0.222 | 58,779 | 35,599 | 152.1s | 117.1s |
| `mono2-mr-1852#run1` | 0.667 | 0.667 | 42,167 | 45,261 | 81.6s | 82.3s |
| `mono2-mr-1959#run1` | 0.000 | 0.083 | 33,644 | 36,161 | 47.0s | 93.2s |
| `mono2-mr-1977#run1` | 0.625 | 0.000 | 33,701 | 33,310 | 167.5s | 172.1s |
| `mono2-mr-2025#run1` | 0.444 | 0.444 | 41,513 | 42,420 | 200.4s | 244.2s |
| `mono2-mr-2241#run1` | 0.083 | 0.000 | 75,549 | 53,549 | 169.0s | 184.8s |
| `mono2-mr-2265#run1` | 0.333 | 0.267 | 51,361 | 64,334 | 72.1s | 236.1s |
| `mono2-mr-2476#run1` | 0.286 | 0.286 | 53,310 | 44,831 | 98.8s | 181.6s |
| `mono2-mr-2492#run1` | 0.000 | 0.250 | 65,641 | 52,947 | 160.5s | 161.2s |

### Aggregate

| Metric | Control | Treatment |
|---|---:|---:|
| Mean Top-5 Recall | 0.365 | 0.424 |
| Mean MRR | 0.714 | 0.886 |
| Mean Full Recall | 0.428 | 0.436 |
| Mean tokens used | 45,348 | 43,238 |
| Mean wall time | 119.1s | 148.3s |

Paired outcome: Treatment improved on 9 of 22 samples, tied on 6, and reduced recall on 7.

Paired Top-5 Recall difference: mean `+0.058`, median `0.000`, standard deviation `0.345`. A 10,000-resample bootstrap gives an approximate 95% confidence interval of `[-0.084, +0.199]`. Because the interval crosses zero, this is not a statistically significant improvement and must not be presented as a production gain.

Interim read: the treatment bundle currently buys a modest ordering-quality gain and slightly lower token usage, but it also increases wall time and does not yet improve full recall. The next iteration should focus on reducing false routing and preserving strong baseline retrieval instead of adding more generic context.

### Slice Analysis

| Size | Samples | Mean Recall Diff | Mean Token Diff | Mean Time Diff |
|---|---:|---:|---:|---:|
| Small | 7 | +0.007 | +3,663 | +28.0s |
| Medium | 14 | +0.094 | -3,576 | +30.7s |
| Large | 1 | -0.083 | -22,000 | +15.8s |

The only large sample is insufficient for a size conclusion. The current dataset is frontend-heavy, so service slices would be misleading until more backend and infrastructure cases are added.

A separate consumption audit found that only 5 of 22 treatment logs referenced `docs/context`; the other 17 did not consume the bundle. See [context-consumption-audit.md](context-consumption-audit.md). This likely dilutes the measured treatment effect and is the highest-priority fix for the next context iteration.

## Context-Only Diagnostic

The context-only mode disables repository inspection and tests what automatically loaded context can infer without tools. It is not the main AI-coding experiment.

| Sample | Control Top-5 Recall | Treatment Top-5 Recall |
|---|---:|---:|
| `mono2-mr-293#run1` | 0.000 | 0.000 |
| `mono2-mr-900#run1` | 0.000 | 0.000 |
| `mono2-mr-904#run1` | 0.000 | 0.000 |
| `mono2-mr-1065#run1` | 0.000 | 0.000 |

Conclusion: exact changed-file prediction cannot rely on context alone. Tool-assisted retrieval remains required for the main experiment.

## Current Blockers

1. The `glm-5.3` API key was restored after a temporary `401 Unauthorized` outage.
2. The hard five-command tool budget is now implemented and has been validated by three completed samples.
3. Two complex samples (`mono2-mr-293`, `mono2-mr-900`) still time out after 300 seconds because the Control arm enters broad subscription, quota, or memory-related exploration.
4. The main experiment must continue with the same model and reasoning effort; switching models is not allowed.
5. The local model proxy is currently unreachable from this sandboxed shell, so the remaining 25 samples cannot be executed until network access is restored.

## Execution Events

- `mono2-mr-293#run1` was invalidated as a partial run: Control completed, Treatment failed with provider API key disabled. See [execution-events.jsonl](execution-events.jsonl).
- `mono2-mr-293#run1` was later invalidated again because Control timed out after 300 seconds.
- `mono2-mr-900#run1` was invalidated because Control timed out after 300 seconds despite the five-command budget.
- `mono2-mr-1469#run1` completed successfully after a transient provider `502` failure; the successful paired run is included above.
- `mono2-mr-2360#run1` was invalidated because Control used all five commands but two very large file reads stalled final JSON generation until timeout.

## Required Before Continuing

1. Keep the sanitized treatment bundle.
2. Keep the preflight gold-side scan.
3. Keep the frozen context hash.
4. Use fresh sessions for every sample and arm.
5. Use bounded exploration rather than unbounded repository audits.
6. Retry transient `429` responses with backoff.
7. Repeat a held-out subset to estimate stochastic variance.
8. Capture token, cache, wall-time, and tool-call metrics.
9. Restore the disabled provider API key before continuing.

The sanitized bundle, preflight scan, context hash, fresh-session runner, metric capture, five-command tool budget, and retry handling are implemented. Two complex samples still need a more deterministic routing strategy before they can be included.
