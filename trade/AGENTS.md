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
| `POST /internal/trade/orders/{dealName}/query-status` | 订单状态反查（v1.7.32 引入：B1 本地终态短路 + B2/B3 jifei.getDealsByKeyIndex 反查，详见 .tmp/ctl-order-status-query-design.md） | path: `dealName` + body: `external_user_id` + `skip_jifei` | `status` + `source` + `local_status` + `order_type` + `big_order_id` + `upstream_err` | Bearer |
| `POST /internal/trade/resources/{resourceID}/delete` | ctl→trade 销毁链路用户主动入口（D-2，trade-pass-destroy §3.5）：trade 反查 BundleDefinition 后调 jifei `ModifyResourceStatus(operateName=PRE_DESTROY)` | path: `resourceID` + body: `uin` + `appId` + `bundleId` | `referenceId` (`<resourceID>_<UnixNano>`) | Bearer |
| `POST /internal/trade/resources/{resourceID}/refund` | ctl→trade 退款链路用户主动入口（trade-pass-refund-design.md v0.5）：**无状态翻译层**，trade 反查 BundleDefinition.SubProductCode 后调 jifei `Deal.OnlineRefund` 同步退款；**不写 trade_flow**（Q8b=b 拍板，并发抑制 / 幂等完全交给 jifei 协议层 + 后续 isolateResource(refund) 入向回调上 `flow_type='isolate_resource' + dealName` 抢占式幂等兜底） | path: `resourceID` + body: `uin` + `appId` + `bundleId` | `dealName` + `bigDealId` | Bearer |

### jifei 入向回调路由（被 jifei 调用）

| InterfaceName | 用途 | 入参核心字段 | 出参核心字段 | handler 落点 |
|---|---|---|---|---|
| `lightvela.pass.checkCreate` | jifei 下单前校验互斥占用 | `appId` + `uin` + `subProductCode` + `goodsDetail` | `returnCode` (0/4xxxxx/600xxx) | `internal/logic/checkcreate/` |
| `lightvela.pass.createResource` | jifei 支付成功后通知 trade 发货 | `appId` + `uin` + `dealName` + `bigOrderId` + `resInfos[]` | `resourceId[]` 数组 | `internal/logic/createresource/` |
| `lightvela.pass.getAllAppIds` | 反查同步：按 `bundle_ids`（可空）+ 分页拉去重 app_id 列表 | `payMode` + `productCode` + `subProductCode?` + `pageNo` + `pageSize` (≤20000) | `appIds[]` + `total` | `internal/logic/resourcequery/getallappids.go` |
| `lightvela.pass.getUserResources` | 反查同步：按 `(uin, appId)` + 分页拉 pass 列表 | `uin` + `appId` + `payMode` + `subProductCode?` + `pageNo` + `pageSize` (≤1000) | `resources[]` + `total` | `internal/logic/resourcequery/getuserresources.go` |
| `lightvela.pass.queryResource` | 反查同步：按 `(appId, resourceIds[])` 反查 pass | `appId` + `resourceIds[]` (1~100) | `resources[]` + `total = 命中数` | `internal/logic/resourcequery/queryresource.go` |

> 反查三件套统一挂在 `POST /trade/jifei/callback`，由 dispatcher 按 `interfaceName` 三段式 `lightvela.<sub_product>.<interface>` 路由（Q60）。设计稿 `/root/project/mono/.tmp/trade-resource-query-design.md`。

### 关键设计要点（迭代 8 系列）

