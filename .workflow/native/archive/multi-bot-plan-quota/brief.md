# Multi-Bot Plan Quota

## 需求

在 LightVela 国内站为“单 Agent 多 Bot”增加套餐级数量权益，并更新现有多 Bot PRD：

- 启航 Launch、启航 Launch AI：每个 Agent 最多 5 个 Bot。
- 巡游 Cruise、巡游 Cruise AI：每个 Agent 最多 10 个 Bot。
- 数量包含存量主 Bot；例如启航已有主 Bot 时，最多还能创建 4 个命名 Bot。
- 已有 Agent 的“新建 Bot”入口继续遵循当前发布决策：默认隐藏，Console `show()` 只能临时显示入口，不能绕过功能开关或套餐数量限制。

成功标准：

- 套餐权益独立于 `agent_quota`；后者继续只表示用户可拥有的 Agent 实例数。
- CTL 是数量限制的权威执行方，达到上限后创建接口返回稳定、可识别的配额错误，不创建残留 Profile。
- 前端从用户当前 Pass 获得每 Agent Bot 上限，在达到上限时提前禁用创建并展示对应 5/10 的说明；后端错误仍作为最终兜底。
- 同一 Agent 的并发创建请求不会同时越过上限。
- 套餐从启航升配为巡游后，上限随当前有效 Pass 变为 10；降级或其它套餐变化不得删除已有 Bot，只阻止继续创建，直到数量回到上限以下。

## 方案

- 在 CTL Bundle 权益模型增加 `bot_quota_per_agent`，避免与 Agent 实例席位 `agent_quota` 淡化或混用。
- 新增 CTL migration：字段默认按保守兼容值 1 处理，并为当前四个套餐 ID 写入 Launch/Launch AI=5、Cruise/Cruise AI=10；免费试用和未配置套餐保持主 Bot 单 Bot能力，不自行扩大本次产品范围。
- Bundle 导入、修改、后台/用户可见响应同步承载该字段，保证套餐配置可管理、可查询；Pass 用户响应实时带出当前 Bundle 的 `bot_quota_per_agent`，不在 Pass 表重复持久化。
- `CreateInstanceBot` 根据当前用户有效 Pass 读取 Bundle 权益，在实例内串行执行“读取 Hermes Profile 数量 + 创建 Profile”。使用 `$HERMES_HOME/.lightvela` 下的实例本地文件锁覆盖计数与创建临界区，使多个 CTL 请求共享同一 Agent 运行时锁；命中上限映射为专用 403 错误。
- 前端 `Pass` 类型消费 `bot_quota_per_agent`，映射到现有 `user.plan.maxBots`；沿用 `getOpenClawCreateLimitMessage` 和现有创建入口门禁，不新增第二套计数状态。
- 从 `origin/master` 取回权威 PRD 后，只修改数量策略、范围、方案决策、验收标准和待确认项；保留 master 已有的入口隐藏、删除规则、Profile 真源和诊断中心结论。

## 范围

- `ctl/migrations/`、`ctl/pkg/model/bundle/`、`ctl/pkg/logic/bundle/`、`ctl/pkg/transport/`、`ctl/main/api/`
- `ctl/pkg/logic/pass/`、`ctl/pkg/instance/`、相关 CTL 测试
- `frontend/src/domain/types.ts`、`frontend/src/contexts/agent-context.tsx`、现有多 Bot 创建限制及相关测试
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`
- `docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md` 及 change-impact 要求映射的正式设计文档

非目标：

- 国际站开放多 Bot、调整 Agent 实例数权益、按 Bot 单独计费、自动删除超额 Bot。
- 改变主 Bot、克隆、通道隔离、Profile 路由或当前“新建 Bot”入口默认隐藏策略。
- 生产数据变更、GitOps、发布、Git commit/push/MR；这些动作需要另行明确授权。

## 验收口径

- Bundle/Pass contract 测试覆盖四个套餐的 5/10 配额、字段导入修改与用户响应。
- CTL 实例测试覆盖：主 Bot 计数、低于上限创建成功、达到上限返回专用错误、并发请求串行且不超额、创建失败不遗留 Profile。
- 前端测试覆盖：Launch/Launch AI 映射 5，Cruise/Cruise AI 映射 10，缺失字段保守回退；5/10 达限时创建入口和提示正确，未达限保持可创建。
- 运行 CTL 相关 Go 测试、前端聚焦 Vitest、`pnpm check`、国内站构建、文档校验、change-impact 校验与 `git diff --check`。
- 不把本地源码验证表述为已发布；真实环境仍需在后端、网关和前端部署后回归。

## 关键上下文与风险

- 当前 `agent_quota` 的最终真源是 `user_resource_quota`，语义为 Agent 实例席位，不能承载单 Agent 内 Bot 上限。
- 当前 Bot 列表由 Hermes Profiles 实时投影，主 Bot 是 `default`/`main` 映射，因此 Profile 列表长度就是该 Agent 的 Bot 占用数。
- 仅在 CTL 进程内加互斥锁无法覆盖多副本；临界区必须落在目标 Agent 的运行时文件锁内。
- 套餐变更可能造成“已有 Bot 数大于新上限”；本期保留可读、切换、配置和删除，只禁止继续创建，避免破坏用户数据。
- 本机缺少全局 `feai` 命令，`feai workflow usage-context write` 无法执行；Native engine 可用，本次在报告中记录该环境缺口，不手写统计 payload。
