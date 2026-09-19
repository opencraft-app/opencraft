---
id: opencraft-thread-lifecycle-20260915
type: task
scope: 本机会话分支、临时聊天、订阅与持久元数据生命周期。
triggers: ["opencraft", "thread lifecycle", "side chat", "fork"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/thread-lifecycle/task_plan.md
status: retired
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
严格实现已分析的会话生命周期，而非只补 RPC 分支。

## non_goals
不提交推送发布、不删除用户 workspace、不改模型配置、不覆写历史或丢失继承上下文。

## requirement_ids / requirement_refs / requirement_excerpt
当前请求：“严格实现”；上轮分析明确身份、逻辑订阅、边界注入、清理事务、命名和归档语义。

## interface_refs / data_structure_refs
`ThreadForkParams`、`ThreadUnsubscribeResponse`、`SideChatService`、`AppHostServer`、DSH SessionPersistence/AgentRegistry。
不变量：Fork 新逻辑身份；重启 generation 保留身份；临时会话不持久化；unsubscribe 隔离逻辑客户端；旧回复不删除新视图。

## history_context
current_design_refs：`opencraft/docs/platform-architecture.md`、`opencraft/design/invariants.md`。
relevant_evolution：此前本机适配层缺少这些方法，上层 Side Chat 流程和替身测试已存在。
superseded_refs：摘要式 fork、以函数存在代替能力声明、把物理连接当逻辑订阅者均不采用。

## acceptance
真实本机 fork 与边界、临时存储、两窗口订阅隔离、命名/归档重启保留、失败清理可重试、迟到回复隔离；完整门禁与桌面验收。

## affected_paths
`opencraft/apps/local-agent-host`、AppHost、workbench-runtime、workbench-web、相关测试与设计。

## required_context
无路由匹配；沿已核对精确调用链读取。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务边界 | 门禁与上游约束 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 维护方法 | 状态所有权 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 验收方法 | 区分替身与实机 |
| opencraft/docs/platform-architecture.md | 平台责任 | Host 与引擎隔离 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务契约 | 范围与证据 |

## evidence
此前只读探针确认缺失方法；Side Chat 失败清理丢失重试和错误覆盖均已复现。
本轮 `test:thread-lifecycle` 43/43；本机 Host/AppHost 聚焦 16/16；完整 `npm run gate` exit 0。
真实隔离 DSH Fork/边界、临时落盘审计、逻辑客户端、命名/归档和重启恢复通过，只调用本地合成模型。
独立签名包经真实 AppHost/DSH UI 完成命名、分支导航、归档及恢复；桌面操作不执行推理。
日志：`/tmp/opencraft-thread-gate.log`、`/tmp/opencraft-thread-native-final.log`、`/tmp/opencraft-thread-desktop-checked.log`。
收尾红绿回归覆盖启动失败关闭目录，以及临时会话断连时的延迟释放重试和新订阅串行化。
Root 全仓 Context 仍有历史任务格式/扫描/预算问题，本轮 Task Pack 未新增格式失败。

## risks
共享物理连接、运行中分支和临时存储是重点风险；以严格公开端口、逻辑身份和真实测试约束。

## validation
TDD 聚焦测试、平台边界、类型检查、完整 `npm run gate`、隔离真实 DSH/桌面冒烟；禁止真实付费调用。

## decisions
OpenCraft 拥有持久目录与事务；DSH 只提供上下文和执行端口；参考中的特定后端重试时序不照搬。

## scan_scope
已定位本机、AppHost、SideChat、引擎公开接口及精确 ref/codex 文件。

## scan_output
分步事实记录于 `opencraft/design/thread-lifecycle/findings.md`。

## handoff
实现完成且独立真实桌面验收通过；保留所有其他未提交改动，未提交/推送/发布。源码变更不等于更新正在使用的旧客户端。

## checkpoint
stage：最终交接。
verified：持久目录、原生上下文/临时存储、逻辑订阅、Side Chat 清理和边界、命名/归档菜单及恢复、源码门禁和桌面验收。
unverified：发行签名/notarization、生产发布、远端 Hermes 生命周期均不在本轮范围。
discard：虚拟 UI 入口及错误 URL/空模型 fixture 的失败尝试，均不作为产品失败归因。
restore：`opencraft/design/thread-lifecycle` 账本与独立预览输出。
next_action：用户在最终预览体验；Git 操作需另行授权。
