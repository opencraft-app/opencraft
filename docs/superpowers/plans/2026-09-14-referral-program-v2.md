# Referral Program V2 Implementation Plan

## Phase 1: Pulsar Foundation

- [x] Add a non-secret external Pulsar inventory contract.
- [x] Validate the real Beijing inventory file.
- [x] Register namespace, topic, DLQ, producer roles, consumer role, and permissions.
- [x] Add `INFRA_COMPONENT_SCOPE=pulsar` and Pulumi mock coverage.
- [x] Add parameterized, non-logging Role Token delivery to environment SSM.
- [ ] Run a read-only cloud preflight and Pulumi preview before any apply.

Read-only Tencent Cloud API preflight passed on 2026-09-14. The Pulumi preview
remains open because the local runner does not currently have the `pulumi` CLI.

## Phase 2: Referral Service

- [x] Add the referral schema and migration runner.
- [x] Add campaign, code, attribution, fact, inbox, and reward stores.
- [x] Add authenticated/public APIs and privacy-safe responses.
- [x] Add direct Pulsar consumption with explicit ACK/NACK, DLQ, and deduplication.
- [x] Add reward vesting, refund cancellation, retry, pending expiry, and reconciliation.

## Phase 3: Event Producers

- [x] Capture referral context through OAuth, password, and phone registration.
- [x] Insert `user.registered.v1` with new-user creation transactions.
- [x] Insert `pass.first_paid.v1` in CompletePass and paid-transfer transactions.
- [x] Add leased, broker-resilient outbox relays to user/auth and CTL, disabled by default.

## Phase 4: Reward Grant and Frontend

- [x] Add an idempotent promotional-credit contract with qualification recheck.
- [x] Extend the promotional-credit API to accept a credit amount and
  let VelaGW automatically prepare its internal entitlement template.
- [x] Add minimal referral link, validation, and real statistics UI behind runtime readiness.
- [x] Remove all hard-coded referral identities, codes, and counters.

## Phase 5: Beijing Acceptance

- [ ] Publish schema before workloads.
- [ ] Verify out-of-order and duplicate event delivery.
- [ ] Verify first paid creation and free-to-paid transfer.
- [ ] Verify seven-day vesting and refund cancellation.
- [ ] Enable Beijing only and confirm other environments remain disabled.
