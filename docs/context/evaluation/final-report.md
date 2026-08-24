# Final Fixed-Model Context Evaluation Report

## Status

Complete for the current frozen context bundle.

- Valid paired samples: **50**
- Model: `glm-5.3`
- Reasoning effort: `low`
- Context hash: `19683e617848bedb3160af1f920b8f57a2d80d06a41cef31fcdb475cd46dba72`
- Execution mode: fresh Codex CLI session per arm
- Arms: early samples ran sequentially; after the parallel runner change, Control and Treatment ran concurrently while preserving independent work directories and sessions
- Dataset: [candidates.jsonl](candidates.jsonl) contains 56 real merged MRs; 6 sample IDs were invalid across 7 execution events and were replaced by additional eligible MRs

## Headline Result

| Metric | Control | Treatment | Difference |
|---|---:|---:|---:|
| Mean Top-5 Recall | 0.276 | 0.321 | +0.045 |
| Mean MRR | 0.642 | 0.671 | +0.029 |
| Mean Full Recall | 0.325 | 0.356 | +0.031 |
| Mean tokens used | 43,131 | 38,858 | -4,273 |
| Mean wall time | 132.5s | 149.2s | +16.7s |
| Mean tool calls | 5.5 | 5.7 | +0.2 |

Paired Top-5 Recall outcome:

- Treatment improved: 21 samples
- Tie: 15 samples
- Treatment decreased: 14 samples

Paired difference:

- Mean: `+0.045`
- Median: `0.000`
- Standard deviation: `0.279`
- Bootstrap 95% CI (10,000 resamples): `[-0.032, +0.120]`

The interval still crosses zero. The correct conclusion is: **directionally positive but not statistically significant**.

## Context Consumption

The treatment log referenced `docs/context` in **23 of 50** samples.

| Group | Samples | Mean Recall Diff | Wins | Ties | Losses |
|---|---:|---:|---:|---:|---:|
| Consumed `docs/context` | 23 | +0.052 | 11 | 5 | 7 |
| Did not consume `docs/context` | 27 | +0.038 | 10 | 10 | 7 |

Consumed runs:

- Treatment / Control mean Top-5 Recall: `0.295 / 0.243`
- Treatment / Control mean tokens: `40,965 / 42,700`

Non-consumed runs:

- Treatment / Control mean Top-5 Recall: `0.343 / 0.305`
- Treatment / Control mean tokens: `37,064 / 43,498`

Interpretation: consuming the context bundle did not dramatically outperform non-consumption in this iteration. The main engineering problem remains that the bundle is not reliably load-bearing.

## Slices

### Size

| Size | Samples | Mean Recall Diff | Wins | Ties | Losses |
|---|---:|---:|---:|---:|---:|
| Small | 17 | +0.042 | 6 | 7 | 4 |
| Medium | 24 | +0.067 | 11 | 7 | 6 |
| Large | 9 | -0.012 | 4 | 1 | 4 |

### Risk

| Risk | Samples | Mean Recall Diff | Wins | Ties | Losses |
|---|---:|---:|---:|---:|---:|
| Billing | 6 | 0.000 | 1 | 4 | 1 |
| Cross-service | 9 | -0.012 | 4 | 1 | 4 |
| Release | 6 | +0.170 | 4 | 2 | 0 |
| Security | 5 | -0.101 | 1 | 2 | 2 |
| None | 31 | +0.059 | 13 | 10 | 8 |

### Primary Service

| Service | Samples | Mean Recall Diff | Wins | Ties | Losses |
|---|---:|---:|---:|---:|---:|
| frontend | 30 | +0.034 | 11 | 8 | 11 |
| ctl | 8 | +0.073 | 5 | 2 | 1 |
| trade | 5 | 0.000 | 1 | 3 | 1 |
| argocd | 6 | +0.059 | 3 | 2 | 1 |
| gateway-dashboard | 3 | -0.026 | 0 | 2 | 1 |
| sandbox | 2 | -0.051 | 0 | 0 | 2 |
| ticket | 2 | +0.500 | 2 | 0 | 0 |
| velagw | 3 | +0.035 | 3 | 0 | 0 |

The dataset remains frontend-heavy. Service-level numbers should be read as weak directional evidence, not production conclusions.

## Invalid Attempts

The following attempts are documented in [execution-events.jsonl](execution-events.jsonl) and are not counted:

- `mono2-mr-293`
- `mono2-mr-900`
- `mono2-mr-2360`
- `mono2-mr-2359`
- `mono2-mr-2554`
- `mono2-mr-3144`

The initial dataset had 50 records. Five sample IDs from that set were invalid; one replacement also timed out. Six additional eligible merged MRs were added, preserving 50 valid paired samples. `mono2-mr-293` has two documented execution events, so there are seven events for six invalid sample IDs.