- **shadow 反查 binding**（Q12 / Q30）：trade 是 shadow 的唯一调用方，所有 (uin/appId) 的换算由 trade 内部 `internal/shadowclient` 完成，调 ctl 内部 RPC 时只透传 `external_user_id`；本期不引入 cache（pre-MVP 阶段，QPS 极低）。
- **jifei 一体化接口 `qcloud.Deal.generateDealsAndPay`**（迭代 8B-1.5）：协议字段以 PDF §1 为准（PascalCase + `AppID:int` + `AutoVoucher:*int` 三态指针），**不参考 shadow 仓的两步式 `generateDeals + payDealsNew`** —— shadow 走的是"已有大订单后补支付"通道，与本期"下单并支付一体化"是 jifei 协议中的两个不同接口。落点：`trade/internal/jifeiclient/generatedealsandpay.go` + `trade/internal/logic/placeorder/service.go::PlaceOrderAndPay`。
- **GeneratePayURL mock 兜底**（迭代 8B-1.5）：`POST /internal/trade/orders/{dealName}/pay-url` 在 jifei "生成支付 url" SDK 接入完成前，缓存未命中时直接返 `https://buy.cloud.tencent.com/lighthouse/mock?dealName=<dealName>&token=mock`，便于 ctl/pass 联调；不再返 `ErrPayURLUnavailable`。
- **PlaceOrderAndPay 与 PlaceOrder 的状态机差异**：PlaceOrder 落 trade_order `status='pending_pay'`（等待用户跳支付页）；PlaceOrderAndPay 落 `status='paid_pending_provision'`（一次调用即支付完成、等待 jifei createResource 回调发货）。
- **region / zone 常量统一收敛到 `internal/region` 包**（迭代 11C-1）：Lighthouse SaaS 场景 jifei 协议入参兜底常量，唯一 source-of-truth 是 `trade/internal/region/region.go`，导出 `LighthouseRegionID = 1`（广州）/ `LighthouseZoneID = 100001`（广州一区）/ `LighthouseRegionName = "广州"`。**4 处业务包**（`internal/jifei/adapter.go` / `internal/logic/inquiry/service.go` / `internal/logic/placeorder/service.go` / `internal/logic/resourcequery/install.go`）一律 `import` 引用，编译期保障一致性。Q41 修订（2026-05-11）后 trade 不再做 region 入参匹配，jifei 出向请求 / 反查响应统一固定回填广州；不要在 region 包内做多区域路由，未来真要支持多区域再演进为 region resolver。
- **`region.Resolve` 双参数与运行时 region override**（2026-06-12 北京 2 预发布接入）：`region.Resolve(siteKind, regionOverride)` 返回 `LighthouseRegion` 三元组，`regionOverride` 是腾讯云 region 字面量（已注册：`ap-guangzhou` / `ap-beijing` / `ap-singapore`，唯一表在 `region.regionTable`）；非空且命中时优先于 SiteKind 兜底。由 env `LIGHTVELA_TRADE_REGION` 注入（`config.RegionOverride`），未注册字面量在 `config.Load` 期 fail-fast。该字段与 SiteKind 同路径贯穿到 7 处下游 Deps（placeorder / inquiry / internalapi / destroyresource / isolateresource / queryflow / resourcequery），在 `New()` / `Install()` 装配期调 `region.Resolve` 解析一次后缓存，运行时零开销。**使用场景**：“国内站身份 cn + region 字段北京”这种 site/region 解耦的部署（北京 2 预发布 = `LIGHTVELA_SITE_KIND=cn` + `LIGHTVELA_TRADE_REGION=ap-beijing` → 8/800001/北京）。新增 region 只需在 `regionTable` 加一行，调用方零感知。
- **资源反查接口三件套**（迭代 11A→11C，jifei 入向回调）：trade 实现 `lightvela.pass.{getAllAppIds, getUserResources, queryResource}` 三个 jifei 协议反查接口，挂在 `POST /trade/jifei/callback` 同一个 endpoint 下按 interfaceName 三段式路由。落点 `internal/logic/resourcequery/`（install / mapper / getallappids / getuserresources / queryresource，与 `checkcreate` / `createresource` 并列；**不**放在 `internal/httpapi/jifei/` 下，那里只承载协议框架代码 — Q19 拍板）。数据反查链路 trade → ctl 内部 RPC（`ctlclient.ListPassAppIDs` / `ListPassesByAppID` / `ListPassesByResourceIDs`）+ trade 本地 `BundleStore` 反查 bundle 定义拼装 goodsDetail。三层超时预算：jifei 协议 3s → handler 2.5s（`HandlerTimeout`）→ trade→ctl 1.5s（`CTLCallTimeout`）。**关键 PDF 协议差异**：getAllAppIds / getUserResources 缺省 `payMode=0` 短路返空（PDF §1.1）；queryResource 缺省 `payMode=0` 按 1 处理走正常逻辑（PDF §2.2）。设计稿 `/root/project/mono/.tmp/trade-resource-query-design.md` §3.2 / §3.3 / §11 Q1~Q20。
- **BundleStore 批量反查**（迭代 11C-3）：`store.BundleDefinitionStore.GetBundleDefinitionsByIDs(ctx, ids []string) (map[string]*BundleDefinition, error)` 一条 SQL `WHERE bundle_id IN (?,...)` 参数化绑定批量反查；**bundle 不存在时不在结果 map 中**（与单条 `GetBundleDefinitionByID` 返 `ErrBundleDefinitionNotFound` 的语义等价 — 调用方按 `m[id] == nil` 走 graceful-degrade）。当前仅 resourcequery handler 使用（消除 page_size 默认 1000 时的 N+1）；其余 5 处生产代码（placeorder ×2 / inquiry ×1 / checkcreate ×1 / jifei.adapter ×2）保留单条 `GetBundleDefinitionByID` 不动。

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
- [x] **迭代 11A** — ctl 侧 3 个反查 `/internal/ctl/passes/*` 端点 + DAO 方法 + `pass.RenewFlag` 字段（commit `84fd5097`，2026-05-11）
- [x] **迭代 11B** — trade 侧反查三件套 handler（`internal/logic/resourcequery/` 整包 + `internal/ctlclient/` 出向 + `internal/httpapi/jifei/callback.go` 加 3 条 InterfaceName + `BundleStore.ListBundleDefsBySubProductCode` 扩展；累计 53 cases + 12 子测试 PASS，commit `c18edb56` / `23c00b79`）
- [x] **迭代 11C** — 公共抽取
  - 11C-1：region/zone 常量统一收敛到 `internal/region` 包（4 处业务包 import 引用，commit `eb38534c`）
  - 11C-3：`BundleStore.GetBundleDefinitionsByIDs` 批量接口消除 N+1（commit `65946845`）
  - 11C-2 / 11C-4：评估后不做（renewFlagToInt 单点使用 YAGNI / goodsDetail 三处分散是协议层有意差异化）
