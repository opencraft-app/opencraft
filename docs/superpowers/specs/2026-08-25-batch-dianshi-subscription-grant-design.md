# Batch Dianshi Subscription Grant Design

## Goal

Provide a one-off batch tool that accepts LightVela user IDs and explicit Dianshi campaign parameters, ensures every user has an international shadow account with billing account opening attempted, and grants the requested subscription through Dianshi `do_goods_and_pay`.

Campaign activity ID, product ID, time-span unit, and API secret are request-scoped inputs. The grant flow does not read or mutate `trade_bundle_activity`.

## Constraints

- The batch tool must not require a user login token.
- All new service endpoints are internal-token protected.
- Campaign parameters exist only in the batch process, internal request chain, and effective order metadata.
- Existing user inquiry, purchase, and domestic-site behavior must remain unchanged.
- A repeated batch run must not create a second active Pass or a second Dianshi order for the campaign product.
- One user's failure must not stop the remaining users.
- The campaign API secret must be read from `DIANSHI_ACTIVITY_SECRET_KEY`, must not appear in command arguments, logs, persistence, or responses, and must be rejected when empty.

## Architecture

The flow is split across the services that own each invariant:

1. Auth owns user lookup, verified-email validation, shadow-account binding, and billing account opening.
2. CTL owns Pass eligibility and subscription provisioning input.
3. Trade owns campaign participation, order idempotency, order persistence, and Dianshi calls. The dedicated grant path receives its campaign configuration explicitly.
4. A Python script orchestrates Auth followed by CTL for each input user and emits a machine-readable result.

The script never reads databases directly. It reads the Dianshi API secret from its environment and sends it through the internal-token-protected CTL and Trade requests. CTL treats it as an opaque field. Trade uses it only to calculate `check_sum` and never persists or returns it.

## Internal APIs

### Auth: register or retry by user ID

`POST /internal/shadow/binding/register-or-retry`

Request:

```json
{"external_user_id":"usr_xxx"}
```

Behavior:

- Authenticate with `X-Internal-Token` using the existing internal-token middleware.
- Load the Auth user by ID.
- Use the phone and verified email from the user record. An unverified or missing email is rejected for international shadow-account registration.
- Call the same `BindShadowAccount` operation used by the user-facing retry endpoint. This may create a missing binding, retry registration, and attempt billing account opening.
- Return the resulting binding state without exposing shadow-account credentials.

The endpoint is idempotent: an already active binding returns success, while an in-progress or failed binding returns its current state and error metadata.

### CTL: grant a subscription

`POST /internal/ctl/subscriptions/dianshi/grant`

Request:

```json
{
  "external_user_id":"usr_xxx",
  "bundle_id":"bundle_launch_ai_01",
  "activity_id":165523570799387,
  "act_id":142163399386388,
  "time_span_unit":"1m",
  "secret_key":"request-scoped secret"
}
```

Behavior:

- Authenticate with the existing internal service token.
- Require an explicit bundle ID, positive activity and product IDs, a valid time-span unit, and a non-empty secret.
- Reuse CTL's normal Pass preparation logic so bundle state, capacity, and user ownership rules stay consistent.
- Parse `time_span_unit` into the Pass `period` and `time_unit`; for this campaign `1m` becomes `period=1`, `time_unit=m`. Use `goods_num=1` and the normal zero-price Dianshi pay mode.
- If the user already has an active Pass, return `skipped` as an idempotent success.
- Otherwise call Trade's dedicated grant endpoint and return `granted`, `reused`, or `skipped` with the deal identifiers.

### Trade: place and pay a campaign grant

`POST /internal/trade/dianshi/subscriptions/grant`

The request contains CTL's prepared order fields plus `activityId`, `actId`, `timeSpanUnit`, and `secretKey`.

Behavior:

