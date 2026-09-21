---
id: opencraft-provider-onboarding-20260913
type: task
scope: OpenCraft 环境内模型服务的轻量添加、测试与显式启用流程。
triggers:
  - provider onboarding
  - model service presets
  - connection creation
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---

## goal
用预设驱动的完整表单代替先建禁用空连接再补配置；明确区分测试、保存与启用。

## non_goals
- 不升级 DSH，不引入 OAuth、无凭据推理，不提交、推送或操作生产。
- 不修改已有会话及默认模型选择，不替换原生适配器。

## requirement_refs
当前对话：用户同意借鉴 WorkBuddy 轻量配置，保留连接、模型、凭据的分层。

## requirement_ids
- OC-PROVIDER-ONBOARDING-20260913

## requirement_excerpt
用户确认“没毛病。开高。”，按开搞理解为实施紧邻上一条轻量表单方案。

## interface_refs / data_structure_refs
接口：runtime/providers/apply、runtime/models/probe、runtime/models/discover；所有者为 LocalAgentSettingsService 与 RuntimeProviderService。
预设是表单元数据，不是第二个运行时目录；测试不保存或启用。显式保存可启用完整新连接，省略 enabled 则兼容旧禁用草稿。

## history_context
current_design_refs: opencraft/docs/local-agent-custom-providers.md
relevant_evolution: 已有未提交实现支持草稿测试和连接内模型，本轮保留。
superseded_refs: ref/wb 恢复源码只作设计参考，不证明线上行为。

## acceptance
- 支持的预设只需填 Key 与模型，无需理解协议参数。
- 同一表单完成自定义地址、协议、发现、测试与保存。
- 编辑使测试结果失效，测试不启用、不保存，保存不改默认选择。
- 启用创建在凭据写入前校验完整性；接口保留禁用草稿兼容语义。
- 聚焦测试、隔离 DSH 与本地端点真实界面测试、类型与完整门禁。

## affected_paths
opencraft/plugins/builtin-agents/src/provider-*、local-agent-settings-service.ts；opencraft/apps/local-agent-host/src/runtime-provider-service.ts；协议、测试、冒烟与模型文档。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| AGENTS.md; opencraft/AGENTS.md | 边界 | 保留工作区变更，不发布 |
| docs/context/domains/agent-gateway-runtime.md | 路由领域 | 运行时权威 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md; references/verification.md | 维护规范 | 状态归属与真实验证 |
| opencraft/docs/local-agent-custom-providers.md | 当前设计 | 保留 CAS 与凭据语义 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻居路由 | 检查共享设置控件与冒烟邻居 |
| docs/context/tasks/TASK-TEMPLATE.md | 任务契约 | 有界实施 |

## validation
- 28 项聚焦测试通过：provider-onboarding、runtime-provider-service、local-agent-reasoning-settings。
- npm run gate 退出 0，覆盖类型、边界、测试与 Web/Expo 构建。
- smoke-local-agent-settings 退出 0：真实 UI → AppServer → 隔离 DSH，本地模型端点替身；无真实凭据、付费推理。
- 浅色/深色及窄屏截图已观察；测试失败不泄露响应正文，取消拒绝保留草稿，重挂载保留草稿。
- 文档校验无错误；影响检查因无暂存文件只返回空集通过，不宣称完成暂存审核。
- 根目录 Context 测试仍有历史规范告警（其他任务 frontmatter、中文优先与指令链预算等），不宣称全仓门禁全绿；本任务 frontmatter 已用同一 schema 单独验证为零错误。Context audit 的 33 项测试通过，发现型审计不提供成熟度评分。

## risks
预设兼容性受协议限制，文本测试不承诺完整模型能力。只读与未支持的宿主不开放操作；草稿保留原始配置版本。

## handoff
本轮源码实现与隔离真实界面验收完成，未更新正在运行的 Mac 预览，未提交或发布。

## stage
实现、聚焦测试、界面验收和 OpenCraft 完整门禁完成。

## verified
保存启用后运行时目录 active=true 且模型可选，默认模型保持不变；测试不产生配置写入。

## unverified
真实供应商推理、工具调用、图像输入和新 Mac 包实机验收未执行。

## discard
旧创建禁用空连接优先流程已被替代；仅 API 兼容保留。

## restore
本轮复用已有未提交改动，不应整文件回退。验证日志位于本地临时目录，不提交。

## next_action
如需桌面交付，按构建矩阵使用独立产物和 profile 重新打包验收。
