# backend_usage

Owns dynamic backend usage snapshots for UI display.

`backend` is a configured backend instance id. `backend_type` describes the
implementation family, such as `codex`. This keeps the contract ready for
multiple Codex-backed instances without turning `/api/v1/backends` into a slow
quota fetch.

The backend snapshot only declares `capabilities.usage_snapshot`. The real
usage data is fetched through `/api/v1/backends/{backend}/usage`.
