# Referral

Referral is the LightVela invitation-reward service. It is separate from the
one-time access invite feature in user/auth.

The service exposes privacy-safe referral APIs and a Pulsar worker. The worker
stores versioned registration and first-paid facts before acknowledging a
message, then advances a durable reward state machine.

The Beijing sandbox is the first configured environment. Its source overlay is
enabled, while Argo catalog registration remains gated on the independent
database and SSM/SOPS payload. Other environments remain disabled until they
provide independent infrastructure and campaign data.

The API, worker, schema migration, and campaign bootstrap are shipped in one
image. `REFERRAL_ENABLED` controls the public capability while
`REFERRAL_PROCESSING_ENABLED` controls Pulsar consumption and reward grants.
