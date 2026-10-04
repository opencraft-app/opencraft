---
id: adr-0001-context-engineering-v2
type: decision
scope: 采用分层、路由、可审计的仓库 context，替代全量 context 注入。
triggers: ["context architecture", "ADR", "routing decision"]
owner: mingyuxiao
authority: primary
source_of_truth:
  - docs/context/decisions/ADR-0001-context-engineering-v2.md
status: active
reviewed_at: 2026-09-29
review_due: 2026-11-23
revision: 2.3.0
precedence: project
derived: false
---

# ADR 0001：Context Engineering v2

## 决策

仓库 context 分为 Team、Project 和 Task 指令层。根入口是路由 contract；Domain Pack 保存持久、无法从代码推导的事实；Task Pack 保存临时执行状态。运行时路由必须确定且经静态验证。

## 后果

Agent 在通用指令上消耗更少 Token，并获得具体服务边界、外部 contract 和验证门禁。内容 owner 必须审阅 active Pack。未验证的模型路由和 compaction 功能只能是 pilot 设计，不能宣称为运行时能力。

Task Pack 的元数据进入 `docs/context/.context/catalog.jsonl`；新增或更新 Pack 后必须通过 Context Validator 重建 catalog，catalog 只提供可定位索引，不替代 Task Pack 正文。

新增一级服务必须原子登记服务本地 catalog、中央 Service Catalog、派生 service Context Pack 和
`service-<id>` 路由，并同步校验器的一级服务集合。服务数量由该集合派生，错误和报告不得再写死
固定数量；这样新增 Credit 等服务时，入口覆盖检查会明确指出缺失项，而不是要求维护孤立的计数。

## 2026-09-14 应用：Collaboration 与 Vela Computer

Velachat 融入 mono2 时，`collaboration/` 与 `vela-computer/` 作为两个独立一级服务登记：前者是
Server/Member/腾讯 IM 映射控制面，后者是下发到托管 Computer 的 Agent Chat Client。两者分别
拥有本地 catalog、中央 Service Catalog 条目、派生 Service Context 和 `service-<id>` 路由；
校验器的一级服务集合与测试同步增加对应入口。OpenCraft 仍是唯一 Human Web 呈现真源，新增服务
路由不建立旧 Velachat 或 `mono2-clean4` 双写关系。

## 2026-09-16 应用：OpenCraft 工作台入口

根 `AGENTS.md` 只登记 OpenCraft 的路径和局部入口，不承载桌面运行手册；根 `README.md` 给人类可执行的本地与隔离预览步骤，`opencraft/AGENTS.md` 仅补充服务内所有权、参考仓库和验收约束。完整平台契约仍由 OpenCraft 正式文档与构建矩阵拥有。这保持了根路由、服务局部规则与人类操作说明的单一权威关系。

## 2026-09-29 应用：本地移动包与 GitOps 路由

本地 APK/IPA 打包不等于集群发布。`release-gitops` 的英文 `release`
单词过宽，会把 Android release APK 的任务误路由到 Argo 文档；路由改用
`release promotion` 等明确的部署或晋级词，保留 `gitops`、`argo`、
`publish`、`发布` 和路径命中。OpenCraft 移动交付步骤由局部 `AGENTS.md`
路由到 Expo README 与构建矩阵，不复制到根 Team 入口。

## 2026-09-22 应用：nextgen-dashboard 服务下线

`nextgen-dashboard` 一级服务废弃，按新增一级服务的原子登记契约做逆向收敛：源码目录与本地 catalog 随之删除，中央 Service Catalog 条目、派生 service Context Pack、`service-nextgen-dashboard` 路由与冒烟用例、change-impact 命中路径、校验器 `PRIMARY_SERVICES` 集合及测试同步移除。deploy-facing 清单、SOPS secrets、SSM manifest、CI 流水线与 `nextgen-dashboard-client` 客户端已在同日下线变更中一并移除；admin-gateway 各环境配置中的 `/admin` upstream 路由已先行摘除。历史 runbook 与分析快照不回写。

## 2026-09-22 应用：OpenCraft 单向公开镜像

根 `AGENTS.md` 明确 `mono2/opencraft` 是唯一写入真源，并将 GitHub
`opencraft-app/opencraft` 定位为单向公开镜像。详细的导出前提、历史邮箱重写、敏感信息扫描、
tree 一致性和 fast-forward 约束只由 `opencraft/MONO2_MIGRATION.md` 维护；根入口仅路由并声明
不可双写、不可反向 pull、外部贡献须先回到 mono2 评审。这避免把一次公开导出误解为新的上游
或第二套开发流程，也保持根 Team 指令、Project Pack 和服务迁移文档之间的权威层次。