## Findings

1. The context bundle provides a small directional retrieval improvement and reduces average token usage.
2. The improvement is not statistically significant at the 95% level.
3. Treatment increases wall time by about 16.7 seconds on average.
4. Only 46% of treatment runs consumed `docs/context`.
5. Billing and security slices do not improve, suggesting current external-domain context is insufficient.
6. Structured-output failures and broad exploration remain runner-level risks.

## Recommended Next Iteration

1. Make `docs/context/README.md` and `context-routing.yaml` mandatory reads before planning.
2. Add a compact context summary to the root entry or task prompt.
3. Add a preflight consumption check and mark `context_not_consumed`.
4. Expand Tencent Cloud API, billing, CAM, quota, and region-specific context.
5. Re-freeze the context bundle and rerun a held-out subset.

See [next-iteration.md](next-iteration.md).

## Appendix: All Valid Samples

| Sample | Control Recall@5 | Treatment Recall@5 | Control tokens | Treatment tokens | Control time | Treatment time |
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
| `mono2-mr-2547#run1` | 0.069 | 0.000 | 48,464 | 27,950 | 128.3s | 263.8s |
| `mono2-mr-2586#run1` | 0.025 | 0.000 | 47,095 | 46,882 | 160.9s | 149.3s |
| `mono2-mr-2649#run1` | 0.286 | 0.357 | 56,293 | 38,124 | 145.9s | 113.1s |
| `mono2-mr-2800#run1` | 0.094 | 0.031 | 44,421 | 15,367 | 136.5s | 80.4s |
| `mono2-mr-2828#run1` | 0.500 | 0.000 | 20,255 | 42,413 | 193.1s | 149.5s |
| `mono2-mr-2161#run1` | 0.000 | 0.000 | 33,021 | 26,443 | 128.7s | 146.2s |
| `mono2-mr-2498#run1` | 0.136 | 0.182 | 37,276 | 54,509 | 142.8s | 166.5s |
| `mono2-mr-2216#run1` | 0.103 | 0.128 | 42,824 | 47,623 | 153.8s | 216.2s |
| `mono2-mr-2516#run1` | 0.077 | 0.115 | 44,179 | 35,988 | 132.6s | 169.2s |
| `mono2-mr-2093#run1` | 0.333 | 0.500 | 40,624 | 43,178 | 218.8s | 225.3s |
| `mono2-mr-2269#run1` | 0.000 | 0.000 | 60,098 | 39,465 | 176.8s | 119.4s |
| `mono2-mr-2094#run1` | 0.000 | 0.333 | 23,886 | 39,690 | 180.9s | 147.1s |
| `mono2-mr-1928#run1` | 0.000 | 0.167 | 58,943 | 43,030 | 192.6s | 157.1s |
| `mono2-mr-2833#run1` | 1.000 | 1.000 | 31,473 | 30,275 | 66.0s | 64.5s |
| `mono2-mr-2814#run1` | 1.000 | 1.000 | 38,210 | 30,883 | 88.0s | 102.3s |
| `mono2-mr-643#run1` | 0.077 | 0.000 | 52,195 | 31,205 | 149.9s | 208.9s |
| `mono2-mr-1923#run1` | 0.000 | 0.000 | 48,830 | 39,077 | 129.0s | 162.8s |
| `mono2-mr-2620#run1` | 0.089 | 0.111 | 57,548 | 33,787 | 284.6s | 99.8s |
| `mono2-mr-2470#run1` | 0.000 | 0.000 | 31,715 | 44,421 | 125.5s | 136.7s |
| `mono2-mr-2239#run1` | 0.021 | 0.021 | 24,193 | 22,350 | 66.7s | 268.0s |
| `mono2-mr-2090#run1` | 0.000 | 0.500 | 15,297 | 32,987 | 52.0s | 79.6s |
| `mono2-mr-2132#run1` | 0.143 | 0.286 | 27,537 | 31,808 | 161.2s | 202.9s |
| `mono2-mr-2092#run1` | 0.500 | 1.000 | 52,893 | 26,513 | 221.6s | 161.1s |
| `mono2-mr-3135#run1` | 0.333 | 0.667 | 42,058 | 36,172 | 74.0s | 128.6s |
| `mono2-mr-3147#run1` | 0.500 | 0.333 | 53,615 | 28,795 | 126.9s | 130.9s |
| `mono2-mr-3036#run1` | 0.500 | 0.000 | 47,356 | 19,965 | 100.9s | 112.8s |
| `mono2-mr-3028#run1` | 0.000 | 0.000 | 37,544 | 33,635 | 79.7s | 131.7s |
| `mono2-mr-3133#run1` | 0.000 | 0.000 | 41,045 | 49,123 | 185.7s | 102.6s |
