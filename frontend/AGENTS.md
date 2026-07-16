# agent-platform-frontend Agents

> P0 薄入口。只写硬边界和索引；长说明按需读取。本文件位于 monorepo `frontend/` 子目录，工作流核心在仓库根 `../.workflow/`。

---

## 默认读取

严格流程默认读 P0-Min：

1. [AGENTS.md](AGENTS.md)
2. [global.md](../.workflow/rules/global.md)（G1–G27 铁律）
3. 事实源：规划阶段 [plan.md](openspec/plan.md)；实现阶段 [current-task.summary.md](../.workflow/runtime/current-task.summary.md)（active slice + 当前批次 ≤3 任务，缺失从模板初始化、每批刷新），plan.md 仅按需校准。
4. 业务上下文：[config.yaml](openspec/config.yaml) 的 `context:` 段（技术栈 / 路由 / 状态 / API / 组件）。

> 🆕 新手先读 [GETTING-STARTED.md](../.workflow/GETTING-STARTED.md)（日常流程与目录含义）。

按需读取：

- 上下文预算：[context-budget.md](../.workflow/rules/context-budget.md)
- 配置 / 项目上下文：[project.yaml](../.workflow/project.yaml)
- 流程 / 成本 / 模型 / 恢复 / 用量审计：[workflow-strict.md](../.workflow/rules/workflow-strict.md)、[flow-cost.md](../.workflow/rules/flow-cost.md)（含模型分流）、[context-recovery.md](../.workflow/rules/context-recovery.md)、[workflow-reporting.md](../.workflow/rules/workflow-reporting.md)
- 输出 / 协作：[terminal-output.md](../.workflow/rules/terminal-output.md)、[team-state.md](../.workflow/rules/team-state.md)
- 项目地图 / 规格 / 变更历史：[current_state.md](openspec/current_state.md)、[specs/](openspec/specs/)、[changes/](openspec/changes/)
- 门禁 / 角色 / 命令：[gate-*.md](../.workflow/checklists/)、[agents/](../.workflow/agents/)、[feai-*.md](../.codebuddy/commands/)
- 团队技能：[team-extensions/](../.codebuddy/skills/team-extensions/)
- Codex repo skills：[.agents/skills/](../.agents/skills/)

---

## 开工纪律

- 中文沟通
- 新需求、跨阶段流程、高风险编码、commit / push / MR / review / archive 前进入严格流程。
- 写业务代码前确认 [plan.md](openspec/plan.md) 有有效 `- [ ]` 任务，且未超出 plan。
- 查分支；禁止直接在 `master` / `main` 开发新需求。前端分支默认挂 `frontsandbox/` 前缀（触发分支预览环境）。
- 检查 `git status --porcelain`；不要自动 stash、自动 commit 或回退未归属改动。
- 实现与验证完成后先停在用户验收点；用户明确确认前禁止自动 commit、push、MR/CR 或最终归档。
- 多人 / 多 Agent 写入前读取 [team-state.md](../.workflow/rules/team-state.md)，确认文件归属和共享状态单写者。
- 流程强度按 [flow-cost.md](../.workflow/rules/flow-cost.md) 的 S/M/L 分级（G18），小任务走轻流程，不一刀切最重流程。
- 严格流程按用户价值聚合进度；连续机械步骤不逐条播报，阻塞决策直接输出决策卡片。
- 早停（G4）：重复同一失败假设且没有新证据、需求边界漂移、文档与代码冲突，或缺少外部事实导致无法继续复现时触发 Stop-and-Ask；仓库内仍有安全证据可查时继续调查。
- 已有结论后的追问优先走 Targeted Verification（G26）：先沉淀 Investigation Brief，只传单个待验证问题、候选范围和成本检查点；证据不足时允许扩展，见 [agent-dispatch.md](../.workflow/rules/agent-dispatch.md)。
- 未归档变更为非阻断提醒（G22）：列出清单+风险请用户确认，不硬性禁止开始新需求。
- 命中 skill 触发词时必须真实读取并执行对应 skill，不用记忆替代。
- 长测试 / 构建 / lint 输出按 [terminal-output.md](../.workflow/rules/terminal-output.md) 用 tokenjuice 或摘要。
- 入口文件不要承载仓库 overview；能通过 `rg`、文件树或项目配置查到的信息不要复制到这里。

---

## 技能

commit / 分支 / MR / CR / 单测 / TAPD / token 用量等意图命中时，读取 [team-extensions/](../.codebuddy/skills/team-extensions/) 或 token usage skill。产品前置 / PRD 走 [prd-creator](../.agents/skills/product-skills/prd-creator/SKILL.md)（命令 `/prd-start`）。

---

## 边界

- `.workflow/` 是工作流单源；不迁移为 `.context/`。
- `openspec/` 是业务规范和计划单源；不迁移为 `.openspec/`。
- `.codebuddy/skills/` 与 `skills/` 体系保持原状。
- 项目深度信息见 [project.yaml](../.workflow/project.yaml)（context 软引用 [config.yaml](openspec/config.yaml)）。

---

## 项目专属补充（package.json / config.yaml 查不到的）

以下信息项目独有、配置文件现场查不到，保留在此：

- **国内/国际站域名**
  - 国内预览：`https://<branch>.preview.lightclaw.tech`（`frontsandbox/<name>` 分支自动推流）
  - 国际预览：`https://lightvela-preview-hpthlnbc.edgeone.cool`
  - 生产 API：`https://lightclaw.tech` / `https://api.lightvela.ai`
- **主干分支策略**：`master` 同时承载国内 + 国际站，运行时通过 `src/lib/region.ts` 的 `isCN` / `isGlobal` 编译期常量差异化（Tree-shake，未命中分支不进入产物）。
- **本地预览后端**：默认解析真实国际站后端，无需切 mock；涉及真实实例能力的页面优先用真实后端启动。
- **部署脚本**：国际站 `pnpm deploy:cf`（Cloudflare）/ `pnpm deploy:eo`（EdgeOne）；国内站走 monorepo 根 `python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>`（Argo CD）。
- **质量门禁**：`pnpm check`（tsc --noEmit）为基础门禁；`pnpm test` 按影响面运行；涉及文案 / i18n 资源运行 `pnpm i18n:extract` + `pnpm i18n:check`；当前无 `lint` 脚本。
- **`@tencent/tea-sdk-lightclaw` 配置来源**：控制台内嵌 SDK，模型/通道/Coding Plan 等基础配置来自 SDK 的 `createLighthouseConfig`，宿主页面不得临时 patch；新增配置先改 SDK 源码发版再升级依赖。
- **高风险页面**：`src/pages/marketing/agent-settings-page.tsx` 是 `/agents` 控制台主页（232KB），改动保持小步、局部、可验证，优先抽 helper + 补测试，不顺手做大重构。
- **UI 修改**：改设置页 / 控制台 / 弹窗 / tooltip / 共享视觉样式前先读 `DESIGN.md`，避免和既有圆角、弹窗间距、tooltip 约定冲突。
- **GitNexus 影响面**：改导出函数/组件/类型前 `gitnexus_impact({target, direction:"upstream"})`；提交前 `gitnexus_detect_changes()`；仅改闭包/helper/文案可跳过。
- **通用编码原则**：禁止 `any`（用 `unknown`）；复杂逻辑加 JSDoc；异步操作必须 `try/catch/finally`；新代码遵循相邻文件命名/目录组织。