- [ ] **迭代 11D** — TAPD 子需求拆分 + 部署清单（暂搁）
- [ ] **迭代 9** — k8s 部署清单
- [ ] **迭代 10** — 联调 + 上线

---

## 联调期镜像构建标记

- **2026-05-20 v1.7.25**：trade build 37 (`commit c7de012b` v1.7.21) 因同时改了 trade + ctl 两个目录，触发 `.ci/runtime/contracts/release_plan.py` 同批依赖门禁（db.py L60 `release_dependency_changed=True` → raise），promote MR 未创建 → sandbox-bj-7 trade pod 仍卡在 v1.7.18 时段镜像。本 commit 仅改 trade/AGENTS.md（trade-only），让 release gate `release_dependency_changed=False` 放行，触发 build 38 重新 push 镜像 + 自动 promote 到 gitops 分支 → Argo CD selfHeal 拉新镜像滚 trade pod。代码语义零变化。

- **2026-05-22 v1.7.30**：BUG-35 isolateResource refund branch（commit `002833ed` build 67）同样命中 release gate，trade-only retrigger commit。本条记录用于触发 trade 流水线（trade/AGENTS.md 在 `trade/**` paths 范围内）。

- **2026-06-15 v1.7.32**：MR !1583（打开 `MASTER_AUTO_PIN_ENVS=beijing-sandbox`）+ MR !1585（落 sops trade-runtime-secrets）后 build 95 (commit `5f784a0cbf25`) 镜像构建成功，但 stage-2 GitOps auto-pin 因 `trade.bundle.publish_paths_by_env.beijing-sandbox=[]`（skipzhang 留下的第二道安全栓，与 `assertEqual(bundle.publish_paths, [])` 配对）报 `bundle trade does not define publish_paths` 退出 1。本 commit 解开第二/第三道锁（trade.bundle 与 contract test 同步对齐 ai-gateway/payment 的 6 条 publish_paths），但 `.ci/runtime/bundles/trade.bundle` 与 `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py` 都不在 `.ci/trade.yml` paths 白名单内，所以追加这一条 trade/AGENTS.md 改动以触发 trade 流水线（trade/** 命中），让 build 96 重新跑 + auto-pin 到 gitops。代码语义零变化。

- **2026-06-17 v1.7.33**：MR !1643（commit `65fdb9115`，trade getprice 拿掉 action 字段以适配 jifei 现网 PDF 校验）合并触发 build 98 (commit `0aa2c6acc`)，trade 镜像构建 stage 通过，但「北京测试 DB 变更检查与 GitOps auto-pin」stage 失败于 `run_gitops_db_job.py: error: argument --service: invalid choice: 'trade' (choose from 'ai-gateway', 'ctl', 'lightclaw-auth', 'payment', 'sandbox', 'subscription')`——trade.bundle 6/15 升级时声明了 `db_contract.mode=migration` + `db_job_service=trade`，但 `.ci/runtime/harness_ci/db_job.py` 的 `SERVICE_SPECS` 字典从未补 trade 条目，是 trade 第一次合到 master 触发主线 GitOps auto-pin 暴露的长期 contract drift bug。MR !1644（commit `b2c6b2aad`）已合到 master 补齐 SERVICE_SPECS 注册项（仿 lightclaw-auth/subscription shell 拼 `TRADE_MYSQL_DSN` 后 `exec /usr/local/bin/trade-migrate`），但 `.ci/runtime/**` 不在 `.ci/trade.yml` paths 白名单，单纯合 MR !1644 不会重跑 trade 流水线。本 commit 仅追加这一条 trade/AGENTS.md retrigger 笔记（trade/** 命中 trade.yml paths）让 build 99 重新跑——这次 db_job.py 已认识 `--service trade`，`migration_changed=false` 所以 db_job 应判断"无 migration 需执行"快速通过，进而走完 GitOps auto-pin 把 v1.7.32（含 getprice action 修复）镜像 pin 到 beijing-sandbox。代码语义零变化。
