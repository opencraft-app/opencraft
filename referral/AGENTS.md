# Referral Agent Guide

`referral` owns referral campaigns, reusable referral codes, attribution,
qualification facts, and reward delivery state. It does not reuse user/auth
access invites.

## Boundaries

- user/auth owns account creation and emits `user.registered.v1`.
- CTL owns paid Pass state and emits `pass.first_paid.v1`.
- referral consumes those facts, owns idempotency, and requests promotional
  credit through a server-to-server API.
- Pulsar is transport only; MySQL is the durable referral truth.

## Rules

- Database migrations run only through `referral-migrate`.
- API and worker never run migrations on startup.
- The capability is disabled unless `REFERRAL_ENABLED=true`.
- Production environments must not inherit Beijing campaign configuration.
- Never log referral service tokens, Pulsar credentials, emails, or phones.

## Validation

```bash
cd referral
GOWORK=off go test ./...
GOWORK=off go vet ./...
```
