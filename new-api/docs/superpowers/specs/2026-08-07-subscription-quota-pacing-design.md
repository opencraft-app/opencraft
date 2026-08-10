# Subscription Quota Pacing Design

## Status

Implemented and verified.

## Problem

VelaGW-managed NewAPI subscriptions expose a full monthly quota at the start of
each quota cycle. A user can therefore consume the whole monthly entitlement
immediately, creating avoidable traffic and cost bursts.

The desired behavior is cumulative quota release:

- The existing monthly quota remains the hard total limit.
- Quota is released in windows of at most seven days.
- Unused released quota carries forward within the same monthly cycle.
- The final partial window releases the exact remaining entitlement.
- Existing subscriptions start pacing only after their next monthly reset.

This is not an independent weekly quota. It does not require another persisted
usage counter.

## Goals

- Prevent a subscription from admitting the full monthly quota at cycle start.
- Preserve carry-forward of unused released quota.
- Preserve the exact monthly entitlement for 28, 29, 30, and 31 day cycles.
- Reuse the existing transactional subscription pre-consume path.
- Add no database columns, tables, migrations, Redis keys, or background jobs.
- Leave wallet billing, token-key quota, BYOK, and non-monthly subscriptions
  unchanged.

## Non-goals

- A strict sliding-window limit over the previous 168 hours.
- A separate non-carrying weekly quota.
- Changing monthly reset timing.
- Replacing the existing pre-consume and settlement accuracy model.
- Adding pacing configuration to the SubscriptionPlan schema.

## Existing Source of Truth

The calculation uses only existing `UserSubscription` fields:

- `AmountTotal`: quota available for the complete cycle.
- `AmountUsed`: quota consumed in the current cycle.
- `LastResetTime`: start of the current quota cycle.
- `NextResetTime`: end of the current quota cycle.
- `EndTime`: fallback end of the final partial cycle when no later reset fits
  before subscription expiry.

`PreConsumeUserSubscription` already locks active subscription rows with
`SELECT ... FOR UPDATE`, resets due subscriptions, writes an idempotent
pre-consume record, and increments `AmountUsed` in one transaction. The pacing
decision runs inside that transaction after a due reset and before candidate
selection.

## Release Calculation

Definitions:

```text
Q  = AmountTotal
U  = AmountUsed
T0 = LastResetTime
T1 = NextResetTime when NextResetTime > T0, otherwise EndTime
W  = 7 * 24 * 60 * 60 seconds
D  = T1 - T0
```

For time `now` inside the cycle:

```text
elapsed       = clamp(now - T0, 0, D - 1)
windowIndex   = floor(elapsed / W)
windowEnd     = min(T0 + (windowIndex + 1) * W, T1)
releasedTime  = windowEnd - T0
cap           = floor(Q * releasedTime / D)
available     = max(0, cap - U)
nextReleaseAt = windowEnd when windowEnd < T1
```

When `windowEnd == T1`, `cap` is set to `Q` exactly. This releases all division
rounding and partial-window remainder in the final window.

The implementation must avoid overflowing `int64`. It computes the product as
an unsigned 128-bit integer with `math/bits.Mul64`, then divides it with
`math/bits.Div64`:

```text
high, low = Mul64(Q, releasedTime)
cap = Div64(high, low, D)
```

All inputs are positive `int64` values and `releasedTime <= D`, so the quotient
cannot exceed `Q` and fits in `int64`. The final-window `cap = Q` assignment
remains authoritative.

### Examples

For examples where one million quota units are represented as `1M`:

```text
28-day cycle, Q=28M: 7M -> 14M -> 21M -> 28M
30-day cycle, Q=30M: 7M -> 14M -> 21M -> 28M -> 30M
31-day cycle, Q=31M: 7M -> 14M -> 21M -> 28M -> 31M
```

A partial first calendar-month cycle uses its actual `T1 - T0` duration. For
example, a 13-day cycle releases `7/13` of the quota in its first window and
the remainder in its final six-day window. This preserves the full entitlement
that the current monthly subscription model already grants to a partial cycle.

The final partial cycle before subscription expiry follows the same rule. The
existing reset calculation intentionally stores `NextResetTime == 0` when the
next calendar boundary would be later than `EndTime`. In that case pacing uses
`EndTime` as `T1`, so the last cycle is paced and its final partial window still
releases the exact remaining entitlement.

If the complete cycle is seven days or shorter, it consists of one final
window and the complete cycle quota is available immediately.

Pacing never recomputes calendar boundaries from wall-clock dates. It uses the
persisted cycle timestamps after the existing due-reset logic has run. This
preserves the current process time-zone and reset semantics exactly.

## Eligibility and Rollout

Pacing is controlled by a process-wide Unix timestamp:

```text
SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT
```

Unset, zero, or invalid configuration disables pacing. All NewAPI processes in
one Set must receive the same value.

A subscription is eligible only when all of the following are true:

- `AmountTotal > 0`.
- The associated plan has `quota_reset_period == monthly`.
- `LastResetTime > 0` and either `NextResetTime` or `EndTime` defines a cycle
  end later than `LastResetTime`.
