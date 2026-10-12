---
id: task-contact-feedback-mr5190-20261012
type: task
scope: Review the supplied contact and feedback changes and append the safe subset to MR !5190.
triggers: ["contact feedback", "MR 5190"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal

把用户提供的联系与反馈补丁安全合入现有 MR !5190，保留其国际站中文 Bot 文档与截图改动。

## non_goals

- 不覆盖 MR 现有文件，不合并 MR，不发布页面。
- 不把国内站文档写成支持 Discord 或 WhatsApp；不修改国际站英文等其他文档正文。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户提供 `lightvela-contact-feedback-20261012.zip`，要求检查改动后一起提交到 !5190，并且不影响别的。
- MR: https://git.woa.com/wisp/mono2/-/merge_requests/5190

## interface_refs / data_structure_refs

- `frontend/next-site/support-page.tsx`：问卷联系方式仍选填；仅改可见邮箱提示与本地化文案，不改变提交 payload。
- `frontend/scripts/sync-fumadocs-content.mjs`：文档内 `/support` 按输出语言改写；`contact-us.md` 为双站不同源。

## history_context

- current_design_refs: `frontend/AGENTS.md`、`docs/context/project/services/frontend.md`、文档源及相邻测试。
- relevant_evolution: !5190 源分支 `codex/docs-bot-flow-cn-20261011` 已含国际站中文 Bot 文档与截图；压缩包补丁基于更旧提交，需三方合并。
- superseded_refs: 压缩包 `source/` 是快照，不能整体覆盖当前分支。

## acceptance

- 问卷只展示选填邮箱提示，现有提交与草稿流程保持；双站文档链接正确，国内站仅展示微信社群。
- 文档同步、聚焦测试、前端检查与 Agent Console 同步门禁有命令证据；只把相关文件提交推送到 !5190 源分支。

## affected_paths

- `frontend/next-site/support-page.tsx` 及相邻测试、`frontend/scripts/sync-fumadocs-content.mjs` 及相邻测试、双站中文 `contact-us.md`、文档日期与生成 manifest。

## required_context

- `tapd-gongfeng-delivery`、`site-environment-routing`、`service-frontend`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付门禁 | 确认源分支与检查 |
| `docs/context/domains/site-environment-routing.md` | 双站隔离 | 区分国内和国际社群 |
| `docs/context/project/services/frontend.md` | 服务真源 | 不编辑生成内容 |
| `frontend/AGENTS.md` | 前端门禁 | 测试与同步检查 |
| `frontend/DESIGN.md` | UI 规则 | 表单复用现有控件 |
| `.agents/skills/product-skills/lv-docs/SKILL.md` | 文档规则 | 保留摘要与区域适配 |
| `.agents/skills/gongfeng/SKILL.md` | 工蜂交付 | 明确 MR 写操作路径 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 相邻测试 | 检查本地化测试与生成入口 |

## evidence

- 2026-10-12：压缩包含 7 文件净补丁及源码快照；`git apply --3way --check` 显示 3 处冲突。远端 MR 源分支 SHA 与本地均为 `a2e4f55b2c`。
- 2026-10-12：双站联系页按地区保留社群入口；问卷邮箱仍选填，未改变提交数据结构；未纳入预览图、源码快照及构建生成字体。

## risks

- 直接覆盖源码会丢失 !5190 改动；通过三方补丁及逐处解冲突规避。
- 压缩包国内站文档含 Discord/WhatsApp，按双站能力移除。
- 压缩包删除 `## 摘要`，按文档规范恢复。

## validation

- `pnpm docs:sync`：630 个文档路由检查及 657 个文档同步通过。
- 聚焦测试：3 文件 83 测试通过；`pnpm check` 通过，新增类型错误 0；`npm --prefix opencraft run check:mono2-agent-console` 验证 136 文件通过。
- 国内站与国际站 `next build --webpack` 均通过。完整测试中其他模块存在失败；独立复现 `src/i18n/__tests__/dictionaries.test.ts` 的既有字典数量不一致，未改动字典文件。默认 Turbopack 构建耗时过久中止后改用 Webpack 构建确认。
- 提交前仍需运行 `git diff --cached --check`、`validate_change_impact.py --staged` 及文档 context 校验。

## decisions

- 用户明确指定加入 !5190；双站中文内容是这次交付范围。英文等其他正文保持现状，后续多语言任务另行处理。

## scan_scope

- 压缩包补丁的 7 个文件、MR 当前分支、联系页路由与相邻测试。

## scan_output

- 补丁暂存于 `/private/tmp/lightvela-contact-feedback-mr5190.patch`；不纳入 MR。

## handoff

- 当前处于最终暂存检查；未提交、未推送、未合并、未发布。

## checkpoint

### stage

代码与服务验证完成，下一步只暂存本任务文件并运行仓库 context 门禁，然后提交到 !5190 源分支。

### verified

- 双站构建、文档同步、聚焦测试、`pnpm check` 与 Agent Console 检查已通过。
- 首次对照的远端与本地源分支 SHA 相同；构建引入的无关文件已还原。

### unverified

- 远端源分支在推送时是否有新的提交；推送前会再确认。

### discard

- 压缩包的完整源码快照与预览文件不进入提交。

### restore

- 工作树：`output/docs-cn-review-20261011`；分支：`codex/docs-bot-flow-cn-20261011`；MR !5190。

### next_action

- 暂存指定文件，执行 diff 与 context 门禁，提交并推送。
