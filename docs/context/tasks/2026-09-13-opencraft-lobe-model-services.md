---
id: opencraft-lobe-model-services
type: task
scope: 实施已确认的 LobeChat 风格模型服务页与 Shell 环境面包屑，接入现有 DSH 配置接口。
triggers:
  - LobeChat 模型服务
  - 环境面包屑
  - provider settings integration
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
实现用户确认的提供商分组、同页配置与模型列表，强调窗口顶栏“环境 / 本机 / 模型服务”。
## non_goals
不恢复前两版 UI，不导入 LobeChat 数据库，不改用户配置/会话默认值，不自动推理测试，不提交发布。
## requirement_ids
OC-LOBE-MODEL-SERVICES
## requirement_refs
当前截图及用户确认。
## requirement_excerpt
“很好，这个设计很好：尤其是我红框的。你可以改一下。”
## history_context
current_design_refs: opencraft/docs/local-agent-custom-providers.md; opencraft/docs/platform-architecture.md
relevant_evolution: 两版旧 UI 已清理；用户已确认独立 LobeChat 结构预览。
superseded_refs: 已删除连接分栏和 WB 弹窗，不恢复。
## interface_refs / data_structure_refs
Shell 投影 ApplicationRoute、Host 名称与 SettingsPageContribution；配置客户端仍通过 runtime/providers/*、runtime/models/*。草稿按 Host 与 provider 隔离。
## context_receipt
| 文件 | 用途 |
|---|---|
| docs/context/domains/agent-gateway-runtime.md | 运行时归属 |
| opencraft/AGENTS.md | workspace 门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 状态与几何归属 |
| opencraft/docs/local-agent-custom-providers.md | 保留 CAS 和凭据语义 |
| ref LobeChat ProviderMenu/ProviderConfig/ModelList | 用户已确认的布局与流程 |
## acceptance
面包屑随环境/页面变化，点击返回不改变聊天会话；主从配置页不重复挤出环境导航栏。提供商/模型列表来自运行时；配置、启用、发现与文本检查是不同动作，错误留在操作处。
## validation
类型检查、聚焦测试、真实 UI 与隔离 DSH、完整门禁及独立 Mac 预览。
## risks
不能把所有 DSH 适配器视为同一种协议；只展示宿主声明的操作。检测不复用存储凭据到未知地址。
## handoff
实现及独立 Mac 预览完成，已打开模型服务页；未提交发布。

## evidence
- 31 项聚焦测试通过；模型服务组件通过真实 AppServer/隔离 DSH 检查，使用本地端点，无外部付费推理。
- 测试覆盖配置合并保存、提供商创建/启用、文本检查、导入模型默认禁用、模型开关、面包屑、窄屏和视图重挂载。
- 最终 Web、builtin-agents、local-agent-host 类型检查与 Electron 构建/打包/签名验证通过。
- 完整 gate 执行至 workbench 单元测试有一项失败：现有 RightPanel 创建菜单测试仍匹配 state.right.tabs，而当前代码使用 regionState；该文件不属本轮改动，不宣称全门禁绿色。
- 原生窗口验证顶部路径为 环境 / 本机 / 模型服务，模型页环境目录为 0、提供商目录为 1；点击本机返回概览后环境目录恢复。最终预览完成非默认模型停用/恢复，无界面错误。
- 文档校验无错误，git diff --check 通过；暂存影响检查为空集，不代表提交审核。

## stage
实现与原生宽屏验收完成；独立浏览器组件覆盖窄容器，未进行原生窗口拖动验收。
## verified
实际模型目录来自 DSH，不使用预览示例数据；不改变用户的实际配置目录。最终包位于 opencraft/apps/workbench-electron/release/lobe-model-services-final-preview。
## unverified
真实供应商推理/工具/图像能力未验证。运行时管理的原生适配器不伪造启用开关；OAuth 未实现。
## discard
HTML 示意图只作已确认设计，不作为运行时与可用性证据；旧两版 UI 不恢复。
## restore
使用独立预览 profile；保留 DSH 配置/凭据接口，新增页面只在本机 Host 注册。
## next_action
用户预览反馈；处理共享右侧面板测试属于其对应变更，不自动合并或发布。
