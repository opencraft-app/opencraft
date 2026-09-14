---
id: provider-lifecycle-parity
type: task
scope: 将 DeepSeek 原生提供商纳入统一真实启停，保留 DSH 引擎和用户配置凭据。
triggers:
  - DeepSeek 提供商平等
  - provider lifecycle parity
  - 原生提供商启停
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
DeepSeek 提供商可真实停用和恢复，不再用“运行时管理”代替操作。
## non_goals
不改引擎、用户实际数据、默认模型，不提交发布；原生协议实现不替换为通用协议。
## requirement_ids
OC-PROVIDER-PARITY
## requirement_refs
当前对话截图与确认。
## requirement_excerpt
“deepseek 模型并不特殊，也不应该特殊的”“虽然是deepseek harness 作为引擎”“是的”。
## history_context
current_design_refs: opencraft/docs/local-agent-custom-providers.md
relevant_evolution: 已有通用适配器生命周期补丁；原生适配器此前总是注册。
superseded_refs: 原生提供商不允许停用的 UI 能力声明废弃。
## context_receipt
| 文件 | 用途 |
|---|---|
| scripts/patch-dsh-provider-lifecycle.mjs | 固定版本补丁入口 |
| runtime/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js | 原生注册与 onChange |
| runtime/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js | 注册 disposer 语义 |
| apps/local-agent-host/src/runtime-provider-service.ts | 统一命令与默认保护 |
## acceptance
真实停用、重启仍停用、重新启用；默认模型保护一致；目录/凭据保留；补丁幂等和漂移拒绝。
## validation
补丁测试、真实隔离 DSH 冒烟、门禁与独立桌面预览。
## handoff
已完成并打开独立 Mac 预览，未触碰用户配置目录，未提交发布。

## evidence
- 10 项运行时准备/补丁测试通过；30 项模型相关聚焦测试通过。
- 真实隔离 DSH 验证默认保护、缺凭据拒绝、路由释放、重启仍停用、目录/凭据保留与重新注册。
- 界面冒烟完成切换默认提供商、停用 DeepSeek、补凭据并重新启用，再恢复原默认模型。
- 完整 npm run gate 退出 0；最终 Electron 构建/打包/签名验证通过。
- 原生新窗口 DeepSeek 显示通用启用开关，“运行时管理”文案为零，非默认模型有设为默认入口。
- 文档检查、git diff --check 通过；暂存影响检查为空集。

## stage
源码与原生预览验收完成。
## verified
停用是引擎路由真实注销，不是前端隐藏；保存与凭据使用原命名空间，不另建数据库。
## unverified
未执行真实供应商推理或在途流取消测试；enabled 默认值保留存量兼容，不自动迁移原有默认模型。
## restore
最终独立预览位于 opencraft/apps/workbench-electron/release/provider-parity-final-preview。
## next_action
等待用户预览反馈，不自动提交或发布。
