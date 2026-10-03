# Router performance evidence

This read-only collector joins a passed 10,000-active-Agent capacity receipt
with a separate clean stateless-Worker-binding performance-load receipt and its Hub Prometheus history
into immutable Phase 5 evidence. Separating those owners avoids repeating a
multi-hour cloud node expansion/drain cycle merely because an observability
query changed. The performance load must last at least five minutes and, by
default, complete at least 10,000 real Object requests without retry or failure.
It records:

- Object Router request rate and p50/p99/p999 latency.
- placement-cache hit ratio and Registry TPS/p99.
- bounded source/target Cell p50/p99/p999 latency and route rate.
- Workers API CPU, RSS, ready replicas, and CPU seconds per Object request.
- client arrival-to-dispatch delay, dispatch-to-response latency, and complete
  arrival-to-response latency, with a fixed offered-request count and no retries.

Load and capture receipts use schema v2. The collector rejects older receipts
that cannot distinguish the offered-load window from response drain. It also
requires every planned request to be scheduled, completed, and represented in
all three client timing histograms; a slow load generator cannot be mistaken
for a successful smaller workload. Generator delay is measured, not silently
subtracted from the end-to-end latency. Reaching the bounded in-flight limit
still fails the load rather than turning it into a self-throttling closed loop.
Requests first dispatched after the offered-load deadline make the run fail
with `load_generator_deadline`, even if their later responses all succeed.
The receipt records within-window and late dispatch counts separately.

Every five-minute Prometheus selector is evaluated only after the first five
minutes of offered load and no later than the offered-load deadline. Preparation,
waiting for final responses, and cleanup do not extend that measurement window.
A five-minute load therefore has just one complete rolling evaluation; choose
a longer load for a time-series curve. The receipt preserves both the offered
window and the evaluation window. Client histograms still include final response
latency, and rolling Prometheus rates remain sampling estimates, not exact counts.

The collector saves the complete Prometheus `query_range` responses before it
writes a receipt. The receipt binds the raw evidence, performance load, 10k
qualification receipt, query set, and exact UTC time range by SHA-256. Missing
series, a non-passed qualification, NaN-only data, same-Cell-only route data,
or an attempt to overwrite prior evidence fails closed.

Every sample must have a numeric timestamp inside the requested load window
(with 1 ms tolerance for transport rounding), match its evaluation grid, and
be strictly time-ordered within each series. Malformed rows, duplicate label series, and invalid timestamps
are errors, not discarded observations. Legitimate NaN/Inf metric values are
counted as discarded and never become zero latency. Each measurement requires
a finite sample at the final requested evaluation; a historical finite value
cannot replace a missing or NaN final evaluation. Distinct source/target RTT
must also be present at that evaluation. The receipt reports per-series latest
finite timestamps so partial observations remain visible. Sample means are
means of observed evaluations, not exact time-integrated event totals.

The load must enter through `/workers/{worker}/dispatch`; direct ObjectRef
traffic has no bounded stateless executor Cell and is deliberately rejected.
`run.py` publishes one immutable Worker, prepares a balanced Object set in all
requested placement-ready Cells, then calls those Objects through the Worker
binding for at least five minutes. It performs no retry, verifies every
authoritative placement through Registry, deletes the temporary Objects, and
retains the terminal Durable Object Worker namespace as required by the public
API safety model.

Registry `/readyz` is checked before publishing any temporary resource. For a
builder outside the Hub cluster, select `--registry-service worker-registry`
and `--registry-namespace worker-registry-system` instead of using the cluster's
internal DNS name. The runner owns the Hub port-forward and closes it on both
normal and exceptional exits. A reachable direct `--registry-endpoint` remains
available, mutually exclusive with the Service selector.

Preparation failure also produces a failed receipt and cleans only the exact
Object IDs attempted by this run, including a request whose response was lost.
The receipt records attempted/deleted IDs and per-Object cleanup errors for
recovery. Confirmed Objects require DELETE 204/410; 404 is accepted only for
unconfirmed attempts that may never have been created. No non-idempotent
dispatch is retried. Publishing, preparation and cleanup requests are excluded
from the load latency histogram.

```bash
./run.py \
  --endpoint http://10.160.0.3:6688/v1 \
  --registry-endpoint http://10.160.0.15:8080 \
  --hub-kubeconfig "$BOOTSTRAP/input/management.kubeconfig" \
  --cell actor-bj-a01 --cell actor-bj-b01 \
  --duration-seconds 300 --rate 40 --objects 256 \
  --receipt "$RUN/router-binding-load.json"
```

The reviewed builder entrypoint resolves the current public `/v1` and Hub
kubeconfig from authoritative receipts and selects the Hub Registry Service. It
refuses to create temporary resources unless the exact capacity receipt is a
complete passed 10k cycle, then runs both the five-minute load and collector:

容量前置门禁与最终采集共用 `capture.py` 的 `validate_qualification`。八项周期检查必须全部存在，
每个值必须为 JSON `true`；空或部分表、字符串 `"false"`、整数 `1` 均不能替代通过。
新增检查项也必须为真，`expected.active` 必须为至少10000的整数。builder 在创建输出目录和
发布临时资源前检查，collector 在访问 Prometheus 或生成证据前重复同一检查。

```bash
ACTOR_REVIEWED_SOURCE=/var/lib/actor-build/deploy/q01-src-<revision>-<manifest> \
  ./run-on-builder.sh <capacity-run-id> <performance-run-id>
```

It writes beneath
`load-tests/router-performance-<performance-run-id>/` and never overwrites an
existing run. The lower-level collector remains available when a valid load
receipt already exists:

```bash
python3.11 capture.py \
  --load-receipt "$RUN/router-binding-load.json" \
  --qualification-receipt "$RUN/receipt.json" \
  --kubeconfig "$BOOTSTRAP/input/management.kubeconfig" \
  --output-directory "$RUN/router-performance"
```

The current Prometheus retention must cover the load receipt's full time
window. The collector does not mutate Kubernetes resources and does not infer
capacity thresholds from one run; it preserves measurements for comparison
across cache-hit mixes and Router replica curves.

The current balanced round-robin working set does not guarantee a chosen cache
hit ratio. The 1%/50%/99% and 1/4/8/16 replica matrix still requires controlled
working sets, immutable runtime/config identities, and observed cache-hit
validation. A proposed hot-key fraction is not cache-hit evidence. Increasing
the number of newly created Objects also changes claim/wake cost and must not
be presented as an isolated placement-cache experiment.
