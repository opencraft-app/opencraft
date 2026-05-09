# Trade Agent Guide

`trade` 服务承载 jifei 计费协议适配 + 新购链路（询价 / 下单 / 生成支付 url / 接 jifei 回调 checkCreate / createResource / 反向调 ctl 完成发货）。

## 设计稿真源

`/root/project/mono/.tmp/trade-purchase-flow-design.md`（§10 共 41 题已拍板：Q10~Q15 / Q20~Q39 / Q40~Q51 共 30 题 + 2026-05-08 拍板 Q52~Q60 共 9 题 + Q61 抢占式幂等漏洞补丁 + Q62 checkCreate 幂等纠偏，合计 41 题）。

## 关键架构约定（与设计稿严格对齐）

- **trade_flow.flow_type 枚举**（Q62 收敛）：本期仅 1 类 `create_resource`；checkCreate 完全不写 trade_flow（每次独立实时校验、无幂等）
- **trade_flow.status 三态**（Q61 抢占式幂等）：`in_progress` / `completed` / `failed`
- **jifei 回调统一 endpoint**（Q60）：`POST /trade/jifei/callback`，按 `interfaceName` 三段式 `lightvela.<sub_product>.<interface>` 路由
- **PDF framework 双层出参**（Q58）：`{returnCode, returnValue, componentName, version, timestamp, returnMessage, data}`，由出口中间件统一包装
- **同步发货模式**（Q59）：5s 总超时硬约束，trade→ctl 4s + ctl→ai-gateway 3s
- **不写 trade_pass / trade_pass_quota / trade_plan 业务表**（Q14 / Q15 / Q27）：trade 只持有 jifei 协议层流水（trade_order / trade_flow / trade_bundle_definition 三张表）；pass 业务字段 owner = ctl/pass

## 已落地能力快查

### 内部 RPC 路由（被 ctl 调用）

| 端点 | 用途 | 入参核心字段 | 出参核心字段 | 鉴权 |
|---|---|---|---|---|
| `POST /internal/trade/inquiry/batch` | 批量询价（DescribeBundles 询价回填） | `external_user_id` + `bundle_ids[]` | 价格列表 | Bearer (TRADE_INTERNAL_TOKEN) |
| `POST /internal/trade/orders` | jifei 下单（两步式中第 1 步） | `external_user_id` + `bundle_id` + `period` + `time_unit` + `pay_mode` | `deal_name` + `big_order_id` | Bearer |
| `POST /internal/trade/orders/place-and-pay` | jifei 下单+支付一体化（**迭代 8B-1.5 联调测试用**） | 同上 | 同上（`pay_url` / `expire_at` 永空） | Bearer |
| `POST /internal/trade/orders/{dealName}/pay-url` | 生成支付 url | path: `dealName` | `pay_url` + `expire_at` | Bearer |

### 关键设计要点（迭代 8 系列）

- **shadow 反查 binding**（Q12 / Q30）：trade 是 shadow 的唯一调用方，所有 (uin/appId) 的换算由 trade 内部 `internal/shadowclient` 完成，调 ctl 内部 RPC 时只透传 `external_user_id`；本期不引入 cache（pre-MVP 阶段，QPS 极低）。
- **jifei 一体化接口 `qcloud.Deal.generateDealsAndPay`**（迭代 8B-1.5）：协议字段以 PDF §1 为准（PascalCase + `AppID:int` + `AutoVoucher:*int` 三态指针），**不参考 shadow 仓的两步式 `generateDeals + payDealsNew`** —— shadow 走的是"已有大订单后补支付"通道，与本期"下单并支付一体化"是 jifei 协议中的两个不同接口。落点：`trade/internal/jifeiclient/generatedealsandpay.go` + `trade/internal/logic/placeorder/service.go::PlaceOrderAndPay`。
- **GeneratePayURL mock 兜底**（迭代 8B-1.5）：`POST /internal/trade/orders/{dealName}/pay-url` 在 jifei "生成支付 url" SDK 接入完成前，缓存未命中时直接返 `https://buy.cloud.tencent.com/lighthouse/mock?dealName=<dealName>&token=mock`，便于 ctl/pass 联调；不再返 `ErrPayURLUnavailable`。
- **PlaceOrderAndPay 与 PlaceOrder 的状态机差异**：PlaceOrder 落 trade_order `status='pending_pay'`（等待用户跳支付页）；PlaceOrderAndPay 落 `status='paid_pending_provision'`（一次调用即支付完成、等待 jifei createResource 回调发货）。
- **fixedRegionID=47 / fixedZoneID=470004 / scenePurchase**：Lighthouse SaaS 场景下 jifei 协议入参兜底常量，不暴露给 ctl。

