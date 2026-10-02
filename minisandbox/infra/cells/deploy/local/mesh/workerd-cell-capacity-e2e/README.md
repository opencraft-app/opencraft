# Production Cell capacity qualification

This folder defines and qualifies capacity for **one Cell**, not for one machine and not for the
whole A/B fleet. `production-agent-v1.json` is deliberately marked `candidate` until all three
evidence classes pass. A local k3d run can qualify scheduling and lifecycle state machines, but it
cannot qualify FoundationDB throughput because the local fixture is `single` redundancy with one
coordinator and three storage processes. The production boundary is `three_data_hall`, nine
coordinators, and at least nine dedicated FDB processes.

The declared load is mixed: 100 newly ready Agents per second per Cell while 128 long conversations
are resident. The two-Cell public API must therefore receive 200 creations per second. A ten-second
trial creates 2,000 Agents, distributed deterministically across A and B. The ready gate excludes
model execution time and requires every platform creation attempt to complete within three seconds
without a platform retry. Conversation requests have no platform-wide 60-second timeout; caller
cancellation and a future Agent execution policy bound them.

The candidate starts with 16 workerd Hosts per Cell. Each Host exposes 32 resident slots and 16
in-flight requests. With a one-second idle window, the deterministic planning envelope is:

```text
resident demand = 100 create/s * 1 s + 128 conversations = 228
resident capacity after 25% headroom = 16 * 32 * 0.75 = 384
in-flight demand = 100 create/s * 1 s planning time + 128 conversations = 228
in-flight capacity after 10% headroom = floor(16 * 16 * 0.90) = 230
```

This is an admission plan, not performance evidence. Validate it with:

```sh
python3 infra/cells/deploy/local/mesh/workerd-cell-capacity-e2e/validate_profile.py
python3 -m unittest discover \
  -s infra/cells/deploy/local/mesh/workerd-cell-capacity-e2e \
  -p 'test_*.py'
```

The corresponding A/B creation-only probe is:

```sh
python3 infra/cells/deploy/local/mesh/workerd-mass-agent-e2e/run.py \
  --agents 2000 \
  --arrival-rate 200 \
  --concurrency 1024 \
  --hosts-per-cell 16 \
  --engines-per-cell 3 \
  --resource-profile production \
  --host-capacity 32 \
  --max-in-flight 16 \
  --max-queued 16 \
  --queue-timeout-ms 1000 \
  --idle-sleep-ms 1000 \
  --min-populate-throughput 190 \
  --max-populate-p95-ms 3000 \
  --max-populate-latency-ms 3000 \
  --max-populate-retries 0
```

Do not promote the profile from `candidate` merely because that command passes. Qualification also
requires a mixed long-conversation trial, bounded destroy/GC convergence with no growing pending
signal backlog, and the same receipt on the Tencent production FDB/NATS topology.
