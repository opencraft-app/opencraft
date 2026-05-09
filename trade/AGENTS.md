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
- [ ] **迭代 4** — jifei 回调入向 dispatcher（Q60）
- [ ] **迭代 5** — checkCreate handler（Q62）
- [ ] **迭代 6** — createResource handler（Q61 抢占式幂等）
- [ ] **迭代 7** — trade_flow reconcile worker
- [ ] **迭代 8** — DescribeBundles 询价集成 + CreatePass 入口
- [ ] **迭代 9** — k8s 部署清单
- [ ] **迭代 10** — 联调 + 上线
