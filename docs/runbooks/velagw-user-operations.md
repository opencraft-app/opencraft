# VelaGW 单用户迁移与额度重置

本文只覆盖单用户运维。两个脚本均默认执行只读预检，正式写操作要求显式传入
`--execute`，并用 `--confirm-user-id` 再次确认目标用户。

脚本不会把 Token 写入参数、日志或输出。凭据只能通过环境变量提供。

## 迁移运行中的旧网关 Bot

`scripts/migrate_user_to_velagw.py` 调用 CTL 内部单实例迁移接口。服务端按以下顺序执行：

`POST /internal/instances/{instance_id}/gateway/migrate`

1. 验证用户、实例归属、Running 状态和有效 Pass。
2. 确认当前归属为旧 `ai_gateway`。
3. 在 VelaGW 创建或复用用户及原购买周期权益，并签发新 Key。
4. 在现有 Sandbox 中保存新的平台 Provider，切换默认模型并重启 Hermes Gateway。
5. 仅在 Hermes 配置成功后持久化实例的新 Key ID。
6. 撤销旧 ai-gateway Key；撤销失败时迁移保持成功，但脚本返回退出码 `2`，要求人工跟进。

续费订单不会触发该迁移。续费会继续使用 `user_subscription_gateway` 已记录的网关。

先执行预检：

```bash
export CTL_INTERNAL_BASE_URL='http://ctl-api.ctl.svc.cluster.local:8080'
export LIGHTCLAW_INTERNAL_SERVICE_TOKEN='...'

python3 scripts/migrate_user_to_velagw.py \
  --user-id usr_example \
  --instance-id ins-example
```

确认预检返回的 `user_id`、`instance_id`、`previous_gateway=ai_gateway` 和
`target_gateway=llm_gateway` 后执行：

```bash
python3 scripts/migrate_user_to_velagw.py \
  --user-id usr_example \
  --instance-id ins-example \
  --execute \
  --confirm-user-id usr_example
```

迁移接口只接受已配置的内部 Bearer Token，不能通过未配置 Token 的 fail-open 模式调用。
如果 Hermes 配置失败，实例 Key 不会被替换，旧 Key 也不会被撤销。

## 重置单用户模型额度

`scripts/reset_velagw_user_quota.py` 先从 VelaGW 控制面解析用户的 Set、上游用户和业务
Plan，再通过对应 Set 的 new-api 管理接口重置额度。

Dashboard 使用的 CTL 包装入口为：

`POST /internal/users/{user_id}/gateway/quota/reset`

脚本要求同时满足：

- 用户只有一个 VelaGW binding；
- 业务 Plan 在该 Set 只有一个 ready 映射；
- 上游用户只有一个 active subscription；
- active subscription 与目标 Plan 唯一匹配。

脚本固定发送 `advance_reset_time=false`。写入后再次读取订阅，确认：

- `amount_used=0`；
- subscription ID 未变化；
- `next_reset_time` 未变化；
- `end_time` 未变化。

先执行预检：

```bash
export VELAGW_ADMIN_BASE_URL='https://token-admin.example.com'
export VELAGW_ADMIN_TOKEN='...'

python3 scripts/reset_velagw_user_quota.py --user-id usr_example
```

正式重置：

```bash
python3 scripts/reset_velagw_user_quota.py \
  --user-id usr_example \
  --execute \
  --confirm-user-id usr_example
```

不要使用 new-api 的 Plan 全量重置接口。该接口会影响同一 Plan 下的其他用户。

## 批量只读预检

需要检查一组用户时，使用 `scripts/dry_run_velagw_user_quotas.py`。该脚本没有写入参数，
内部只执行 GET，并为每个用户输出一行 JSON；单个用户无绑定或无 active subscription
不会中断后续用户。

```bash
python3 scripts/dry_run_velagw_user_quotas.py users.txt

# 也可以从标准输入读取
printf '%s\n' usr_example_1 usr_example_2 | \
  python3 scripts/dry_run_velagw_user_quotas.py -
```

`status=ready` 仅表示该用户满足单用户重置的全部前置条件，不会自动执行重置。

国内存量用户可能仍归属旧 ai-gateway。为批量预检脚本同时提供旧网关内网地址和内部
Token 后，VelaGW binding 返回 404 时会自动执行旧网关 GET 探测：

```bash
export AI_GATEWAY_INTERNAL_BASE_URL='http://gateway-internal.ai-gateway.svc.cluster.local'
export AI_GATEWAY_INTERNAL_SERVICE_TOKEN='...'

python3 scripts/dry_run_velagw_user_quotas.py users.txt
```

旧网关探测结果使用 `status=legacy_active` 并展示当前 `token_balance`。该 fallback 仍然
只有读取能力，不会修改旧网关订阅，也不会自动迁移用户。

## 运营 Dashboard

`gateway-dashboard` 的 `CTL Bots` 页面提供两个用户级操作：

- `迁移到 VelaGW`：调用 CTL 单实例迁移 API；用户存在多个非终态 Bot 时拒绝执行。
- `重置 VelaGW 额度`：调用 CTL 对 VelaGW 单用户单 Plan reset 的包装接口。

两项操作都会先执行 dry-run、展示目标状态，并要求运营人员输入完整用户 ID 二次确认。
Dashboard BFF 仅对这两个 POST 路径注入服务端 `CTL_INTERNAL_TOKEN`；该 Token 不进入浏览器。
