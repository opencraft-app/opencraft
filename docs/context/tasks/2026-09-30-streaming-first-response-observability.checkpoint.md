## stage
Source diagnostics are implemented for VelaGW and NewAPI. The user has now authorized production publication; release preparation is underway, with source commit, image builds, GitOps and blue-green Set rollout still pending.

## verified
- Focused Go tests and `go vet` pass in both services using the local Go 1.25.14 builder image.
- Gateway route tests cover correlation-ID overwrite/forwarding and cancellation timing; NewAPI tests cover slow/error header wait and post-header stream timing.
- No ping, timeout, retry, routing, status, or stream-output behavior was intentionally changed.
- Before rollout, Shanghai and Johor Bahru VelaGW Argo apps are `Synced/Healthy` at `d4a49712d`; five Shanghai and two Johor Bahru managed NewAPI Sets pin their own current image digests.

## unverified
- Live production behavior after rollout; no deployment has occurred yet.
- Root cause of the approximately 60-second cancellations; the new logs are intended to disambiguate it.

## discard
- VelaGW `streaming=false` classifies the upstream response MIME type (and is the default before headers), not the request's `stream` parameter.

## restore
- Worktree: `/data/mono2-velagw-response-milestones-20260930`.
- Preserve unrelated untracked NewAPI perf-monitor files under `docs/context/tasks/` and `scripts/`.
- Task Pack: `docs/context/tasks/2026-09-30-streaming-first-response-observability.md`.

## next_action
Commit only the observability patch on current `master`, build immutable images, and follow GitOps plus blue-green Set rollout with canary and rollback checks.
