# International Shadow Billing Retry Design

## Goal

Before international-site inquiry and order placement, recover a user shadow
binding whose account registration succeeded but billing-account opening
failed. Only `billing_account_open_failed` is retryable by this flow.

Inquiry remains available when the retry still fails by using the registered
user shadow UIN and AppID. Order placement remains fail-closed and must not call
billing order APIs until the binding becomes active.

## Scope

- Applies only when Trade runs with `site_kind=intl`.
- Covers new-purchase inquiry and order placement.
- Does not retry shadow registration failures, missing bindings, disabled
  bindings, basic-auth failures, or other binding errors.
- Does not use a fixed inquiry fallback identity.
- Does not add a scheduled reconciler or background worker.

## Auth Internal Contract

Auth exposes internal-token-protected operations for Trade:

1. Read the complete binding state by `external_user_id`, including inactive
   records and `last_error_code`.
2. Retry billing-account opening by `external_user_id`.

The retry operation enforces the eligibility check server-side. It reuses the
existing billing-account opening path only when all conditions hold:

- binding status is `failed`;
- `last_error_code` is `billing_account_open_failed`;
- the registered UIN and AppID are present.

For every other state it returns the current state without registering a new
account and without invoking the billing opening API. The response always
contains the resulting binding state when a binding exists, including the
registered identity after an unsuccessful retry.

## Trade Resolution Flow

Trade extends its shadow client with state lookup and billing-open retry
operations. Inquiry and place-order share a resolver that runs before their
existing billing calls:

1. Resolve the active binding using the current endpoint.
2. If it is active, use it unchanged.
3. If active lookup reports not found, read the complete binding state.
4. Only when the state is `failed/billing_account_open_failed`, call the Auth
   retry operation once.
5. Return both the registered identity and the post-retry state to the caller.

No retry is attempted for any other state. State-lookup network,
authentication, and invalid-response errors remain infrastructure errors and
are not reclassified as an eligible billing-opening failure.

## Inquiry Behavior

When billing retry succeeds, inquiry uses the now-active user binding. When the
retry still returns `billing_account_open_failed`, inquiry uses that same
user's registered UIN, owner UIN, and AppID and continues through the existing
GetPrice path.

If the failed binding lacks a complete registered identity, inquiry preserves
the existing binding-not-found/error behavior. Existing fixed-account inquiry
fallback behavior is not used by this recovery path.

## Order Behavior

Order placement requires an active binding. If billing retry remains failed,
Trade returns a typed `BillingAccountOpenFailed` business error before calling
the billing place-order API. The HTTP layer maps it to a stable non-5xx business
response, and CTL maps it to `PASS_BILLING_ACCOUNT_OPEN_FAILED`, so callers can
distinguish it from an unregistered shadow account and generic system errors.

## Concurrency And Idempotency

Auth remains the authority for retry eligibility. Concurrent Trade requests may
reach the retry endpoint, but all use the same registered UIN and the idempotent
`DescribeBillingAccountInner(IsAutoOpenAccount=1)` operation. No request can
re-register the shadow account through this recovery endpoint.

## Tests

- Auth service tests prove only `billing_account_open_failed` invokes retry and
  all other states leave billing untouched.
- Auth HTTP tests cover internal-token authentication, state lookup, successful
  retry, and failed retry responses.
- Trade shadow-client tests cover state/retry response decoding and typed errors.
- Inquiry tests prove a failed retry still calls GetPrice with the user's UIN.
- Place-order tests prove a failed retry returns
  `BillingAccountOpenFailed` and never calls the billing order API.
- Existing active-binding, missing-binding, and domestic-site tests remain
  unchanged and passing.