## 发布模型

- source-facing:
  - `trade/k8s/base/`（待迭代 9）
  - `trade/k8s/overlays/<env>/`（待迭代 9）
- deploy-facing:
  - `argocd/services/trade/<env>/`（待迭代 9）
  - `argocd/apps/<env>/trade.yaml`（待迭代 9）

正式发布只认 `Argo CD`。

## 命令

镜像构建（待迭代 9 完成 k8s 后启用）：

```bash
python3 .ci/runtime/commands/build_release_image.py --service trade --env <env> --tag <tag>
```

DB migration：

```bash
trade-migrate  # 读 TRADE_MYSQL_DSN 环境变量
```

## 约束

- `generated/` 一律不提交 Git（本服务暂不使用 oapi-codegen，无 generated 产物）
- 不要把 migration / seed 塞回应用启动路径（与 payment / subscription 一致）
- jifei 协议层的 SignKey / 中转机出口 IP 配置走 K8s Secret + envFrom（详见 §3.2 配置清单）

## 实施进度

参考 `/root/project/mono/.tmp/trade-implementation-plan.md`：

- [x] **迭代 1** — 设计稿章节落地清理 + trade 服务骨架（目录搭建、main.go、config、store、三表 migration、httpapi 空壳）
- [x] **迭代 2** — ctl 仓 reverse RPC 暴露（GetBundleByID / ListPassesByUser 互斥占用查询 / CompletePass + trade `internal/ctlclient/` 封装；详见 `.tmp/trade-implementation-plan.md` 迭代 2 完成状态 + `.tmp/trade-purchase-flow-design.md` Q66 修订 + Q69 拍板）
- [x] **迭代 3** — jifei CGW 协议适配层（出向：jifeiclient + bundledef DAO + jifei 适配层 共 52 测试 PASS；自决 Q67 PascalCase 最小字段集 + Q68 三层错误模型；详见 `.tmp/trade-implementation-plan.md` 迭代 3 完成状态 + `.tmp/trade-purchase-flow-design.md` Q67 / Q68 拍板）
- [x] **迭代 4** — jifei 回调入向 dispatcher（统一 endpoint `POST /trade/jifei/callback` + 三段式 interfaceName 路由 + PDF framework 双层入/出参 + Q56 退款响应 builder + 迭代 5/6 stub 占位 + 35 个测试 PASS / 0 lint error；详见 `.tmp/trade-implementation-plan.md` 迭代 4 完成状态 + 设计稿 Q53/Q56/Q57/Q58/Q60 拍板）
- [x] **迭代 5** — checkCreate handler（Q62）
- [x] **迭代 6** — createResource handler（Q61 抢占式幂等）
- [x] **迭代 7** — trade_flow reconcile worker
- [x] **迭代 8A** — inquiry & placeorder logic + 内部 RPC API（`POST /internal/trade/inquiry/batch` + `POST /internal/trade/orders` + `POST /internal/trade/orders/{dealName}/pay-url`；落点 `internal/logic/inquiry` + `internal/logic/placeorder` + `internal/httpapi/internalapi`）
- [x] **迭代 8B** — shadow client integration（`internal/shadowclient` 反查 binding，trade 是 shadow 的唯一调用方，Q12 / Q30 拍板）
- [x] **迭代 8B-1.5** — jifei 一体化下单+支付（`POST /internal/trade/orders/place-and-pay`）+ GeneratePayURL mock 兜底（联调测试链路用，配合 ctl `CreatePassOrderAndPay` 触发 jifei 计费回调全链路 e2e）
- [ ] **迭代 8C** — DescribeBundles 询价集成 + ctl/pass CreatePass 入口对接（部分由 ctl billing-integration 分支已实现，trade 侧待联调收尾）
- [ ] **迭代 9** — k8s 部署清单
- [ ] **迭代 10** — 联调 + 上线
