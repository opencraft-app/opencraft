# Batch Dianshi Subscription Grant Design

## Goal

Provide a one-off batch tool that accepts LightVela user IDs, ensures every user has an international shadow account with billing account opening attempted, and grants a free `bundle_launch_ai_01` subscription through Dianshi `do_goods_and_pay`.

The campaign product ID is `142123551192174`. The existing `trade_bundle_activity` row remains unchanged; its activity ID, API secret, time-span configuration, and expiry configuration remain the source of truth.

## Constraints

- The batch tool must not require a user login token.
- All new service endpoints are internal-token protected.
- The product ID override exists only in the grant request and in-memory mapping copy.
- Existing user inquiry, purchase, and domestic-site behavior must remain unchanged.
- A repeated batch run must not create a second active Pass or a second Dianshi order for the campaign product.
- One user's failure must not stop the remaining users.
- Secrets must be read from environment variables and must not be printed.

## Architecture

The flow is split across the services that own each invariant:

1. Auth owns user lookup, verified-email validation, shadow-account binding, and billing account opening.
2. CTL owns Pass eligibility and subscription provisioning input.
3. Trade owns Dianshi inventory credentials, campaign participation, order idempotency, order persistence, and Dianshi calls.
4. A Python script orchestrates Auth followed by CTL for each input user and emits a machine-readable result.

The script never reads databases directly and never copies the Dianshi secret. CTL does not receive the secret. Trade loads the active `bundle_launch_ai_01` mapping and replaces only `ActID` in an in-memory copy.

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
  "act_id":142123551192174
}
```

Behavior:

- Authenticate with the existing internal service token.
- Restrict this endpoint to an explicit bundle ID and positive product ID.
- Reuse CTL's normal Pass preparation logic so bundle state, capacity, and user ownership rules stay consistent.
- Use `period=1`, `time_unit=m`, `goods_num=1`, and the normal zero-price Dianshi pay mode for Pass creation. Trade still uses the inventory row's `time_span_unit` for the Dianshi request.
- If the user already has an active Pass, return `skipped` as an idempotent success.
- Otherwise call Trade's dedicated grant endpoint and return `granted`, `reused`, or `skipped` with the deal identifiers.

### Trade: place and pay a campaign grant

`POST /internal/trade/dianshi/subscriptions/grant`

The request contains CTL's prepared order fields plus `actId`.

Behavior:

- Validate the active shadow binding, online bundle definition, and active Dianshi inventory mapping.
- Load `trade_bundle_activity` by bundle ID and copy it in memory.
- Replace only the copied mapping's `ActID`; retain `ActivityID`, `SecretKey`, `TimeSpanUnit`, and `OrderExpiredTime` from inventory.
- Treat any existing participation for the same user and activity as a successful skip, matching the database's `(uin, activity_id)` uniqueness contract.
- Check reusable orders using user, activity, bundle, and overridden product ID.
- Call the existing `placeOrderDianshiAndPay` implementation with the copied mapping.
- Persist `trade_order.activity_id` and `trade_order.act_id` using the effective mapping.

The ordinary `/internal/trade/dianshi/orders/place-and-pay` endpoint remains unchanged and cannot accept an override.

## Callback Contract

Dianshi may synchronously invoke `createResource` before Trade persists `trade_order`, so callback processing cannot depend on an order lookup.

For grant orders, Trade adds `dianshiActId` to `preference_param`. The callback participation writer resolves fields in this order:

- `activity_id`: the inventory mapping's activity ID; `callback.billingActivityId` remains the activity-order trigger used by the existing callback contract.
- `act_id`: `callback.goodsDetail.dianshiActId`, then `callback.goodsDetail.dianshi_act_id`, then the inventory mapping's product ID.

The writer validates positive numeric values. Legacy callbacks without the new field continue to use the inventory mapping. This ensures campaign participation records use product `142123551192174` even when the callback arrives before local order persistence.

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
- bundle ID, defaulting to `bundle_launch_ai_01`
- product ID, defaulting to `142123551192174`

For each user, the script:

1. Calls Auth register-or-retry.
2. Polls the existing internal binding-state endpoint until active, terminal failure, or timeout.
3. Calls CTL grant only after the binding is active.
4. Writes one JSON line containing the user ID, phase, status, and non-secret error summary.

Processing continues after per-user errors. The process exits nonzero if any user failed and zero when every user was granted, reused, or skipped.

## Error Handling

- Missing user, missing verified email, terminal shadow registration failure, or billing account opening failure: report the Auth phase and do not call CTL.
- Existing active Pass or campaign participation: successful skip.
- Invalid bundle/product parameters: reject before any external call.
- Dianshi or persistence error: return a structured Trade error through CTL; the script records it and continues.
- Timeout while waiting for Auth: mark the user failed without guessing whether registration completed.

## Testing

- Auth service and HTTP tests cover missing binding creation, verified-email enforcement, active idempotency, and internal authentication.
- CTL tests cover grant preparation, active-Pass skip, and propagation of the fixed one-month Pass period and requested product ID.
- Trade tests cover in-memory override, unchanged inventory object, product-scoped order reuse, request `preference_param`, order persistence, and callback fallback behavior.
- Script tests use an HTTP test server to cover parsing, Auth polling, success/skip/failure output, continuation, and exit status.
- Existing Auth, CTL, and Trade targeted test suites must remain green.
