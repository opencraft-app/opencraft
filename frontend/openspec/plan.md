# Skills 页面去除 TEA SDK 依赖 Implementation Plan

**Goal:** 国内站与国际站的 Agent Skills 路由直接渲染 mono2 自有 Skills 面板，不再请求、执行或等待 TEA SDK runtime、scripts、styles，同时保持现有页面结构、文案、交互和技能管理能力不变。

**Source of Truth:** `wiki/prd-docs/2026-07-22-skills-page-sdk-decoupling.md`（当前位于文档 MR [!2470](https://git.woa.com/wisp/mono2/-/merge_requests/2470)，合入 `master` 后成为仓库内事实源）。

**Architecture:** 采用 PRD 已确认的方案 A。`agent-settings-page.tsx` 的 Skills 分支只向 `HermesAgentSkillsPanel` 传递 `botId`、`execDebugCommand` 和初始 section；模型与渠道继续复用现有 `loadTeaSdkRuntime()`。`HermesAgentSkillsPanel` 固化为 mono2 自有 `SkillsDemoPanel`，删除 SDK `SkillPanel` 回退、SDK 配置参数、DOM 兼容逻辑及仅服务旧回退的样式。

**Tech Stack:** React 19、TypeScript 5.9、Vite、Tailwind CSS 4、Vitest、Testing Library。

## 验收契约

- 国内站与国际站从新窗口直达 Skills 时，不因 Skills 分支请求或执行 `@tencent/tea-sdk-lightclaw` runtime、scripts、styles；SDK 加载失败不阻断 Skills 页面。
- `Skills`、`Experts`、`Installed`、`Create Skill` 及搜索、精选、分类、详情、安装、卸载、已安装列表保持现状；双站继续使用各自现有数据源和 ACLI 命令。
- Skills 链路不再接收或引用 SDK `SkillPanel`、instance、feature flags、product config，也不保留未正式使用环境的 SDK 回退。
- 模型与渠道页面继续按需加载 SDK，现有加载态和错误态不受影响。
- 不新增路由、接口、依赖、埋点、文案或视觉调整；现有 i18n、无障碍和响应式行为不得回退。
- 相关单测、类型检查、i18n 检查、差异检查及国内/国际站浏览器回归全部通过。

## 范围约束

- 不从 frontend 全局删除或升级 `@tencent/tea-sdk-lightclaw`。
- 不改造模型、渠道页面，不改变 SkillHub、ClawHub、skills.sh 或 `execDebugCommand` 契约。
- 不顺带调整 Skills 页面 UI、文案、信息架构、安装逻辑或错误处理。
- 文档 MR !2470 未合入不阻塞代码实现，但开发 MR 合入前应确保 PRD 路径在目标分支可用。

## 任务清单

- [x] 1. 以测试驱动方式解除 Skills 路由的 SDK 加载与组件依赖，并完成双站回归。
  - 角色：Developer + Reviewer
  - 影响文件：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/pages/marketing/agent-skills-panel.tsx`、`frontend/src/pages/marketing/agent-settings-sdk-stable-host.tsx`、`frontend/src/pages/marketing/__tests__/agent-skills-panel.test.tsx`、`frontend/src/styles.css`
  - 接口变更：将 `HermesAgentSkillsPanelProps` 收敛为 `botId`、`execDebugCommand`、`initialSectionSlug?`；`TeaSdkRuntime` 与 `TeaSdkSettingsPanelReady.kind` 只保留 channel/model。
  - RED：先增加 Skills SDK 边界回归断言，确认当前源码仍存在 `HermesAgentSkillsRuntimePanel`/`runtime.SkillPanel` 而失败；同时把组件测试调用改为不传 SDK props，锁定 Skills/Experts/Installed/Create Skill 现有行为。
  - GREEN：让 Skills active section 直接渲染 `HermesAgentSkillsPanel`；删除 Skills 专用 runtime wrapper、`TeaSdkRuntime.SkillPanel`、skill kind 分支和参数组装；把 `HermesAgentSkillsPanel` 固化到 `SkillsDemoPanel`，删除 MutationObserver、placeholder 兼容、SDK fallback 与失效 state；清理只被 `.lv-agent-skills-sdk-panel` 使用的样式，保留模型/渠道 SDK 代码和可能仍被其他面板使用的共享 SDK 样式。
  - REFACTOR：用 `rg` 复核 Skills 链路不存在 `SkillPanel`、`HermesAgentSkillsRuntimePanel`、`.lv-agent-skills-sdk-panel` 或 SDK 配置透传；避免为测试新增生产态抽象，避免扩大到 SDK 包级依赖清理。
  - 自动验收：`pnpm exec vitest run --config vitest.config.ts src/pages/marketing/__tests__/agent-skills-panel.test.tsx`、`pnpm check`、`pnpm i18n:check`、`git diff --check` 全部 exit 0。
  - 浏览器验收：分别以国内站和国际站模式新开 Skills 路由，检查当前可见标签及搜索、详情和已安装列表；在资源清单中确认 Skills 首次加载没有由 Skills 分支触发 TEA SDK runtime/scripts/styles；再切换模型页，确认它仍可加载 SDK 并正常展示。安装/卸载等有状态操作由既有组件测试覆盖，浏览器验收不修改真实 Agent 状态。

## 执行与评审策略

- 规模：S（单一行为边界，5 个文件、无新依赖/API/设计）；执行模式：single_agent；review：quick；archive：light。
- 基线：隔离 worktree 中目标测试已通过，1 个测试文件、6 个用例全部 PASS。
- 分支：`frontsandbox/skills-sdk-decoupling`；工作区：`/Users/pablozhong/codex/lightvela-skills-sdk-decoupling`。
- 能力：不依赖 Figma、TAPD 写入或专用 E2E capability；浏览器回归使用当前可用的本地浏览器验证能力。
- 评审重点：Skills 直达不加载 SDK、模型/渠道不回归、SDK 专用遗留代码清理完整、没有 UI/文案变化。

## 规划门禁

- 需求范围、排除项、方案 A 和 12 条 PRD 验收标准均已确认，无未实现的接口、设计或公共组件前置依赖。
- 已读取 frontend P0 规范、FE-AI 规模规则、OpenSpec 上下文和规划门禁；当前无需要重复设计的同类 active spec。
- 计划保留 1 个可独立验收的任务，文件归属明确，不使用多 Agent，不存在共享状态并发写入。
- `feai` CLI 在当前环境不可用，因此 usage context 与 runtime summary 尚未写入；按工作流作为非阻塞降级，待用户确认计划后手工刷新 runtime summary 再进入实现。
- 规划门禁结论：**有条件通过**；唯一条件是用户确认本计划，确认后进入实现阶段。

---

# 成就页 P1 稳定性修复 Implementation Plan

**Goal:** 修复成就页请求竞态、命令无超时、payload 校验不足和自定义 Hermes 安装路径不一致问题。

**Architecture:** 保持现有 UI、Repository 接口和插件桥接结构，仅在数据层收紧契约、在命令层统一根目录、在组件层增加最新请求保护。每个行为先通过聚焦测试复现，再写最小实现。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、BotRepository。

## Global Constraints

- 超时固定为 `300_000` 毫秒。
- 不新增依赖、公共 API、文案或视觉变化。
- 数组中的单条非法成就继续过滤；仅字段整体缺失或非数组时报错。

## 任务清单

- [x] 收紧 payload 契约，并为成就命令增加 5 分钟超时。
- [x] 从 `HERMES_HOME` 统一派生插件目录与 Python 虚拟环境路径。
- [x] 使用请求序号防止旧 Agent 请求覆盖当前成就状态。
- [x] 补充非法 payload、超时、自定义路径和 Agent 切换竞态测试。
- [x] 完成聚焦测试、类型检查、i18n 检查和差异检查。

## 验证结果

- 聚焦 Vitest：2 个测试文件、17 个用例通过。
- `pnpm check`：通过。
- `pnpm i18n:check`：通过，1925/1925 条翻译完整。
- `git diff --check`：通过。

---

# Agent 记忆页 P1 稳定性修复 Implementation Plan

**Goal:** 修复记忆页的 Hermes 路径、YAML/payload 契约、命令超时、跨 Agent 保存竞态、并发保存和部分成功提示六类 P1 稳定性问题。

**Architecture:** 保留 `debug/exec` 桥接；数据层统一命令与严格契约，独立纯模块编排保存阶段，React 页面仅维护请求作用域、互斥 UI 和结果展示。

**Tech Stack:** React 19、TypeScript 5.9、Vitest 4、Testing Library、BotRepository。

## 任务清单

- [x] 1. 以 TDD 加固记忆读取命令、YAML/file 语义、固定 JSON 标记、严格 payload 和 120 秒读取超时。
  - 角色：Developer + Reviewer
  - 影响文件：`src/pages/marketing/agent-memory.ts`、`src/pages/marketing/__tests__/agent-memory.test.ts`
  - RED：先补自定义 `HERMES_HOME`、YAML 行尾注释、文件错误、标记解析和非法 payload 测试并确认失败。
  - GREEN：最小修改命令与 parser，通过显式 `botId` 数据访问函数接入读取超时。
  - 验收：聚焦 Vitest 通过，命令不再硬编码根目录，非法数据不再静默回退。

- [x] 2. 以 TDD 实现可测试的保存编排，区分 failed/success/partial 并覆盖 config/restart/read 超时。
  - 角色：Developer + Reviewer
  - 影响文件：`src/pages/marketing/agent-memory-save.ts`、`src/pages/marketing/__tests__/agent-memory-save.test.ts`
  - RED：先覆盖配置前失败、配置后各阶段失败、完整成功和显式超时并确认失败。
  - GREEN：实现最小判别联合状态机，不依赖 React、不回滚已保存配置。
  - 验收：保存编排聚焦测试通过，所有结果与阶段边界可判定。

- [x] 3. 接入 Agent/request 作用域和双卡片保存互斥，完成聚焦回归与最终验证。
  - 角色：Developer + Reviewer
  - 影响文件：`src/pages/marketing/agent-settings-page.tsx`、相关 `__tests__` 测试、必要的 i18n 生成文件
  - RED：先锁定切换 Agent 后旧保存不更新 UI、保存期间无法二次提交、partial 提示不宣称失败。
  - GREEN：页面最小接线，所有 state/toast 更新同时校验 botId 与 requestId。
  - REFACTOR：只抽取局部 helper，避免扩大大型设置页重构。
  - 验收：目标 Vitest、`pnpm check`、`pnpm i18n:check`、`git diff --check` 和本地页面 smoke 全部通过。

- [x] 4. 以 TDD 为 PyYAML 缺失场景补充明确的运行环境错误提示。
  - 角色：Developer + Reviewer
  - 影响文件：`src/pages/marketing/agent-memory.ts`、`src/pages/marketing/__tests__/agent-memory.test.ts`
  - RED：先断言读取命令捕获 `ModuleNotFoundError` 并输出可操作的 Hermes runtime 修复提示。
  - GREEN：仅包装 `yaml` 导入，不改变标准 Hermes venv、系统 Python fallback 或读取契约。
  - 验收：聚焦 Vitest、`pnpm check`、`pnpm i18n:check` 和 `git diff --check` 通过。

## 约束

- 超时固定为 `120_000` 毫秒。
- 不新增依赖、后端 API 或视觉改版。
- 不处理 P2 埋点字段问题。
- 不提交、推送或创建 MR，除非用户后续明确授权。

## 执行策略

- 规模：M；每批最多 3 个任务；单 Agent 执行。
- 现有两个已完成但未归档计划保留，不覆盖、不混入本次代码范围。
- 详细设计、提案和技术规格位于 `openspec/changes/2026-07-23-memory-p1-hardening-*.md`。
- 规划门禁：用户已确认设计与继续执行，无新接口、设计稿或 capability 前置依赖；进入 TDD 实现。

## 验证结果

- TDD RED：读取契约新增测试初始 12 项失败；保存编排模块缺失；页面作用域/互斥/partial 边界新增 6 项失败。
- 聚焦 Vitest：3 个测试文件、37 个用例全部通过。
- `pnpm check`：通过。
- `pnpm i18n:check`：通过，1923/1923 条源文案已翻译。
- `git diff --check`：通过。
- 全量 Vitest：105 个文件、1166 个用例通过；9 个既有 Datong/Account 用例失败，另有 1 个 worker OOM，均不涉及本次改动文件。
- 页面 smoke：`/agents/memory/` 在 webpack dev 模式编译成功并返回 200；本地浏览器无登录态，只验证到登录门禁，未执行任何真实配置修改或网关重启。
- GitNexus CLI：当前环境未安装，无法执行导出函数影响面命令；已通过 `rg`、TypeScript 和聚焦引用测试核对影响范围。

---
