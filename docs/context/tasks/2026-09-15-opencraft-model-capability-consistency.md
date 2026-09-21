---
id: opencraft-model-capability-consistency-20260915
type: task
scope: 默认模型与模型输入能力的展示和执行一致性。
triggers: ["opencraft", "model capability", "default model", "input modalities"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/design/model-configuration.md
  - opencraft/design/model-capability-consistency/task_plan.md
status: retired
reviewed_at: 2026-09-15
review_due: 2026-12-14
revision: 1.0.0
precedence: task
derived: false
---

## goal
修复默认模型、图片能力和能力投影的一致性。

## non_goals
不更换引擎、不改变用户模型配置/凭据/会话、不提交推送发布。

## requirement_ids / requirement_refs / requirement_excerpt
用户批准“先修默认模型、图片能力和能力投影的一致性”。

## interface_refs / data_structure_refs
ModelDocument、RuntimeModelView、CatalogModel、SubmitCompilerOptions、DSH session models。

## history_context
current_design_refs：opencraft/design/model-configuration.md、docs/platform-architecture.md。
relevant_evolution：bb 对照分析识别目录首项默认与固定图片能力；reasoning null/合法集合规则已实现，继续保留。
superseded_refs：目录第一项默认、所有模型声明 image 均不保留。

## acceptance
无明确默认不选首项；有明确默认选对应路由；有效会话模型保留；图片能力和模型输入定义一致，文本模型图片请求在发送前拒绝；隔离真实引擎验证且不调用外部付费模型。

## affected_paths
opencraft 本机适配器、模型配置、Composer/Runtime、测试与正式设计。

## required_context
root route 无匹配，进行有界精确检索。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 服务规则 | 独立 workspace 与验证 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 所有权 | 保留用户数据 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 验收 | 隔离模型与真实链路 |
| opencraft/design/model-configuration.md | 模型真源 | null/配置与应用 |
| opencraft/docs/platform-architecture.md | 平台边界 | 共享 compiler |
| docs/context/tasks/TASK-TEMPLATE.md | 任务记录 | 范围与证据 |

## evidence
已定位 mapModels 首项默认、固定 inputModalities，以及 Web/Expo 首模型 fallback。
本轮聚焦 77/77，通过完整 OpenCraft gate（/tmp/opencraft-model-capability-gate-final.log）；真实 DSH 的 text/image、明确默认/清除/重启及空会话绑定恢复通过（/tmp/opencraft-model-capability-native.log）。
签名独立桌面包实际确认无默认显示 Model、命名/Fork/归档/恢复通过（/tmp/opencraft-model-capability-desktop.log），无真实付费模型调用。

## risks
引擎私有默认未必可设为空；先核对真实 schema，不制造 workaround，不让私有默认进入产品选择。

## validation
TDD 红绿、聚焦模型/Compiler/Host、完整 gate、隔离真实 DSH/桌面链路。

## decisions
先恢复既有产品不变量，能力缺失不猜测 image；保留明确默认及现有会话选择。

## scan_scope
opencraft 模型目录、配置 adapter、Composer 与请求 compiler。

## scan_output
design/model-capability-consistency/findings.md。

## handoff
实现及验收完成，未提交推送发布。独立包：opencraft/apps/workbench-electron/release/model-capability-20260915/mac-arm64/OpenCraft Preview.app；既有预览不热更新。
所有原有改动保留。

## checkpoint
stage：交接；verified：默认/输入/档位校验、真实 DSH 与签名 Mac 桌面、完整 gate、文档与影响检查。
unverified：Expo 原生设备实机与发行发布；Root Context 历史格式/预算/长哈希扫描问题仍存在，本轮 Task Pack 未新增失败。
