# Referral

Referral is the LightVela invitation-reward service. It is separate from the
one-time access invite feature in user/auth.

The service exposes privacy-safe referral APIs and a Pulsar worker. The worker
stores versioned registration and first-paid facts before acknowledging a
message, then advances a durable reward state machine.

Beijing sandbox and Shanghai production each use independent database,
Pulsar, SSM/SOPS, and campaign configuration. Other environments remain
disabled until they provide the same independent infrastructure and campaign data.

The API, worker, schema migration, and campaign bootstrap are shipped in one
image. `REFERRAL_ENABLED` controls the public capability while
`REFERRAL_PROCESSING_ENABLED` controls Pulsar consumption and reward grants.

## Attribution Operations

Admin Gateway exposes a narrow, Basic-Auth-protected reset workflow:

```bash
# 1. Preview the authoritative attribution and rewards.
curl -u "$ADMIN_USER:$ADMIN_PASSWORD" \
  "https://admin.example.com/admin/api/referral/attributions/usr_example?attribution_id=rattr_example"

# 2. Reset only after reviewing attribution_id and exact subscription names.
curl -u "$ADMIN_USER:$ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' \
  -X POST \
  "https://admin.example.com/admin/api/referral/attributions/usr_example/reset" \
  -d '{
    "expected_attribution_id":"rattr_example",
    "idempotency_key":"ticket-123-referral-reset",
    "operator":"operator@example",
    "reason":"incorrect attribution confirmed by support"
  }'
```

The service derives reward subscriptions from its own durable state, asks CTL to
revoke exact `free-credit:*` names, then archives a JSON snapshot and removes the
attribution and reward rows atomically. First-paid/refund facts remain immutable.
Pending, vesting, granting, retryable, or manual-review rewards block reset until
their state is resolved; operators must never bypass this with ad-hoc SQL.
