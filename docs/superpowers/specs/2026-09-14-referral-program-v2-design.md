# Referral Program V2

## Scope

Referral rewards are a new domain capability. They do not reuse the existing
one-time access invite codes, `users.invite_required`, or `/auth/invite/*`.

The first release is a Beijing sandbox pilot. Shanghai may prepare an isolated
Pulsar foundation without enabling producers, consumers, routes, campaign, or
frontend. Every environment remains disabled unless it adds its own campaign,
infrastructure, secrets, and release configuration.

## Product Rules

- Each user receives one stable referral code per campaign.
- Only an account created with referral context can be attributed.
- Registration alone does not grant a reward.
- The qualifying fact for the Beijing pilot is the invitee's first successfully
  provisioned Pass through a dianshi order, including zero-charge orders.
  Both a new order-backed Pass activation and a free-Pass-to-order transfer qualify.
  Cash payment is not required. Legacy free trials without an order do not qualify.
- The inviter and invitee each receive 500 credits.
- The default campaign has no observation period (`vesting_days=0`). Rewards
  become immediately eligible after attribution and order-backed activation are
  both persisted; the worker delivers them asynchronously. Refunds cancel only
  ungranted rewards and do not automatically claw back granted credits.
- Granted credits follow the beneficiary's existing active Pass lifecycle and
  are cleaned up by the established `free-credit:*` entitlement path.
- If the inviter has no active Pass, the reward remains pending for up to 90
  days and is granted when an active Pass becomes available.
- One inviter can receive rewards for at most 50 invitees per campaign. The
  campaign also owns a global reward budget.
- Self-referral, duplicate attribution, duplicate qualification, and duplicate
  reward grants are rejected by durable unique keys.

Campaign dates, reward amounts, limits, and budgets are data, not frontend
constants. The Beijing campaign is active only after its schema, event path,
consumer, and direct promotional-credit path are ready.

## Architecture

```text
user/auth registration transaction -> auth outbox --+
                                                    +-> Pulsar -> referral-worker
CTL first-paid transaction          -> ctl outbox ---+                |
                                                                     v
frontend -> service-gateway -> referral-api -> referral MySQL <- rewards
                                                        |
                                                        +-> CTL promotional credit
```

`referral-api` and `referral-worker` are separate deployments built from one Go
module and image. The worker consumes Pulsar directly so application code owns
ACK, retry, and dead-letter behavior. EventBridge and SCF are not required for
the Beijing pilot.

## Pulsar Boundary

The existing Beijing `pulsar-n57ovqb7r7gv` P2 elastic-storage cluster is an
external dependency. Pulumi must not register it as a managed
`tdmq.ProfessionalCluster`: the pinned provider requires a fixed
`storage_size`, which does not safely represent the existing elastic-storage
purchase.

An environment with no existing cluster may explicitly set
`manage_cluster=true`. Pulumi then creates and protects a dedicated professional
cluster with an inventory-pinned product, placement, network, purchase term,
renewal policy, and tags. A P2 elastic-storage creation uses the API's
`storage_size=0` representation and ignores that field after creation. The
created cluster ID and broker endpoint must be written back to inventory before
Role Token bootstrap or application configuration.

Pulumi manages only child resources:

- namespace `lightvela-ref`
- one-day acknowledged-message retention with the Tencent Cloud minimum 10 GiB retention quota
- persistent non-partitioned topic `lightvela.referral.events.v1`
- persistent non-partitioned DLQ `lightvela.referral.events.v1-dlq`
- producer role `lightvela-user-auth-referral-producer`
- producer role `lightvela-ctl-referral-producer`
- consumer role `lightvela-referral-consumer` with consume permission and the
  produce permission required to write the namespace DLQ
- namespace-scoped produce/consume permissions

The cluster ID and expected name, product, zone, VPC, and subnet remain in the
non-secret inventory. A read-only preflight must verify those facts before the
first child-resource creation.

## Events

All events use a versioned envelope with `event_id`, `event_type`,
`occurred_at`, `producer`, `aggregate_id`, `correlation_id`, and `payload`.
Payloads contain identifiers only and never email, phone, access tokens, or
cloud credentials.

- `user.registered.v1`: emitted only when a new user row is created and carries
  the referral code captured before authentication.
- `pass.first_paid.v1`: emitted by both CTL paid creation and paid transfer
  transactions. Renewals and free Passes do not emit it. The current CTL
  completion contract does not carry the cash amount, so a promotional
  zero-charge order for a non-free bundle qualifies in the pilot. A future
  minimum-cash rule requires adding the settled amount and currency to the
  versioned event rather than inferring them from the bundle.

- `pass.refunded.v1`: emitted atomically with CTL's accepted refund isolation
  transition. The consumer records refund facts independently so refund and
  first-paid events can arrive in either order.

Both producers use transactional outboxes and at-least-once publishing. The
consumer persists each event before ACK and deduplicates by `event_id` plus a
payload hash.

## Data and State

The referral schema owns campaigns, codes, attributions, registration facts,
first-paid facts, rewards, and an event inbox. Registration and first-paid
facts may arrive in either order.

Reward states are `pending`, `vesting`, `granting`, `granted`, `cancelled`,
`retryable`, and `manual_review`. The two reward sides are independent and use
stable idempotency keys:

- `referral:<campaign_id>:<invitee_id>:inviter`
- `referral:<campaign_id>:<invitee_id>:invitee`

## API

- `GET /v1/referrals/codes/{code}`: public, privacy-safe validation.
- `POST /v1/referrals/me/code`: authenticated idempotent code issuance.
- `GET /v1/referrals/me`: authenticated link and campaign state.
- `GET /v1/referrals/me/stats`: authenticated aggregate reward state.

The gateway supplies the authenticated user ID. Referral endpoints never accept
an arbitrary owner ID from the browser.

## Rollout

Migration 2 changes only the schema default for `vesting_days`. The campaign
PostSync job updates the configured campaign to zero days. Existing rewards
retain their persisted eligibility dates; this release does not bulk accelerate
or replay them. Explicit nonzero campaign delays remain supported.

1. Create Pulsar child resources without managing the existing cluster.
2. Deploy the referral schema, API, and worker with processing disabled.
3. Add disabled user/auth and CTL outboxes and relays.
4. Validate duplicate delivery, ordering, retry, dead-letter, and recovery.
5. Verify that the CTL promotional-credit API can grant 500/500 credits without
   a caller-supplied Plan ID. VelaGW owns automatic preparation and Set
   synchronization of any internal entitlement template required by the grant.
6. Enable Beijing relays and worker processing.
7. Activate the Beijing campaign and expose the minimal frontend.

No production environment inherits the Beijing enablement. Shanghai may deploy
the schema and two disabled API replicas as an isolated foundation, but keeps
the worker at zero replicas and omits campaign bootstrap, event producers,
Gateway routes, and frontend exposure until a separate activation review.
