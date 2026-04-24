# shadow

Golang single-service scaffold for Tencent Cloud shadow-account integration.

It includes:

- shadow account SMS and registration entrypoints
- one-time `auth_code` issuing and Tencent Cloud callback verification
- domestic balance-package order creation, payment launch, and wallet credit confirmation
- free-trial order orchestration, dianshi order placement, and billing payment
- `jumpLoginByCode` payment / console redirect building
- shadow-account phone update with local rollback on cloud-side failure
- pluggable storage contract with a built-in `sqlite` implementation
- a default `fake` mode for local validation
- a Tencent Cloud provider backed by the internal `tencentcloud-sdk-go`

## Project layout

- `cmd/shadowd`: service entrypoint
- `internal/app`: dependency wiring
- `internal/platform`: Tencent Cloud account / cam / sts adapter
- `internal/billing`: free-trial dianshi / billing adapters
- `internal/shadow`: business orchestration
- `internal/httpapi`: external API and internal callback handlers
- `internal/mockcloud`: mock Tencent Cloud backend used by black-box e2e tests
- `internal/storage`: storage contract and shared models
- `internal/storage/sqlite`: SQLite-backed persistent store
- `third_party/polaris-go-v2`: local stub to make the internal SDK buildable without fetching Polaris

## Quick start

Run the service in local fake mode:

```bash
cd /Users/skipzhang/code/shadow
make build
./bin/shadowd
```

The default address is `:8080`.

Health check:

```bash
curl http://127.0.0.1:8080/healthz
```

The default storage is already SQLite. To pick a file explicitly:

```bash
cd /Users/skipzhang/code/shadow
export SHADOW_STORAGE_DRIVER=sqlite
export SHADOW_STORAGE_DSN='file:shadow.db?_pragma=busy_timeout(5000)'
make build
./bin/shadowd
```

## Local API verification

1. Send register SMS:

For mainland China, prefer `country_code: "86"` instead of `"+86"`.
The Tencent Cloud registration flow is sensitive to `CountryCode` and `Area`.

```bash
curl -i \
  -X POST http://127.0.0.1:8080/v1/shadow/register/send-sms \
  -H 'Content-Type: application/json' \
  -d '{
    "country_code": "86",
    "phone_number": "13800000000",
    "client_ip": "127.0.0.1",
    "lang": "zh"
  }'
```

2. Register a free-trial shadow account:

```bash
curl \
  -X POST http://127.0.0.1:8080/v1/shadow/register/free-trial \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "usr_00000000-0000-4000-8000-000000000001",
    "country_code": "86",
    "phone_number": "13800000000",
    "phone_verify_code": "123456",
    "org_name": "shadow-demo",
    "client_ip": "127.0.0.1",
    "client_ua": "curl"
  }'
```

Expected fields in the response:

- `user_id`
- `shadow_user_name`
- `uin`
- `owner_uin`
- `appid`
- `instance_id`
- `big_deal_id`

3. Build a payment or console redirect:

```bash
curl 'http://127.0.0.1:8080/v1/shadow/payment/redirect?user_id=usr_00000000-0000-4000-8000-000000000001&mode=renew-instance'
curl 'http://127.0.0.1:8080/v1/shadow/payment/redirect?user_id=usr_00000000-0000-4000-8000-000000000001&mode=console&console=tced'
```

Supported `mode` values:

- `create-instance`
- `renew-instance`
- `modify-instance`
- `traffic-package`
- `console`

4. Verify Tencent Cloud callback for `auth_code`:

Use the `code` query parameter from the redirect URL.
If `SHADOW_CALLBACK_TOKEN` is set, append `?token=replace-with-callback-token` or send `X-Shadow-Callback-Token`.

```bash
curl \
  -X POST 'http://127.0.0.1:8080/internal/tencentcloud/account?token=replace-with-callback-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "version": "1.0",
    "caller": "WACCOUNT",
    "componentName": "WACCOUNT",
    "eventId": "event-1",
    "timestamp": 1710000000,
    "interface": {
      "interfaceName": "qcloud.saas.checkSaaSAuthCode",
      "para": {
        "auth_code": "replace-with-code"
      }
    }
  }'
```

Call the same payload twice. The first call should return the `user_id`; the second should return an empty `user_id`, which verifies the one-time consumption behavior.

