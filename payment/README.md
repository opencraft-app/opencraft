# payment

`payment` 是一个很小的订阅落地服务，位于 `service-gateway` 后面，对外只暴露 `POST /payment`。

它不暴露 `ai-gateway` 的内部 `plan_id`，而是接收业务层 `code/tier`，再按本地映射把它转成 `plan_id`，随后调用 `ai-gateway` 管理接口：

- 先按 `user_id` 查找 `ai-gateway` 用户
- 再调用 `POST /api/admin/users/{id}/subscriptions`

## API

### `POST /payment`

请求头：

- `X-Lightclaw-User-ID`
  由 `service-gateway` 在认证后注入，表示外部用户 ID

请求体：

```json
{
  "code": "free"
}
```

也兼容：

```json
{
  "tier": "free"
}
```

成功返回：

```json
{
  "code": "free",
  "user_id": "usr_xxx",
  "subscription": {
    "id": "sub_xxx",
    "user_id": "internal-user-id",
    "plan_id": "plan-id",
    "status": "active"
  }
}
```

## Config

环境变量：

- `PAYMENT_ADDR`
- `PAYMENT_ALLOWED_ORIGINS`
- `PAYMENT_PLAN_MAPPINGS_JSON`
- `AI_GATEWAY_BASE_URL`
- `AI_GATEWAY_ADMIN_TOKEN`

推荐的映射格式：

```json
{
  "free": "31caf618-152e-4eda-9680-87c3191487c3",
  "lite": "492a8de6-1e13-4069-a4b0-8ff9e69bf884",
  "pro": "f51ee2c5-1a76-4aa4-b699-e8bc2339d5c9"
}
```
