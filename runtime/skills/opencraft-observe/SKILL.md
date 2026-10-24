---
name: opencraft-observe
description: Inspect this OpenCraft deployment's runtime health, operation latency, execution progress, activity and collection coverage; capture incident evidence and compare performance before and after an authorized change.
---

Use the installed `opencraft-observe` command. The deployment supplies `OPENCRAFT_OBSERVE_TARGET`; keep that target unless the user selects another authorized deployment. A Unix socket grants the maintenance OS identity read access, not additional business or deployment rights. Do not inspect backend credentials or substitute another user's browser session.

Start with `opencraft-observe capabilities --json` and `opencraft-observe status --window 15m --json`. Check component identities, missing/stale producers, sampling and loss before interpreting values. Exit zero means a query succeeded; the platform can still be degraded or unknown. No samples do not prove success, failure, a client freeze or zero usage.

For an investigation, capture an absolute UTC window:

```sh
opencraft-observe snapshot --from "$OBS_FROM" --to "$OBS_TO" --out "$OBS_BEFORE" --json
opencraft-observe issues --snapshot "$OBS_BEFORE" --json
opencraft-observe explain --snapshot "$OBS_BEFORE" --finding "$OBS_FINDING" --json
opencraft-observe incident --ref "$OBS_INCIDENT" --out "$OBS_EVIDENCE" --json
```

Choose new output paths; evidence files are never overwritten. Incident retrieval reads already captured evidence and cannot capture a browser, retry a turn or restart a component. Retain no_capture/partial/expired findings. A later capture must not be presented as part of the original snapshot.

Distinguish whole navigation from an RPC, catalog first page from completion, cached display from authoritative recovery/configuration and submission readiness, recovery episodes from physical attempts, and execution domain facts from subscriptions or steer requests. Queue samples expire to unknown and do not count as execution rounds. Latest domain state is separate from the selected historical window; old progress alone does not establish a hang. Activity is observed interactive verified-human union, not billing or token allocation. Histograms and resource samples are estimates, not exact operation records.

Form a falsifiable hypothesis from this evidence. Follow the user's existing authorization and delivery workflow for any change, then verify actual running component revisions. Capture a separate after window with the same operation boundary, cache state, engine, workload, source classification and sampling:

```sh
opencraft-observe compare --before "$OBS_BEFORE" --after "$OBS_AFTER" --operation thread_open --cache cold --json
```

The comparison requires at least 20 paired synthetic operations or 100 uniform real operations. Missing coverage, different workloads or insufficient samples yield inconclusive; do not force a green result or claim causality. Include failures, unknowns, resource and behavior side effects with any observed improvement. Do not generate paid inference or replay user messages merely to increase sample counts.
