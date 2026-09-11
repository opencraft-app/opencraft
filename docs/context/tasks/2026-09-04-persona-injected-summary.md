## goal
让抽卡或测试推荐注入的人设，在人设卡片下方显示与自定义人设一致的“已注入”摘要。

## non_goals
- 不改变人设注入、下载兜底或删除逻辑；编辑抽卡人设仅将当前文件转为自定义来源，不改动抽卡盘中的原卡内容。
- 不新增后端接口、持久化字段或推荐人设卡片样式。
- 不提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图（2026-09-04）：自定义人设已有“已注入：自定义人设 · 名称”摘要；抽卡注入后也应显示对应摘要。
- 用户追加（2026-09-04）：抽卡注入的人设摘要也增加编辑功能。
- 用户校正（2026-09-04）：编辑抽卡人设后仍应按抽卡来源展示，并使用真实 `SOUL.md` 的最新 `Name`，不得误标为自定义上传。
- 用户确认（2026-09-04）：当前已注入卡片标题与摘要统一使用真实 `SOUL.md` 的最新 `Name`，其他卡片名称不变。
- 用户补充（2026-09-04）：顶部 `Name:` 作为页面展示名称；编辑保存缺失时提示，上传检测建议说明该字段用途。
- 用户最终选择（2026-09-04）：抽卡人设保存编辑后转为自定义人设，并开放自定义人设的下载能力。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`：`drawnSouls`、`appliedSlug`、`customPersonaName`。
- 不变量：真实 `SOUL.md` 身份读取继续决定已注入 slug；自定义人设仍独立展示编辑和下载操作。

## history_context
- `current_design_refs`：`frontend/openspec/specs/buddy.md`。
- `relevant_evolution`：自定义人设状态已复用真实 `SOUL.md` 身份刷新；推荐人设已有卡片徽章，但缺少卡片下方摘要。
- `superseded_refs`：无。

## acceptance
- 推荐人设写入成功后显示“已注入：<本地化人设名>”。
- 页面刷新后，真实 `SOUL.md` slug 匹配已抽卡片时恢复同一摘要。
- 测试推荐注入复用同一逻辑。
- 自定义人设摘要和编辑/下载按钮保持不变。
- 推荐人设摘要显示编辑按钮；保存修改后保留原 `Slug` 供文件追溯，同时写入自定义来源标记，摘要切换为“自定义人设”，并显示下载按钮。
- 当前已注入卡片标题与摘要名称一致；未注入卡片继续显示目录名称。
- 编辑器缺少顶部 `Name:` 时保存被提示并暂停；上传检测建议明确 `Name:` 用于页面展示，正文同名描述不算顶部元数据。
- 聚焦组件测试、i18n、类型检查和差异检查通过。

## affected_paths
- `docs/engineering/domains/site-environment-routing.md`
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/agent-custom-persona-file-modal.tsx`
- `frontend/src/pages/marketing/agent-persona-upload.ts`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/openspec/specs/buddy.md`
- `frontend/src/i18n/generated/*`

## required_context
- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@3ea210486` | 仓库 P0 边界与 Task Pack 规则 | 约束修改、验证和外部操作 |
| `frontend/AGENTS.md@3ea210486` | 前端服务门禁 | 确定组件测试、类型和构建要求 |
| `docs/context/project/services/frontend.md@revision-2.1.0` | 路由 must_read | 确认双站 UI 与 OpenSpec 权威边界 |
| `docs/context/domains/site-environment-routing.md@revision-2.0.0` | 路由 must_read | 要求国内/国际站分别验证 |
| `docs/engineering/domains/site-environment-routing.md@3ea210486` | change-impact 正式设计 | 确认 locale 行为由前端测试证明 |
| `docs/engineering/journeys/dual-site-request-routing.md@3ea210486` | change-impact Journey | 避免把 UI 变更误报为部署完成 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@revision-1.0.0` | 前端邻接卡 | 定位 OpenSpec、测试和 i18n 生成入口 |
| `frontend/openspec/specs/buddy.md@3ea210486` | 当前 Buddy 行为规格 | 同步推荐人设摘要规则 |

## evidence
- 初始路由查询 `frontend soul persona page show injected persona summary for drawn persona as custom upload already does` 未命中；按规则转为 `agent-buddy-panel.tsx` 有界精确搜索。
- 精确路径路由命中 `frontend-product-surface`、`service-frontend`、`site-environment-routing`。
- RED：聚焦组件测试新增 2 条断言后，`2 failed / 29 passed`，均因推荐人设摘要缺失。
- GREEN（国内站）：`agent-buddy-panel.test.tsx` 共 `31 passed`。
- GREEN（国际站）：真实 `SOUL.md` slug 恢复摘要用例通过；直接抽卡用例被既有国际站夹具 `custom-persona-extra` 不存在于内置人设表阻挡，写入前报 `Soul detail not found`。
- `pnpm check` 通过：i18n 提取/结构/繁体、文档同步、MDX 与 TypeScript 均无新增错误。
- `validate_documentation.py` 通过：无损坏的一方链接、缺失 Context Pack 或未分类文档。
- `validate_change_impact.py --staged` 通过：`site-environment-routing` 的正式设计同步已满足。
- `git diff --check` 通过。
- 推荐人设编辑 RED：定向用例因缺少 `编辑人设文件` 按钮失败。
- 推荐人设编辑 GREEN：定向用例通过；完整 `agent-buddy-panel.test.tsx` 共 `32 passed`。
- 追加编辑功能后 `pnpm check` 再次通过，TypeScript 无新增诊断。
- 来源语义 RED：推荐人设编辑后被标为自定义上传，且真实 `SOUL.md` 的新 `Name` 被卡片目录名称覆盖；2 条定向用例失败。
- 来源语义 GREEN：2 条定向用例通过；4 个相关测试文件共 `91 passed`，覆盖推荐来源保留、真实 `Name` 回读及自定义上传既有行为。
- 最终 `pnpm check` 通过：TypeScript `0 new`；文档校验、差异检查及 5174 页面 HTTP 200。
- 卡片名称 RED：摘要已使用真实 `SOUL.md Name`，当前已注入卡片仍显示目录旧名称；定向用例失败。
- 卡片名称 GREEN：定向用例与完整 `agent-buddy-panel.test.tsx` 均通过（`33 passed`）；最终 `pnpm check` 继续保持 TypeScript `0 new`。
- Name 提示 RED：编辑器缺少顶部 `Name:` 时仍直接保存；定向用例因找不到提示失败。
- Name 提示 GREEN：上传解析、上传弹窗、当前文件编辑与 Buddy 面板 4 个测试文件共 `79 passed`；`pnpm check` 通过，新增提示在全部开放 locale 已落盘，TypeScript `0 new`。
- 编辑来源转换 RED：定向用例期望编辑抽卡后显示自定义摘要、下载按钮和来源标记，旧实现仍保留抽卡来源，`1 failed`。
- 编辑来源转换 GREEN：定向用例通过；上传标准化与编辑弹窗相关测试 `36 passed`。
- 最终回归：4 个相关测试文件 `79 passed`；`pnpm check` 通过，TypeScript `191 current / 276 baseline / 0 new / 85 resolved`；文档校验、change-impact、`git diff --check` 均通过，5174 页面 HTTP 200。

## risks
- `appliedSlug` 可能暂时找不到对应卡片：优先使用真实 `SOUL.md` 的 `Name`，缺失时才回退本地化卡片名称。
- 自定义人设与推荐人设状态互斥：继续以 `customPersonaName` 优先分流。
- 新中文源文案会影响所有开放 locale：使用项目 i18n 脚本生成，不手改 key 映射。

## validation
- `pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `pnpm i18n:extract`
- `pnpm i18n:zh-hant`
- `pnpm i18n:check`
- `pnpm typecheck`
- `pnpm check`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（有 staged 变更时）

## decisions
- 真实 `SOUL.md` 的 `Name` 作为推荐人设摘要第一来源，不新增服务端持久化字段；owner：本次实现。
- 推荐人设摘要显示编辑图标；一旦保存编辑即写入自定义来源标记，切换为自定义摘要并提供下载；owner：用户最终产品选择。

## scan_scope
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/openspec/specs/buddy.md`

## scan_output
- 精确搜索确认推荐人设已有 `appliedSlug` 和卡片徽章；仅自定义人设渲染卡片下方摘要。

## handoff
- 状态：实现与本地验证完成；抽卡人设保存编辑后转为自定义人设，未提交。
- 下一步：用户验收后再决定是否提交或创建 MR。
- 阻塞项：国际站直接抽卡的既有测试夹具与区域内置数据不兼容；不影响本次独立的刷新恢复验证，但不能宣称该路径国际站测试全绿。
