---
id: composer-capabilities
type: task
scope: 修复模型配置更新后 Composer 能力目录混用旧 Agent 缓存
triggers:
  - opencraft
  - composer-capabilities
  - model-cache
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/local-agent-custom-providers.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

# Composer 联合能力目录

## requirement_ids

- composer-capabilities

## requirement_refs

- 当前用户确认参考 WorkBuddy 的通知刷新/菜单打开刷新，复用 TanStack Query。

## requirement_excerpt

“好，那就这么搞。”

## goal / non_goals

让配置中的已启用模型及时出现在聊天选择器，消除新 models 与旧 Agent modelIds 的混用。不绕过 Agent 范围，不改用户选择、路由、凭据，不引入第二套缓存，不声称两次 RPC 为后端事务。

## history_context

当前运行窗口已确认模型目录含自定义模型，但 Composer agents 清单仍为旧三个内置模型。原来只失效 composer-models 查询，漏掉 agents。WB 本地源码使用配置变更事件和菜单打开刷新；其延迟补拉和忽略空列表不照搬。

## context_receipt

- opencraft/AGENTS.md
- opencraft/.agents/skills/opencraft-maintenance/SKILL.md
- opencraft/docs/local-agent-custom-providers.md
- opencraft/docs/build-matrix.md
- ref/wb/packages/agent-ui/src/components/main-content-core/hooks/use-model-selector.ts
- ref/wb/packages/agent-ui/src/components/setting/components/panels/ModelsSettingsPanel.tsx

路由 opencraft composer catalog cache 无匹配；精确搜索 useComposerCatalog、modelIds.includes、配置写入回调，并检查现有 Composer 测试邻居。

## acceptance / validation

真实 QueryClient 测试成组分页、部分失败、空结果、取消迟到结果、Host/会话隔离、缓存去重和统一失效。完整门禁，实际 Mac Composer 从旧目录经配置新增/启用后显示新模型；不发外部推理请求。

## checkpoint

阶段：实现与验收完成。5 项真实 QueryClient 用例通过（分页成组、部分失败保留旧结果、空结果覆盖、取消初始请求/迟到响应、Host 与 thread 范围隔离、新鲜缓存去重、统一失效）。完整 gate、Electron 构建和 Mac arm64 打包通过，签名深度校验通过。

最终产物 `opencraft/apps/workbench-electron/release/composer-capabilities-preview/mac-arm64/OpenCraft Preview.app` 已打开。`scripts/smoke-composer-model-sync.ts` 在显式指定的测试窗口中预热旧模型菜单，新增配置/模型并启用，再回聊天验证真实菜单包含新增模型；删除专用测试连接后菜单同步移除。未重启窗口、未发推理请求，只用合成 Key 与不可用的本地测试端点。截图 `/tmp/opencraft-composer-model-sync.png`。原用户窗口与其“11”连接未修改，旧窗口不会自动升级。

查询错误保留完整旧数据并提供 Radix 重试项，显式选择不可用时不改写选择而显示提示。现有 RPC 无传输取消能力，AbortSignal 只保证取消查询不发布；联合读取不是后端事务快照。文档检查与 diff 检查通过；未提交、推送或发布。下一步用户可在新版中验证，使用原配置需保留原 profile 升级窗口，不复制真实凭据到测试环境。