- Validate the active shadow binding, online CTL bundle, Trade bundle definition, and all explicit campaign fields.
- Do not call `GetBundleActivityByBundleID` or `ActivityResolver.ResolveForPlaceOrder` in this dedicated grant path.
- Build an effective in-memory campaign mapping from the request. Use a fixed one-hour reusable-order window because order expiry is an internal idempotency policy, not a campaign parameter.
- Query `trade_user_activity_participation` directly with the resolved UIN and requested activity ID. Treat an existing participation as a successful skip, matching the database's `(uin, activity_id)` uniqueness contract.
- Check reusable orders using user, activity, bundle, and overridden product ID.
- Call the existing `placeOrderDianshiAndPay` implementation with the copied mapping.
- Persist `trade_order.activity_id` and `trade_order.act_id` using the effective mapping.

The ordinary `/internal/trade/dianshi/orders/place-and-pay` endpoint remains unchanged and cannot accept an override.

## Callback Contract

Dianshi may synchronously invoke `createResource` before Trade persists `trade_order`, so callback processing cannot depend on an order lookup.

For grant orders, Trade adds `dianshiActId` to `preference_param`. The callback participation writer resolves fields in this order:

- `activity_id`: request-scoped order metadata `dianshi_activity_id`, with the existing callback billing activity ID fallback.
- `act_id`: `callback.goodsDetail.dianshiActId`, then `callback.goodsDetail.dianshi_act_id`, then request-scoped order metadata.

The writer validates positive numeric values. The pointstone callback carries the request-scoped IDs in `goodsDetail`, so callback handling does not need the campaign mapping row even when the callback arrives before local order persistence.

## Idempotency

Idempotency is enforced at three levels:

- Auth returns an existing active shadow binding.
- CTL treats an existing active Pass as `skipped`.
- Trade reuses an existing campaign order using user ID, activity ID, bundle ID, and effective product ID; any existing participation in that activity is also a successful skip because the participation table permits one row per user and activity.

The existing reusable-order query is extended with product ID for this grant path so an unrelated order for the same activity and bundle cannot suppress the campaign grant.

## Batch Script

`scripts/grant_dianshi_subscriptions.py` accepts a UTF-8 text file with one user ID per line. Blank lines and `#` comments are ignored, duplicate IDs are removed while preserving order, and malformed IDs are reported without making requests.

Configuration is supplied through arguments or environment variables:

- Auth internal base URL
- CTL internal base URL
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- required bundle ID
- required activity ID
- required product ID
- required pointstone time-span unit such as `1m`
- required campaign API secret from `DIANSHI_ACTIVITY_SECRET_KEY`

For each user, the script:

1. Calls Auth register-or-retry.
2. Polls the existing internal binding-state endpoint until active, terminal failure, or timeout.
3. Calls CTL grant only after the binding is active.
4. Writes one JSON line containing the user ID, phase, status, and non-secret error summary.

Processing continues after per-user errors. The process exits nonzero if any user failed and zero when every user was granted, reused, or skipped.

## Error Handling

- Missing user, missing verified email, terminal shadow registration failure, or billing account opening failure: report the Auth phase and do not call CTL.
- Existing active Pass or campaign participation: successful skip.
- Invalid bundle/activity/product/time-span parameters or missing secret: reject before any external call.
- Dianshi or persistence error: return a structured Trade error through CTL; the script records it and continues.
- Timeout while waiting for Auth: mark the user failed without guessing whether registration completed.

## Testing

- Auth service and HTTP tests cover missing binding creation, verified-email enforcement, active idempotency, and internal authentication.
- CTL tests cover grant preparation, active-Pass skip, time-span parsing, and propagation of all campaign fields.
- Trade tests prove the dedicated grant path never resolves `trade_bundle_activity`, preserves participation and reusable-order idempotency, sends explicit campaign fields, persists non-secret order metadata, and never exposes the secret.
- Script tests use an HTTP test server to cover parsing, Auth polling, success/skip/failure output, continuation, and exit status.
- Existing Auth, CTL, and Trade targeted test suites must remain green.
