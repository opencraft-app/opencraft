# 国内站 Pass 续费接入点石 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成国内站 Pass 续费点石询价、控制台单次优惠下单和内部无限次下单并支付，同时保持国际站与原 Trade 计费续费入口不变。

**Architecture:** `trade_bundle_activity` 与参与记录以 `scene` 显式区分新购和续费。控制台续费复用现有公开询价/下单入口，在 Trade 内按 `scene=renew` 分流；内部点石续费由受信任调用方直接访问新的 Trade 内部接口。原 Trade 计费 `/orders/renew/place-and-pay` 保留，CTL 对应公网、管理端及 internal 转发路由均不提供。

**Tech Stack:** Go、Gin、MySQL migrations、`database/sql`、现有 Dianshi/Jifei client、Go tests。

**Execution Status (2026-09-23):** Tasks 1-5 已实现；Trade/CTL 全量测试、`go vet`、migration
embed、diff 检查和敏感信息扫描均已通过。Task 6 仅剩按仓库门禁确认后 commit、push 和创建 MR。

## Global Constraints

- 国内站续费活动：`activity_id=166165503931688`、`act_id=1975812517099088`。
- `preference_param` 只能包含 `regionId/resourceId/timeSpanUnit/bundleId`。
- 续费询价、`do_goods`、`do_goods_and_pay` 显式发送请求级 `preview=1`；新购请求不设置该覆盖。
- 场景值只允许 `purchase`、`renew`。
- 控制台续费每 UIN、activity、scene 只能参与一次；内部点石续费不读写参与记录。
- 国际站不接点石续费。
- 保留 `POST /internal/trade/orders/renew/place-and-pay` 的计费行为。
- 删除 CTL `/v1` 与 `/admin/api` 的续费 `order-and-pay` 分发。
- 新增接口必须 fail closed 校验内部 bearer token。

---

### Task 1: 场景化活动数据模型

**Files:**
- Create: `trade/migrations/000011_dianshi_activity_scene.up.sql`
- Create: `trade/migrations/000011_dianshi_activity_scene.down.sql`
- Modify: `trade/internal/store/activity.go`
- Modify: `trade/internal/store/activity_test.go`
- Modify: `trade/internal/store/order.go`
- Modify: `trade/internal/store/order_test.go`
- Modify: `scripts/seed_trade_shprod_dianshi_activity.sql`

**Interfaces:**
- Produce: `store.ActivityScenePurchase`, `store.ActivitySceneRenew`。
- Produce: `GetBundleActivity(ctx, bundleID, scene)`。
- Produce: `HasUserParticipated(ctx, uin, activityID, scene)`。
- Produce: scene-aware `InsertUserParticipation` 与后台筛选。
- Produce: `FindReusableDianshiOrder(..., orderType, ...)`。

- [ ] 先写 migration、DAO 和索引断言测试，验证旧接口不能表达两个 scene。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go test ./internal/store ./migrations`，确认 RED。
- [ ] 增加 scene 列、复合唯一键和带 `order_type` 的订单复用索引；存量默认 `purchase`。
- [ ] 更新领域对象、SQL、后台 DTO 所需 filter 和所有 fake，实现编译闭环。
- [ ] 更新上海 seed，显式写 `scene='purchase'`，并提供不含真实密钥的 renew seed 参数入口。
- [ ] 重跑 store/migration 测试至 GREEN。

### Task 2: 场景化 Resolver 与续费询价

**Files:**
- Modify: `trade/internal/logic/activity/resolver.go`
- Modify: `trade/internal/logic/activity/resolver_test.go`
- Modify: `trade/internal/logic/inquiry/service.go`
- Modify: `trade/internal/logic/inquiry/service_dianshi_test.go`

**Interfaces:**
- Produce: `ResolveForInquiry(ctx, scene, bundleID, uin, timeSpan, timeUnit)`。
- Produce: `ResolveForPlaceOrder(ctx, scene, bundleID, uin, timeSpan, timeUnit)`。
- Consume: `scene=purchase` for create、`scene=renew` for renew。

- [ ] 写失败测试：purchase/renew 分别查映射和参与资格、国际站续费不调用 Resolver。
- [ ] 写失败测试：国内续费未参与走点石询价，已参与/映射关闭回落 Jifei。
- [ ] 写失败测试：续费点石 `preference_param` 精确等于四个约定字段并保持顺序无关匹配。
- [ ] 实现场景化 Resolver 和 renewal quote helper。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go test ./internal/logic/activity ./internal/logic/inquiry` 至 GREEN。