- `LastResetTime >= effectiveAt`.

The last condition implements the existing-user rollout:

- A subscription already inside a monthly cycle at rollout keeps current
  behavior for the rest of that cycle.
- The existing monthly reset advances `LastResetTime`; pacing then activates
  automatically.
- A new subscription created after the effective timestamp starts pacing
  immediately.

No backfill or per-user migration is required. Invalid legacy timing data keeps
the existing monthly-only behavior.

## Pre-consume Behavior

For each locked active subscription candidate:

1. Run the existing due-reset logic.
2. Load the associated plan as the current path already does.
3. Preserve the existing `AmountTotal <= 0` unlimited-subscription branch:
   select it as a full candidate without applying pacing arithmetic.
4. Compute the cumulative pacing cap when eligible; otherwise use
   `AmountTotal`.
5. Use `cap - AmountUsed` as the candidate remaining quota.
6. Preserve current candidate ordering and request-id idempotency.

The existing final-request tail grace must not apply while `cap < AmountTotal`.
Otherwise a small amount remaining in an intermediate release window could
admit an arbitrarily larger request. Tail grace remains unchanged when the
full monthly quota has been released and the monthly balance itself is the
limiting factor.

If no candidate can cover the pre-consume estimate, the request returns the
existing insufficient-subscription-quota response. A later API improvement may
expose `nextReleaseAt`, but it is not required for the first implementation.

## Settlement and Refund Behavior

The existing settlement and refund paths remain authoritative:

- The pre-consume transaction reserves the estimated quota.
- Final settlement records the actual delta against `AmountUsed`.
- Failed requests refund the idempotent pre-consume record.
- Negative settlement and refund deltas are never blocked by pacing.

The pacing cap is an admission cap, matching the existing monthly pre-consume
contract. If a single request consumes more than its estimate, final settlement
may move `AmountUsed` above the current pacing cap. The actual usage must still
be recorded, and subsequent requests remain blocked until the cumulative cap
catches up. Making one request mathematically unable to exceed the cap would
require maximum-cost reservation or incremental streaming reservation and is
outside this change.

## Multiple Subscriptions

Each active subscription is evaluated against its own cycle, total, and
cumulative cap. Existing candidate ordering and single-subscription selection
are preserved. Quota remains additive across separate requests, but one request
is never split across multiple subscriptions to satisfy a pre-consume estimate.

## Performance and Failure Characteristics

- No additional SQL statement is required in pre-consume.
- No additional row lock is required.
- The calculation is constant-time integer arithmetic.
- No Redis dependency or cache-consistency behavior is introduced.
- All processes observe the same committed `AmountUsed` through the existing
  database transaction.
- An invalid or disabled pacing configuration falls back to the existing
  monthly-only behavior.

## Deployment

The code ships disabled by default. Each regional `velagw-platform.env` exposes
`VELAGW_SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT`, defaulting to `0`. Kustomize
injects that value into both the VelaGWSet controller and legacy LLMFleet KRO
runtime definitions. The controller propagates the normalized value to every
managed NewAPI admin and traffic Pod, so all runtime paths receive the same
`SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT` timestamp.

Rollback is configuration-only: unset the environment variable and restart the
NewAPI workloads. Existing `AmountUsed` remains valid because pacing introduces
no separate state.

The repository's `.ci/new-api.yml` workflow builds and pushes the NewAPI image
but does not pin it into a Fleet. Rollout order is therefore explicit:

1. Build the NewAPI image and roll its digest through the existing Release
   Campaign while the regional effective-at value remains `0`.
2. After every target Set runs the new image, set one fixed Unix timestamp in
   the regional `velagw-platform.env` and publish the GitOps change.
3. Confirm the controller has reconciled both admin and traffic Deployments
   with the same timestamp before treating pacing as active.

## Verification

Deterministic tests must cover:

- 28, 29, 30, and 31 day cycles.
- A partial first monthly cycle shorter than 30 days.
- A final partial cycle that uses `EndTime` when `NextResetTime == 0`.
- Seven-day boundaries immediately before and after release.
- Exact final-window tail and rounding release.
- Carry-forward when an earlier window is partially or entirely unused.
- Rejection after the current cumulative cap is consumed.
- Tail grace disabled for an intermediate pacing cap.
- Tail grace preserved after the full monthly quota is released.
- Existing-cycle exemption before `effectiveAt`.
- Activation after the next monthly reset.
- New subscriptions created after `effectiveAt`.
- Multiple active subscriptions and candidate ordering.
- Concurrent pre-consume preserving the cap through existing row locking.
- Idempotent retry and refund behavior.
- Positive settlement over the current pacing cap being recorded and blocking
  subsequent admission.
- Unlimited subscriptions preserving their existing immediate full-candidate
  branch without entering pacing arithmetic.
- Non-monthly plans remaining unchanged.

The targeted model and service tests must pass under SQLite. The full NewAPI Go
test suite must also pass before submission.
