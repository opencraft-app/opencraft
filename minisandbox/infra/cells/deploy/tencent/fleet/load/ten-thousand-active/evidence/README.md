# Failed input-prefix capacity run, 2026-10-03

Run `d3a163511fd849bf9a466553e4ab4f48` used runtime source
`072e504bb9784e7d2d0b73def169e886a7f30e31`, immutable runtime image
`sha256:6e4d982e8ca66b8a7841c720143464927cb0f7c09d656f3c1fab1e189b07f3d2`,
and observer/load tools source `d7ff0a90245e1787377146be3fb2e6f7a2051d1f`.
The supervised service completed with exit 1. Submission success was not a
qualification result. These JSON files preserve the original bytes and verdicts.

| Original receipt | Raw SHA-256 |
|---|---|
| `d3a16351-capacity-receipt-20261003.json` | `71d6af2f143a6f7d057c4b6adfe4d362782a903bacd266cc4d0910e7f43297d4` |
| `d3a16351-load-receipt-20261003.json` | `7446442c3bbb7d720aa0207c6295b0a0e96de6bab1911108987eea375d95cec2` |
| `d3a16351-cleanup-receipt-20261003.json` | `789680d82a2d7365a6f53ba00150ad866db1ed0eb473c96746da19d50baf2b6b` |

## Result and boundaries

The load reached 9,194 ready Objects and 2,117,371 successful active
interactions. The first unexpected error was initialization of index 9153 at
`2026-10-02T20:27:13.993Z`, HTTP 502 `indeterminate_result`. Global cancellation
then generated 2,643 active `code=20` errors. Those are not 2,643 independent
network failures, but they still invalidate the load. No identity mismatch or
ordinary request retry was recorded. Warmup did use 7,718 classified capacity
backpressure retries. The steady three-second creation sample never started.

The capacity verifier recorded automatic expansion, stable resource identities,
valid trace, exact cleanup, safe drain, and return to the genuine floor.
It rejected sustained 10,000 active Objects, peak active capacity readiness,
and the load verdict. Peak measured active was 9,162; peak desired Hosts was
528 across both Cells. Samples and load counters are not atomic observations.
Cleanup deleted all 9,226 scheduled identities with no retry. Natural final
capacity convergence took 7,308 seconds after cleanup, returning both Cells to
four admitted/Ready Nodes, Machines, and Hosts. None of these partial successes
allows Router performance qualification.

## Retained raw evidence

Original builder root:
`/data/actor-bootstrap/beijing-rebuild-20260915/load-tests/ten-thousand-active-d3a163511fd849bf9a466553e4ab4f48/`.

The complete 189,670,807-byte `capacity.ndjson` hashes to
`5869f78fded0af51d1f278700f69676637dec017175f1d3428529c2833135cd0`;
the 4,371,604-byte load journal hashes to
`9664977d06f3202b26511e27bd515cc9cbd73588bf423cc9af9ed242d4940e3d`.
They remain outside Git. Builder archive
`/data/actor-build/release/strict10k-d3a163511fd849bf9a466553e4ab4f48/evidence.tar.gz`
contains compressed raw inputs, receipts, state log, and a derived pressure
summary. Its SHA-256 is
`6d3ac610927dd0a66e9f039ab83b6c7d2fcc863855421c64ffbd9c9a5993bf19`.
It was transferred through COS and verified locally; the temporary relay key
was removed by the transfer helper. This transfer is not a permanent COS archive.

Historical Prometheus `query_range` evidence covers 20:07 through 20:28 UTC,
at a 30-second step. Raw `extended-metrics.json` hashes to
`ca9f3dbd7fda077788cc9e47ea1922dcf485e7416c2e4bc77f397c51e29ec0c6`.
The bounded API transport diagnostic hashes to
`39315d9d18f03f4d96d5bb7d39298c9b0f71e54bef44df8df526fc56cc911724`.
Builder `extended-evidence.tar.gz`, in the same archive directory, hashes to
`e04b9a117692e18cb625c7cd48f4f95caf9584bc396fd373b0637d7ca678fd3d`.
Both archives were downloaded to
`/data/tmp/minisandbox-strict10k-d3a16351-evidence-20261003/`.

Only 570 post-cancellation warnings survived the bounded current-Pod API log
selection. They all classify as `context canceled`; they do not establish the
original transport cause. Missing throttle series are missing evidence, not
proof of no CPU throttling. Samples after the first error are excluded from
pre-failure causal comparisons.

## Diagnostic implications, not a complete root cause

The last pre-failure sample at 20:27:02 UTC has A/B active 4,519/4,643,
compaction in-flight 12/12 and waiters 1,360/1,102. B UDB pending is 3,989.
FDB remains healthy/full-replicated and Hosts show zero restarts. Before the
first error, aggregate Engine CPU peaks near 10.6/10.8 cores per Cell; the
six-Engine envelope is not exhausted in aggregate. B UDB operation p99 reaches
about 0.988 seconds, workflow-history mean about 1.007 seconds, and Actor-create
operation p99 about 4.913 seconds. These histogram estimates are not exact
request durations or a single-replica saturation proof.

The sampled final 27-minute window reports zero successful reclaim rate while
authority bytes increase by about 1.35/1.41 GB in A/B. Live pins and retention
can legitimately defer reclaim; zero reclaim alone does not prove a defective
cold planner. Separate hot folding, cold publication, reclaim eligibility,
history replay bytes, transaction retries, and per-Pod CPU before selecting a
remedy. Reducing background permits bounded execution but did not make this
10k run pass. Neither blind replica growth nor looser retries/timeouts is a
validated correction.
