---
id: opencraft-model-ui-removal
type: task
scope: 删除两版模型设置界面、专属状态样式测试与旧预览，保留运行时接口及配置数据。
triggers:
  - 删除模型设置界面
  - 清理 WorkBuddy 面板
  - model UI removal
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
彻底删除被否定的两版模型 UI 闭包，不残留隐藏入口。
## non_goals
不删除 DSH 模型、凭据、配置接口或用户实际数据，不实施未经视觉确认的 LobeChat 新版，不提交发布。
## requirement_ids
OC-MODEL-UI-REMOVAL
## requirement_refs
当前对话用户确认删除范围。
## requirement_excerpt
“删除所有的相关的模型设置代码，别留残余”；明确确认保留 DSH 接口和实际配置。
## history_context
current_design_refs: opencraft/docs/local-agent-custom-providers.md
relevant_evolution: 连接面板及 WB 弹窗都被否定，先清理旧实现再重新对齐 LobeChat。
superseded_refs: 前两轮 UI 任务文档只保留历史，不作为当前实现。
## interface_refs / data_structure_refs
保留 runtime/providers/*、runtime/models/*、runtime/credentials/*；LocalAgentSettingsService 仅保留无界面的配置客户端。
## acceptance
旧文件、引用、注册、样式为零；通用设置/环境仍通过测试；运行时测试保留；旧模型专属预览移入废纸篓。
## context_receipt
| 文件 | 用途 |
|---|---|
| opencraft/AGENTS.md | workspace 与门禁 |
| docs/context/project/services/frontend.md | 路由命中，但不扩展为 frontend 修改 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 删除边界、保留数据 |
| opencraft/docs/local-agent-custom-providers.md | 保留协议与凭据语义 |
## validation
旧 UI 源码/注册/样式引用扫描零命中；Web 与 Electron 渲染产物中旧面板标记零命中。
29 项聚焦测试通过；npm run gate 退出 0；环境冒烟和真实 DSH 重启持久化冒烟通过。
最终 builtin-agents 与 workbench-web 类型检查、Electron renderer 重建通过；文档检查无错误；git diff --check 通过。
暂存影响检查为空集通过，不代表已提交审核。
## handoff
源码删除前已归档到系统废纸篓，保留恢复能力；实际用户配置目录未触碰。

## stage
删除与验证完成，未提交发布。
## verified
删除 19 个旧 UI/专属状态/资源声明/测试脚本文件；混合测试仅移除旧 UI 断言，保留运行时保护。
三个模型专属预览目录已移入系统废纸篓；无对应运行进程需要终止。通用控件与环境测试保留。
## unverified
LobeChat 新版尚未接入；后续先完成原版视觉对照。
## discard
前两版模型 UI 文档为退役历史，不能当作当前界面。
## restore
源码归档与旧包位于系统废纸篓 opencraft-model-ui.mmtWPN；已跟踪源码也可从 Git 历史恢复。DSH 与用户数据未删除。
## next_action
按 LobeChat 参考源码确定新面板预览，不复用被否定的两版 UI。
