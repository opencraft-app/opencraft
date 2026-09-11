# Credit Auth Code Design

## Goal

Make the Credit package checkout flow match the Pass checkout flow when the
payment bridge page has no LightVela session. A successful package order
issues a short-lived, one-time `auth_code`; the bridge page can exchange that
ticket for the bound user identity while requesting the existing order's
payment URL.

## Scope

- Add `auth_code` issuance to `POST /v1/credit/packages/order`.
- Add optional `auth_code` authentication to
  `POST /v1/credit/packages/order-url`.
- Allow only that exact Credit route to reach Credit without a gateway
  session.
- Add Redis runtime wiring for Beijing 7 and Beijing sandbox.
- Update Credit service and frontend integration documentation.

The Trade payment URL contract and its existing order owner and
`credit_package` resource-type checks remain unchanged.

## Architecture

Credit owns a small `internal/authcode` package rather than importing CTL.
The package exposes a `Store` interface and a Redis implementation. This keeps
Credit independently deployable while preserving the proven Pass semantics.

The API process receives the store as an explicit router dependency. Credit
lifecycle and usage workers continue to run without Redis because only
`cmd/credit` validates and initializes the auth-code Redis connection.

## Ticket Contract

The Redis value contains:

- `user_id`: the authenticated LightVela user that created the order.
- `deal_name`: the single Trade deal returned by that order operation.
- `issued_at`: Unix seconds for operational diagnosis.

Tickets use UUID v4 values and Redis keys with the
`credit:auth_code:<uuid>` prefix. The default TTL is 10 minutes. Consumption
uses one Lua operation that performs `GET` followed by `DEL`, ensuring only
one caller can receive a ticket across multiple Credit pods.

The ticket is consumed before its `deal_name` is compared the request. A
mismatched request therefore burns the ticket, matching the Pass behavior and
preventing probing with the same credential.

## Order Flow

After Trade returns a non-empty `dealName`, Credit asks the auth-code store to
issue a ticket bound to the trusted `X-User-Id` and that deal. The JSON order
response retains the existing `bigOrderId` and `dealName` fields and adds
`auth_code`.

Ticket issuance is fail-soft, matching Pass: a Trade order that was already
created remains a successful order response if Redis is temporarily
unavailable. In that case Credit logs the issuance failure and returns an
empty `auth_code`, allowing the authenticated checkout path to remain usable.

An empty Trade `dealName` is an invalid upstream success response and Credit
returns a gateway error rather than issuing an unbound ticket.

## Payment URL Authentication

Credit decodes the request body before resolving identity because
`auth_code` and `deal_name` participate in authentication.

Identity resolution follows this order:

1. If the trusted `X-User-Id` header exists, use it and do not consume the
   supplied `auth_code`.
2. Otherwise, if `auth_code` exists, consume it atomically and require the
   ticket's `deal_name` to equal the request's `deal_name`.
3. If neither credential exists, reject the request.

After identity resolution, Credit calls the existing Trade payment URL API
with the resolved user and `expected_resource_type=credit_package`. Existing
Trade behavior remains authoritative: missing orders, wrong owners, and wrong
resource types are all exposed by Credit as `404 order not found`.

## Errors

| Condition | HTTP status | Behavior |
|---|---:|---|
| No session and no `auth_code` | 401 | Reject without calling Trade |
| Unknown, expired, or consumed ticket | 401 | Reject without calling Trade |
| Ticket `deal_name` mismatch | 403 | Reject; ticket remains consumed |
| Redis consumption infrastructure error | 500 | Reject without exposing Redis details |
| Trade order missing, wrong owner, or wrong resource type | 404 | Preserve existing response |
| Redis issuance failure after order creation | 200 | Return the order with empty `auth_code` |

## Configuration And Deployment

Credit configuration adds:

- `CREDIT_REDIS_ADDR`: Redis `host:port`, required by the API process.
- `CREDIT_REDIS_PASSWORD`: optional at the parser level for local Redis, set
  in managed environments.
- `CREDIT_REDIS_DB`: integer database index, default `0`.
- `CREDIT_AUTH_CODE_TTL`: Go duration, default `10m`.

Beijing 7 reuses the existing namespace-local Redis service and references
the existing playground Redis password Secret rather than copying plaintext.
Beijing sandbox points Credit at the environment Redis and stores the password
in Credit's SSM-backed encrypted runtime Secret.

Both Service Gateway configurations keep the Credit route authenticated with
session auth, but add an `optional_auth_allow` rule only for:

```text
POST /v1/credit/packages/order-url
```

Requests with a valid session still receive `X-User-Id`; requests without a
session reach Credit with identity headers cleared and must present a valid
ticket.

## Verification

Unit tests cover:

- Issue and consume with the bound fields intact.
- Ten-minute TTL and expiry.
- Atomic double-consume behavior.
- Authenticated requests taking precedence without consuming a ticket.
- Anonymous payment URL success through a matching ticket.
- Missing, expired, replayed, and mismatched tickets.
- Redis issuance and consumption failures.
- Preservation of Trade's existing owner and resource-type `404` behavior.
- Exact Service Gateway optional-auth policy in Beijing 7 and Beijing
  sandbox.

Beijing 7 integration verifies:

1. An authenticated order returns a non-empty `auth_code`.
2. A request without session headers can exchange that ticket for the payment
   URL.
3. Reusing the same ticket returns `401`.
4. A ticket cannot be used for another deal.
5. Existing authenticated `order-url` requests continue to work.