### Task 3: 控制台续费 do_goods 与参与资格

**Files:**
- Modify: `trade/internal/store/activity.go`
- Modify: `trade/internal/store/order_write.go`
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`
- Modify: `trade/cmd/trade/main.go`

**Interfaces:**
- Produce: 事务方法 `CreateDianshiRenewOrderWithParticipation(ctx, order, participation)`。
- Produce: `PlaceRenewOrder` 国内首次资格走 `DianshiClient.DoGoods`。
- Preserve: 已参与、非活动、国际站继续走 Jifei。

- [ ] 写失败测试：国内首次续费调用 `do_goods`，订单为 `source=dianshi/order_type=renew/resource_id=pass_id`。
- [ ] 写失败测试：订单与 `scene=renew` 参与记录原子写入；任一失败不留本地半状态。
- [ ] 写失败测试：已参与回落 Jifei，点石失败不写参与记录，国际站不走点石。
- [ ] 实现续费点石请求、精确 preference、订单复用与事务写入。
- [ ] 更新依赖装配及所有 fake。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go test ./internal/logic/placeorder ./cmd/trade` 至 GREEN。

### Task 4: 点石续费内部 do_goods_and_pay

**Files:**
- Modify: `trade/internal/logic/placeorder/service.go`
- Modify: `trade/internal/logic/placeorder/service_dianshi_test.go`
- Modify: `trade/internal/httpapi/internalapi/handler.go`
- Modify: `trade/internal/httpapi/internalapi/handler_test.go`

**Interfaces:**
- Produce: `PlaceDianshiRenewOrderAndPay(ctx, PlaceRenewOrderRequest)`。
- Produce: `POST /internal/trade/dianshi/orders/renew/place-and-pay`。
- Preserve: `POST /internal/trade/orders/renew/place-and-pay` 继续调用 Jifei。

- [ ] 写失败测试：新接口调用 `DoGoodsAndPay`，不查询也不写参与记录。
- [ ] 写失败测试：原 Trade 计费接口仍只调用 Jifei；国际站点石接口返回 `UnsupportedSite`。
- [ ] 写失败测试：新接口无 token 返回 401，输入错误映射现有错误码。
- [ ] 参考新购点石请求/响应校验实现独立续费方法，不复用新购业务方法。
- [ ] 注册专用内部路由并保持旧路由不变。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go test ./internal/logic/placeorder ./internal/httpapi/internalapi` 至 GREEN。

### Task 5: CTL 入口收口

**Files:**
- Modify: `ctl/main/api/pass_handler.go`
- Modify: `ctl/main/api/dianshi_admin_handler.go`
- Modify: `ctl/main/api/server.go`
- Modify: `ctl/main/api/renew_route_test.go`
- Modify: `ctl/pkg/adapter/trade/adapter_dianshi_admin.go`

**Interfaces:**
- Remove: public/admin renew `order-and-pay` dispatch。
- Do not add a CTL internal forwarding route; keep only the Trade internal endpoint。

- [ ] 写失败测试：用户、后台和 CTL internal 三类续费下单并支付路径均返回 404。
- [ ] 写失败测试：管理查询透传 scene 筛选并保留参与记录 scene 字段。
- [ ] 删除 public/admin dispatch 与 metric normalization 特例，不删除底层 Jifei Trade adapter。
- [ ] 运行 `cd ctl && GOCACHE=/tmp/codex-go-cache go test ./main/api` 至 GREEN。

### Task 6: 回归、文档与交付

**Files:**
- Modify: `credit/docs/domestic-pass-renewal-dianshi-plan.md`
- Modify: `credit/docs/README.md`

- [ ] 对照设计逐项检查 DB、控制台、内部接口、兼容性和安全边界。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go test ./...`。
- [ ] 运行 `cd trade && GOCACHE=/tmp/codex-go-cache go vet ./...`。
- [ ] 运行 `cd ctl && GOCACHE=/tmp/codex-go-cache go test ./...`。
- [ ] 运行 `cd ctl && GOCACHE=/tmp/codex-go-cache go vet ./...`。
- [ ] 运行 migration embed、`git diff --check` 和敏感信息扫描相关检查。
- [ ] 展示完整 diff、测试证据、commit message 和 MR 标题，按仓库门禁取得确认。
- [ ] commit、push 到 `codex/dianshi-pass-renew`，创建目标为 `master` 的 MR；不得合并 MR。