5. Verify Tencent Cloud callback for `user_id`:

```bash
curl \
  -X POST 'http://127.0.0.1:8080/internal/tencentcloud/account?token=replace-with-callback-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "version": "1.0",
    "caller": "WACCOUNT",
    "componentName": "WACCOUNT",
    "eventId": "event-2",
    "timestamp": 1710000000,
    "interface": {
      "interfaceName": "qcloud.saas.checkSaaSAccountExist",
      "para": {
        "user_id": "usr_00000000-0000-4000-8000-000000000001"
      }
    }
  }'
```

6. Update shadow-account phone number:

```bash
curl -i \
  -X POST http://127.0.0.1:8080/v1/shadow/phone/send-sms \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "usr_00000000-0000-4000-8000-000000000001",
    "country_code": "+86",
    "phone_number": "13800000099",
    "client_ip": "127.0.0.1",
    "lang": "zh"
  }'

curl -i \
  -X POST http://127.0.0.1:8080/v1/shadow/phone/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "usr_00000000-0000-4000-8000-000000000001",
    "new_country_code": "+86",
    "new_phone_number": "13800000099",
    "verify_code": "123456"
  }'
```

7. Balance-package flow:

Seed package products and billing API settings before starting the service:

```bash
export SHADOW_BILLING_API_ENDPOINT=billing.dev.tencentcloudapi.com
export SHADOW_BILLING_API_REGION=ap-guangzhou
export SHADOW_BILLING_SECRET_ID="$SHADOW_SECRET_ID"
export SHADOW_BILLING_SECRET_KEY="$SHADOW_SECRET_KEY"
export SHADOW_PAYMENT_CONFIRM_TOKEN=replace-with-internal-token
export SHADOW_PACKAGE_PRODUCTS_JSON='[
  {
    "code": "orcaterm_pro_normal",
    "display_name": "OrcaTerm Pro Normal",
    "credit_amount": 1000,
    "currency": "CNY",
    "billing_goods_category_id": 101444,
    "billing_region": "ap-guangzhou",
    "billing_zone": "ap-guangzhou-1",
    "billing_pay_mode": "1",
    "product_code": "p_orcaterm",
    "sub_product_code": "sp_orcaterm_pro",
    "billing_item_type_code": "v_orcaterm_pro",
    "billing_item_code": "sv_orcaterm_pro_normal",
    "billing_pid": 10001,
    "billing_time_unit": "m",
    "billing_time_span": 1,
    "billing_action": "purchase",
    "enabled": true
  }
]'
```

List enabled balance packages:

```bash
curl 'http://127.0.0.1:8080/v1/shadow/packages'
```

Create a package order and get payment launch data:

```bash
curl \
  -X POST http://127.0.0.1:8080/v1/shadow/package-orders \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "your-external-user-id",
    "package_code": "orcaterm_pro_normal",
    "platform": "mobile"
  }'
```

Confirm a package order after authoritative payment success:

```bash
curl \
  -X POST 'http://127.0.0.1:8080/internal/shadow/package-orders/replace-order-id/confirm?token=replace-with-internal-token'
```

Read current wallet balance:

```bash
curl 'http://127.0.0.1:8080/v1/shadow/wallet?user_id=your-external-user-id'
```

## Tests

Run unit tests:

```bash
cd /Users/skipzhang/code/shadow
go test ./...
```

Current automated coverage focuses on:

- balance-package order creation, confirmation, and wallet credit
- free-trial registration flow
- real HTTP billing request shape and paid-order recovery
- black-box e2e against a mock Tencent Cloud backend
- `jumpLoginByCode` redirect shape
- one-time `auth_code` callback semantics
- callback shared-secret enforcement
- phone-update rollback on cloud failure
- SQLite persistence across app restarts

Run just the mock-cloud black-box e2e:

```bash
cd /Users/skipzhang/code/shadow
go test ./internal/app -run TestE2E_MockCloudBackend_RegisterRedirectAndUpdatePhone
```

## Switch to real Tencent Cloud provider

The local default is `SHADOW_PROVIDER=fake`. To use the internal Tencent Cloud SDK:

