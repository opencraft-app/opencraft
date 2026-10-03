---
id: task-automation-card-actions-menu-2026-10-02
type: task
scope: 定时任务卡片操作菜单视觉调整。
triggers: ["automation card actions menu"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/agent-automations-panel.tsx
  - frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts
status: active
reviewed_at: 2026-10-02
review_due: 2026-11-02
revision: 1.0.2
precedence: task
derived: false
---

## goal
将定时任务卡片的省略号操作入口改为横向，并让悬停菜单以纵向“图标 + 操作名称”展示；将删除确认弹窗的操作按钮文字略微调小。

## non_goals
- 不改变任务执行、编辑、暂停、恢复、复制、删除的业务逻辑和可用条件。
- 不修改发布配置或线上环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-02 截图与请求：横向点点点；hover 后按钮框纵向展开；每项有 icon 和操作名称。
- 用户 2026-10-02 后续截图与请求：删除定时任务弹窗的按钮文案稍微小一点。
- 用户 2026-10-02 移动端截图与反馈：登录后点按定时任务卡片的横向省略号无反应。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 的 `CronJobCard` 和 `CronActionButton`；沿用 `CronJob` 状态门控和现有本地化键。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：当前 `origin/master` 使用 `EllipsisVertical` 和向左横向展开的纯图标操作；截图与源码一致。
- `superseded_refs`：无。

## acceptance
- 两类任务卡片都显示横向省略号。
- 当前任务菜单在按钮上方纵向显示测试运行、查看、复制、删除；已结束任务菜单显示查看、复制；各项同时显示图标和本地化名称。
- 桌面悬停、点击、移动端点按及键盘激活均可显示菜单；点按外部或按 Esc 可关闭；快捷操作与状态门控保持原样。
- 删除确认弹窗的“取消”和“删除”文字由 16px 调为 14px，保持 24px 行高。
- 聚焦组件测试、前端 lint/typecheck/test/build 门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/openspec/specs/marketing.md`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `frontend-product-surface`、`service-frontend`、`site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务边界 | 确认双站及验证门禁 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 站点上下文 | 确认共享 UI 与 locale 边界 |
| `frontend/AGENTS.md@HEAD` | 服务局部规则 | 确认代码和验证要求 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接卡 | 核对相邻 OpenSpec、测试、i18n |
| `frontend/openspec/specs/marketing.md@HEAD` | 当前设计 | 保持任务状态和操作约束 |
| `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts@HEAD` | 邻近测试 | 核对当前菜单行为及状态门控 |

## evidence
- 路由器对自然语言未匹配 Pack；有界精确搜索 `frontend/src/pages/marketing/agent-automations-panel.tsx` 命中实现。
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-automations-panel.test.ts --config vitest.config.ts`：199/199 通过。
- `pnpm check`：i18n 检查通过；TypeScript 166 current / 171 baseline，0 new；构建前的单独 `pnpm typecheck` 因尚未生成 `collections/server` 失败，`pnpm check` 生成 MDX 类型后解决。
- `pnpm build`：成功构建并生成静态页面。
- 后续字号调整后复验：聚焦测试 199/199、`pnpm check`、`pnpm build` 通过。
- 移动端点按修复后聚焦测试 199/199 通过；模拟触屏点按验证当前任务和已结束任务菜单均可展开，点按外部及 Esc 可关闭。
- `pnpm lint`：仓库没有 `lint` 脚本，命令返回 `Command "lint" not found`。
- `pnpm test`：全量运行遇到与本次菜单无关的多组失败，随后 Node 进程达到 4 GB 堆上限；中止前已出现文档和模型配置等失败。
- 国际站相邻测试与主测试一起运行：主测试通过 199/199，国际站测试 6/8 因测试环境缺少 `ResizeObserver` 失败。
- `validate_documentation.py --repo . --format json`：0 errors、0 broken links。
- `validate_context.py --build-catalog`：route smoke 0 failure；全仓多份既有 Task Pack 的元数据校验失败，需单独治理。
- `validate_change_impact.py --repo . --staged`：通过。
- `.agents/skills/context-audit/tests`：33/33 通过；`.agents/context/tests`：22/26 通过，4 个用例被全仓既有 Task Pack 元数据问题影响。

## risks
- 绝对定位菜单可能被小视口边缘裁切；右对齐并从靠近卡片底部的按钮上方展开，需用聚焦组件测试确认。

## validation
- `frontend/`：聚焦 Vitest、`pnpm check`、`pnpm build` 已通过；`pnpm lint` 无脚本，全量 `pnpm test` 与国际站相邻测试受上述既有问题阻塞。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 保留卡片底部原有快捷操作；只调整省略号菜单的视觉呈现，避免改变业务操作路径。
- 使用已有图标和翻译键，不新增 locale 生成内容。
- 后续弹窗字号调整只改共享按钮文字样式，保留按钮行高和操作逻辑。
- 移动端点按使用显式开关状态，保留桌面悬停，键盘通过 Enter/Space 激活按钮。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 及相邻测试与 OpenSpec。

## scan_output
- 无隔离扫描产物。

## handoff
- 菜单与文档已完成；在独立工作区保留未提交改动。未提交、未推送、未发布。
