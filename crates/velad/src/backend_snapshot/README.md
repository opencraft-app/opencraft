# velad backend snapshot

This folder owns the local `velad` backend snapshot contract.

The snapshot is the single server-side source for backend readiness, model
options, reasoning effort options, permission modes, feature controls, and
backend discovery errors. HTTP `/api/v1/backends`, session creation defaults,
and agent config validation must consume this model instead of rebuilding model
fallbacks independently.

Codex is strict: models must come from app-server model discovery. If Codex
model discovery fails or returns no models, the snapshot is an error and Codex
session creation is rejected.
