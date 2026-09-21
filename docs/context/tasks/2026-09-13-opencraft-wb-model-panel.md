---
id: opencraft-wb-model-panel
type: task
scope: 按 WorkBuddy 结构实现自定义模型列表和编辑弹窗，使用 OpenCraft 主题控件。
triggers:
  - WorkBuddy 模型面板
  - 自定义模型弹窗
  - model settings replica
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
主入口改成 WB 的模型列表加添加/编辑弹窗，移除连接分栏、测试区和启用操作。
## non_goals
不换 DSH、不复制 WB 私有存储或企业策略、不发布提交、不展示假能力。
## requirement_ids
OC-WB-MODEL-PANEL
## requirement_refs
本对话用户确认。
## requirement_excerpt
“100%复刻workbuddy”“除了UI主题、控件是我们的”。
## history_context
current_design_refs: opencraft/docs/local-agent-custom-providers.md
relevant_evolution: 上一版轻量连接表单被用户否定；本轮改为原版模型视角。
superseded_refs: provider-create-page 连接编辑入口不再用于默认设置页。
## interface_refs / data_structure_refs
保留 runtime/providers/apply 的 CAS、凭据归属和模型身份；视图按连接 ID + 模型 ID 投影。
## acceptance
常规提供商三个字段、取消/保存；自定义接口才有地址和高级配置。保存回列表、编辑/删除可用；无隐式默认模型切换；主题、键盘和窄屏可用。
## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| opencraft/AGENTS.md | 维护入口 | workspace 与门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 产品边界 | 状态归属 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 验收 | 真实 DSH 与桌面 |
| opencraft/docs/local-agent-custom-providers.md | 当前设计 | 保留协议 |
| ref/wb/packages/agent-ui/src/components/setting/components/panels/ModelsSettingsPanel.tsx | 参考面板 | 字段与操作 |
| ref/wb/packages/agent-ui/src/components/setting/model-config/defaults.ts | 参考策略 | 显隐与默认值 |
## scan_scope
路由 opencraft model settings WorkBuddy form 无匹配，已在上述精确文件检索。
## validation
聚焦测试、真实 UI + 隔离 DSH、完整门禁与独立桌面预览。
## risks
底层与 WB 不同；不能假造文件入口或未接通的能力字段。共享连接编辑必须确认影响范围。
## handoff
实现与独立 Mac 预览完成，已打开添加模型弹窗。未提交或发布。

## evidence
- 27 项模型聚焦测试通过；新版真实组件 → AppServer → 隔离 DSH 添加/编辑/删除冒烟通过，未调用真实供应商。
- 浅色/深色、窄屏、草稿重挂载、Escape 与焦点恢复检查通过。
- npm run gate 退出 0；文档校验 errors=[]，git diff --check 通过。
- 新 Mac 包 build:electron、打包、codesign --verify --deep --strict 均退出 0；已实机打开三字段弹窗。
- 影响检查无暂存文件，空集通过，不等于已提交审核。

## stage
源码、完整门禁与原生预览验收完成。
## verified
常规面板无连接分栏、测试区或启用开关；保存后回模型列表，默认模型保持不变。
## unverified
真实供应商推理未验证；未复制 WB 的企业策略、专属 provider 目录和文件存储入口。高级字段仅展示 DSH 已接通的图片与 Token 限额。
## discard
上一版连接创建页不再作为默认设置入口；保留内部回归表面，不注册用户入口。
## restore
新预览在 opencraft/apps/workbench-electron/release/wb-models-preview-20260913，使用独立 profile；不覆盖先前预览。
## next_action
等待用户对原生面板的视觉反馈，不自动提交或发布。
