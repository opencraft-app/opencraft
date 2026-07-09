# CTL Agent Rules

`ctl` 的目标发布模型已经改成：

- source-facing:
  - `ctl/k8s/base/`
  - `ctl/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/ctl/<env>/`（后续纳管时）
  - `argocd/apps/<env>/ctl.yaml`（后续纳管时）

正式发布目标只认 `Argo CD`。  
这轮先删除了 service-local 正式 `apply / release`，并建立 `shprod` skeleton；live deploy-facing wiring 仍待后续纳管。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service ctl --env <env> --tag <tag>`
- 本地开发配置渲染：
  - `ctl/scripts/render-secrets.sh`

## 构建约束

- `ctl` 必须保持为 **源码构建型镜像**：
  - `ctl/Dockerfile` 在镜像构建阶段直接编译 `main/api`、`main/service`、`main/bypass`
  - 不允许再依赖预编译的 `ctl/bin/*` 作为正式发布输入
- `make build` 只服务于本地运行 / 手工调试：
  - 正式镜像发布不应再因为漏跑 `make build` 而吃到旧二进制

## 约束

- `generated/` 是本地生成物，不提交 Git
- `ctl` 的 DB init / migration 要保留为显式能力，但不放回服务级正式发布脚本
- UTC 时间语义保持不变

---

## Pass 计费链路（billing-integration）

> **设计稿真源**：`/root/project/mono/.tmp/ctl-pass-design-update.md`（patch 建议） + `/root/project/mono/.tmp/trade-purchase-flow-design.md`（trade 主稿，含 Q10~Q69 共 60+ 题拍板）。
> **目标**：付费 pass 走 trade → jifei 计费协议 → 回调发货链路；试用 pass（`CreateTrialPass`）保持原状不变。

### 路由表

| 端点 | 调用方 | 用途 | 鉴权 |
|---|---|---|---|
| `POST /v1/passes` | 前端 | 创建试用 pass（已有，不变） | X-User-Id |
| `GET /v1/passes` | 前端 | 查询用户全部 pass（已有，不变） | X-User-Id |
| `POST /v1/passes/order` | 前端 | **付费 pass 下单** → 拿 `(deal_name, pay_url)` 跳支付页 | X-User-Id |
| `POST /v1/passes/order-and-pay` | **联调测试 / e2e**（⚠️ 现网控制台禁止暴露） | 下单+支付一体化 → 直接触发 jifei 计费回调 → 拿 `(deal_name, big_order_id)` | X-User-Id |
| `POST /admin/api/ctl/passes/order` | 后台 / 客服 | 代用户付费 pass 下单（必填 `user_id`） | admin |
| `POST /admin/api/ctl/passes/order-and-pay` | **联调测试 / e2e**（⚠️ 同上） | 后台触发一体化下单+支付 | admin |
| `GET /internal/ctl/passes?external_user_id=xxx` | trade.checkCreate | 互斥占用查询（Q66 / Q69：返回数组非空即报 `USER_HAS_ACTIVE_PASS`） | CTL_INTERNAL_TOKEN |
| `POST /internal/ctl/passes/complete` | trade.createResource 反向回调 | 落 pass + quota + 调 ai-gateway `ApplySubscription` 完成发货 | CTL_INTERNAL_TOKEN |
| `GET /internal/ctl/passes/app-ids` | trade.getAllAppIds 反查 | 按 `bundle_ids`（可空）+ 分页 (`page_no`,`page_size≤20000`) 返回去重 app_id 列表 + total | CTL_INTERNAL_TOKEN |
| `GET /internal/ctl/passes/by-app` | trade.getUserResources 反查 | 按 `app_id` + 可选 `bundle_ids` + 分页 (`page_no`,`page_size≤1000`) 返回 pass 实体列表 + total | CTL_INTERNAL_TOKEN |
| `POST /internal/ctl/passes/by-resource-ids` | trade.queryResource 反查 | body: `{app_id, pass_ids[]}` (pass_ids 1~100，POST 因 GET URL 长度限制，Q12) → pass 实体列表（命中数即数量） | CTL_INTERNAL_TOKEN |
| `POST /admin/api/ctl/passes/{passID}/refund` | 后台 / 客服 | **代退款**（ctl→trade→jifei OnlineRefund 同步退款链路；trade-pass-refund-design.md v0.5）——仅 admin（Q1=a），同步返 dealName/bigDealId | admin |

### 关键设计要点

- **trade adapter**（`pkg/adapter/trade`）：ctl 与 trade 的唯一对接层，封装三个内部端点（`PlaceOrder` / `PlaceOrderAndPay` / `GeneratePayURL`）；Bearer token 注入 + 2xx/非 2xx 分支 + 自定义错误类型 `*Error{Status, Code, Message, Endpoint}`。配置位 `AdapterConfig.Trade{BaseURL, Token, Timeout}`。
- **共享前置 `prepareCreatePassOrder()`**（`pkg/logic/pass/logic.go`）：步骤 1~4（参数校验 / bundle 在售校验 / 用户唯一 pass 校验 / 反查 shadow 拿 uin/appID / 构造 trade.PlaceOrderRequest）抽出为共享 helper，由 `CreatePassOrder` / `CreatePassOrderAndPay` 接力调不同 trade 端点。
- **CreatePassOrder vs CreatePassOrderAndPay 差异**：

  | 维度 | `CreatePassOrder`（现网） | `CreatePassOrderAndPay`（**仅测试**） |
  |---|---|---|
  | trade 端点 | PlaceOrder + GeneratePayURL（双段调用） | PlaceOrderAndPay（一体化） |
  | jifei 协议 | `qcloud.Deal.generateDeals` + 后续支付 url | `qcloud.Deal.generateDealsAndPay` |
  | 返回字段 | `(DealName, PayURL)` | `(DealName, BigOrderID)` |
  | 用户路径 | 跳支付页 → 计费回调发货 | **直接触发计费回调发货**（跳过 URL 引导） |
  | 现网定位 | 正式付费入口 | **现网控制台禁止暴露**，仅 e2e |
  | 超时 | 15s + 10s 双段 | 30s 单段 |

- **本接口不创建本地 pass**：`CreatePassOrder` / `CreatePassOrderAndPay` 都只下 jifei 订单，pass 实体的最终发货发生在回调链路 `jifei → trade.checkCreate → trade.createResource → ctl.CompletePass`（v4 收敛：路径用 `complete` 而非 `from-jifei`）。
- **互斥占用判定（Q66 / Q69 极简收敛）**：`GET /internal/ctl/passes` handler 直接复用 `Logic.DescribePasses(userID)` 返回原始数组，**handler 层不做任何状态过滤**；trade 业务层只判断 `len > 0` 即报互斥占用，不再做 active 三元判定（ExpiredTime / IsolatedTime / DeletedTime）/ 不再校验 quota / CreditAvailable 维度。
- **ctl 不调 shadow**（Q12 / Q30）：所有 (uin, appId) 换算由 trade 内部完成，ctl 调 trade 内部 RPC 时只透传 `external_user_id`。
- **ctl 库零新增表**（Q29 / Q35）：付费 pass 改动收敛在现有 `ctl.pass` 表 ALTER（仅 +1 列 `renew_flag VARCHAR(16)` 默认 `MANUAL_RENEW`）+ 新增 internal HTTP 路由 + 新增反向回调入口三件事；不建 `ctl_pass_quota` / `ctl_plan` / `pass_pending_order` 等伴生表。

### 落点速查

| 关键代码位置 | 内容 |
|---|---|
| `ctl/pkg/adapter/trade/adapter.go` | trade adapter 接口 + 实现 + DTO + `*Error` |
| `ctl/pkg/adapter/factory/adapter.go` | `TradeAdapter() trade.Adapter` 单例工厂 |
| `ctl/pkg/config/define.go` | `AdapterConfig.Trade` 配置子结构 |
| `ctl/pkg/logic/pass/logic.go` | `Logic.CreatePassOrder` / `CreatePassOrderAndPay` / `prepareCreatePassOrder` |
| `ctl/pkg/transport/pass.go` | `CreatePassOrderRequest` / `CreatePassOrderResult` / `CreatePassOrderAndPayResult` |
| `ctl/main/api/pass_handler.go` | `handleAdminPassesOrder` / `handleUserPassesOrder` / `handleAdminPassesOrderAndPay` / `handleUserPassesOrderAndPay` |
| `ctl/main/api/server.go` | mux 注册 + `normalizePath` 静态白名单（避免高基数 metric 标签） |
| `ctl/pkg/model/pass/dao.go` | trade 反查三件套 DAO：`ListDistinctAppIDsByBundleIDs` / `ListByAppIDAndBundleIDs` / `ListByAppIDAndPassIDs` |
| `ctl/pkg/logic/pass/logic.go` | trade 反查三件套 Logic：`ListPassAppIDs` / `ListPassesByAppID` / `ListPassesByResourceIDs` |
| `ctl/pkg/transport/pass.go` | trade 反查三件套 DTO：`ListPassAppIDsResponse` / `ListPassesByResourceIDsRequest` 等 + `Entity.RenewFlag` 字段 |
| `ctl/main/api/integration_test.go` | trade 反查三件套集成测试（设计稿 §4.1 对齐） |
| `ctl/pkg/logic/pass/refund.go` | `Logic.RefundPass`（ctl admin 退款入口）：不动 pass.status + 同步调 trade.RefundResource；trade-pass-refund-design.md v0.5 |
| `ctl/main/api/pass_handler.go::adminRefundPass` | POST /admin/api/ctl/passes/{passID}/refund handler（Q1=a admin-only / Q4=a body 可选 operator_uin+reason） |
| `ctl/pkg/transport/pass.go::RefundPassRequest/RefundPassResponse` | refund 接口 DTO |
| `ctl/pkg/errcode/pass.go::ErrPassNotActive / ErrPassTrialNotRefundable` | refund 业务错码（v0.5 新增 2 个） |
| `ctl/main/api/refund_route_test.go` | refund 路由级单测（8 个子测试覆盖 405/404/normalizePath/InvalidJSONBody/v1 不挂载） |

## CI 触发说明

- `ctl` 流水线的 webhook paths 监听 `ctl/**`；当只修复共享 CI runtime 但需要重跑 ctl gate 时，可用本文件承载无运行时影响的触发说明变更。
- 2026-07-09 trigger note：ticket sandbox profile 修复合入后，重跑 ctl gate 以恢复 shprod promote 链路。
- 2026-07-09 trigger note：ticket release bundle contract 临时下线后，重跑 ctl gate 以解除 ticket closure 阻塞。