```bash
export SHADOW_SECRET_ID=xxx
export SHADOW_SECRET_KEY=xxx
export SHADOW_PLATFORM=your_platform
export SHADOW_BILLING_ENDPOINT=http://billing-test.example/interfaces/interface.php
export SHADOW_DIANSHI_ENDPOINT=http://dianshi-test.example/activity_web/activity/do_goods
export SHADOW_BILLING_RECOVERY_ENDPOINT=http://shadow-recovery.internal/recover-free-trial
./scripts/start-tencent-test.sh
```

Notes:

- `SHADOW_PLATFORM` must match the platform value allocated by the Tencent Cloud SaaS tool.
- `account.test.tencentcloudapi.com` and the other Tencent Cloud test endpoints are injected by the startup script, not by config defaults.
- Set `SHADOW_BILLING_MODE=http` to enable the real dianshi / billing adapter. The startup script defaults to that mode.
- `SHADOW_FREE_TRIAL_ACTIVITY_ID` and `SHADOW_FREE_TRIAL_ACT_ID` must match the test or production goods you actually want to sell.
- The startup script compiles `./cmd/shadowd` into `./bin/shadowd` and then executes the binary.
- `third_party/polaris-go-v2` is only a build stub so the internal SDK can compile locally. This service does not enable Polaris discovery by default.

Build a Linux amd64 binary for deployment:

```bash
cd /Users/skipzhang/code/shadow
make build-linux-amd64
```

## Key environment variables

- `SHADOW_HTTP_ADDR`: HTTP listen address, default `:8080`
- `SHADOW_STORAGE_DRIVER`: currently `sqlite`, default `sqlite`
- `SHADOW_STORAGE_DSN`: SQLite DSN, default `file:shadow.db?_pragma=busy_timeout(5000)`
- `SHADOW_PROVIDER`: `fake` or `tencent`
- `SHADOW_PROVIDER`: `fake`, `mock`, or `tencent`
- `SHADOW_PLATFORM`: Tencent Cloud SaaS platform
- `SHADOW_REGION`: default `ap-guangzhou`
- `SHADOW_ACCOUNT_ENDPOINT`: no default, set explicitly or use `scripts/start-tencent-test.sh`
- `SHADOW_CAM_ENDPOINT`: no default, set explicitly or use `scripts/start-tencent-test.sh`
- `SHADOW_STS_ENDPOINT`: no default, set explicitly or use `scripts/start-tencent-test.sh`
- `SHADOW_SECRET_ID`: required when `SHADOW_PROVIDER=tencent`
- `SHADOW_SECRET_KEY`: required when `SHADOW_PROVIDER=tencent`
- `SHADOW_BILLING_MODE`: `fake` or `http`
- `SHADOW_BILLING_ENDPOINT`: required when `SHADOW_BILLING_MODE=http`
- `SHADOW_DIANSHI_ENDPOINT`: required when `SHADOW_BILLING_MODE=http`
- `SHADOW_BILLING_RECOVERY_ENDPOINT`: optional but recommended. Used to recover `100102` already-paid orders when local pending state is incomplete.
- `SHADOW_BILLING_API_ENDPOINT`: billing API endpoint for package orders, default `billing.dev.tencentcloudapi.com`
- `SHADOW_BILLING_API_REGION`: billing API region, default `ap-guangzhou`
- `SHADOW_BILLING_SECRET_ID`: optional override for billing API credentials, defaults to `SHADOW_SECRET_ID`
- `SHADOW_BILLING_SECRET_KEY`: optional override for billing API credentials, defaults to `SHADOW_SECRET_KEY`
- `SHADOW_PAYMENT_CONFIRM_TOKEN`: shared secret for the internal package-order confirmation endpoint
- `SHADOW_PACKAGE_PRODUCTS_JSON`: JSON array defining balance-package products and billing metadata
- `SHADOW_FREE_TRIAL_ACTIVITY_ID`: required when `SHADOW_BILLING_MODE=http`
- `SHADOW_FREE_TRIAL_ACT_ID`: required when `SHADOW_BILLING_MODE=http`
- `SHADOW_CALLBACK_TOKEN`: optional shared secret. If set, Tencent callback URL must include `?token=...` or send `X-Shadow-Callback-Token`.
- `SHADOW_AUTH_CODE_TTL`: default `10m`
- `SHADOW_REQUEST_TIMEOUT`: default `10s`

## Remaining gaps

- If you configure `SHADOW_CALLBACK_TOKEN`, remember to append the token to the callback URL you register in the SaaS tool.
