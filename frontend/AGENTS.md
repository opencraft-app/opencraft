# 📋 agent-platform-frontend — AI Agent 指引

> 本文件是 AI 助手在本项目中的**轻量门户**。详细规则按需从 `.workflow/` 与 `.codebuddy/skills/` 加载，**不在本文件展开**。
>
> ⚠️ 由 `frontend-ai-dev-tools` 公共模板生成。项目深度信息（技术栈、目录结构、路由、状态管理、API、公共组件等）由 `/feai-init` 写入 `.workflow/project.yaml` 的 `context:` 段，本文件不重复。
>
> 模板版本: v3.1.0 | 生成时间: 2026-06-09

---

## 一、项目概览

| 字段         | 内容                  |
| ------------ | --------------------- |
| **项目名**   | agent-platform-frontend      |
| **仓库**     | wisp/mono2（monorepo · 前端子目录 `frontend/`） |
| **默认分支** | master（国内站 + 国际站合一，编译期 `isCN`/`isGlobal` 区分） |
| **TAPD ID**  | 10132091 |

> 💡 技术栈 / UI 组件库 / 路由 / 状态管理 / 测试框架 / 目录结构 / 公共组件 等**项目深度信息**由 `/feai-init` 自动探测后写入 `.workflow/project.yaml` 的 `context:` 段（P0 必读），本文件不再重复维护。

---

## 二、核心铁律（精简版）

> 完整规则见 `.workflow/rules/global.md`（G1–G22）。此处仅列高频触发条款，AI 必须无条件遵守。

1. **OpenSpec 唯一事实来源** — 未读取 `openspec/` 前禁止写业务代码（G1/G2）
2. **plan.md 门禁** — 编码前 `openspec/plan.md` 必须存在 `- [ ]` 任务（G3）
3. **Stop-and-Ask** — 测试连续失败 3 次 / 遇未记录边界 → 立即停止询问（G4）
4. **上下文加载协议** — 行动前必须按 `project.yaml` 的 `context_loading` 完成 P0 加载（G5/G18）
5. **中文对话** — 所有对话用中文（G6）
6. **分支管理** — 禁止在 master 直接开发；切分支前若工作区有未提交变更，必须先让用户决定如何处理，禁止自动 stash / commit（G8）
7. **阶段门禁不可跳过** — 每阶段对照 `.workflow/checklists/gate-*.md` 检查（G10）
8. **Skill 调用强制** — 标注「调用 skill」处必须真实执行 `use_skill`，禁止口头承认后用自己的知识替代（G12）
9. **L 级 Leader 禁直写代码** — Leader 只调度审核，发现自己写组件/hooks/页面立即停止（G17）
10. **禁工具替代工作流** — 禁用 EnterPlanMode；规划产物只写到 `openspec/`，不允许 `.codebuddy/plans/` 或 `docs/plans/`（G19/G21）
11. **步骤追踪可视化** — 跨阶段流程必须输出 `[STEP N/M] {步骤描述}`，未输出即跳步违规（G20）
12. **未归档变更优先** — 启动新需求前若存在未归档的旧变更，**必须**先归档（`/feai-archive`）才能开始新流程（G22）

---

## 三、上下文加载协议（P0–P3）

| 级别 | 时机 | 必读文件 |
|:----:|------|---------|
| **P0** | 每次响应前**必读** | `.workflow/project.yaml`、`.workflow/rules/global.md`、`openspec/plan.md` |
| **P1** | 进入开发流程时按需 | `openspec/proposal.md` / `openspec/spec.md` / `openspec/current_state.md` |
| **P2** | 命中第五章「技能触发关键词」时 | 对应的 `.codebuddy/skills/team-extensions/*.md` |
| **P3** | 进入对应阶段门禁时 | `.workflow/checklists/gate-*.md` |

> 💡 看到本文件未覆盖的细节（commit 模板、CR 报告格式、E2E 验收场景等），**必须先去 skill 文件加载**，不要凭印象作答。

---

## 四、Harness 工程文件索引

```
AGENTS.md                          # 项目根 — AI 行为指引（本文件）

.workflow/                         # 工作流核心（IDE 中立，feai install/update 维护）
├── project.yaml                   # 工作流配置 + 项目上下文（context_loading / multi_agent / forbidden_tools）
├── agents/                        # 角色定义（default/leader/planner/implementer/developer/reviewer/figma-analyzer）
├── rules/
│   └── global.md                  # 工作流铁律 G1–G22（不可删，工作流"宪法"）
└── checklists/                    # 阶段门禁（gate-planning/implementation/verification/archive）

.codebuddy/                        # AI 工具能力（CodeBuddy/Claude/Cursor 通过软链共用）
├── skills/
│   ├── superpowers/               # Superpowers 原生 Skills（14 个）
│   └── team-extensions/           # 团队扩展 Skills（branch/mr/cr-check/单测/TAPD/FE-AI 跟踪 6 个）
├── project.local.json             # 本地项目配置（动态、不提交）
└── mcp.json                       # MCP 服务配置

commands/                          # 命令文件（IDE 中立）
├── feai-start.md                  # /feai-start
├── feai-archive.md                # /feai-archive
├── feai-init.md                   # /feai-init
└── feai-review.md                 # /feai-review

openspec/                          # 业务规范驱动开发（用户产物）
├── plan.md                        # 当前迭代执行计划（核心：- [ ] 任务列表）
├── proposal.md / spec.md          # 需求提案 / 技术规格（M/L 级需求）
├── current_state.md               # 项目当前状态快照
├── specs/                         # 功能规范库
└── changes/archive/               # 历史变更归档
```

> 💡 三大目录职责边界：`.workflow/` = 工作流核心 ｜ `.codebuddy/` = AI 工具能力 ｜ `openspec/` = 业务产物

---

## 五、技能触发规则

> 普通对话中（非 `/feai-*` 命令模式）AI 也必须在合适的时机加载对应 skill。**先读 skill，再执行操作**。

| 用户意图关键词 | 必须加载的 Skill |
|--------------|-----------------|
| 提交代码 / commit / git commit | `.codebuddy/skills/team-extensions/ai-usage-tracking.md`（FE-AI 标记）+ `.workflow/rules/global.md` G14 |
| 创建分支 / 切分支 / 新建分支 | `.codebuddy/skills/team-extensions/branch-auto-create.md` |
| 创建 MR / 合并请求 / merge request | `.codebuddy/skills/team-extensions/mr-auto-submit.md` |
| 代码审查 / CR / review / 检查代码 | `.codebuddy/skills/team-extensions/cr-check.md` |
| 写单测 / 单元测试 / 测试用例 | `.codebuddy/skills/team-extensions/unit-test-development.md` |
| 获取需求 / TAPD / 需求详情 | `.codebuddy/skills/team-extensions/tapd-requirement-fetch.md` |
| FE-AI 标记 / 数据采集 | `.codebuddy/skills/team-extensions/ai-usage-tracking.md` |
| MR 提了 / 推上去了 / MR 开好了 | `commands/feai-archive.md` — **主动询问**用户是否运行 `/feai-archive` |
| reviewer 改了 / CR 后改 / 评审意见改完 | `commands/feai-archive.md` — **主动提醒**重新归档 |

执行规则：① 多意图叠加时加载所有匹配 skill ② 无法读取时用本文件作为兜底 ③ 涉及代码开发时优先读 `.workflow/project.yaml`

---

## 六、按需能力（Capability）

> 主干工作流只包含 **OpenSpec + 三阶段门禁**。Figma 像素级还原、E2E 分级测试等场景规则被抽取为**可插拔能力包**，未启用时不存在、不生效。
>
> 看到 F1–F14、E2E 两段式流程、`gate-figma-implementer` / `gate-e2e` 等"额外规则"时，**不要当主干默认行为**——它们一定来自某个已启用的 capability。

### 6.1 排查路径

| 步骤 | 看什么 |
|---|---|
| 1️⃣ | `.workflow/project.yaml` 的 `capabilities.enabled: [...]` |
| 2️⃣ | `.workflow/project.yaml` 的 `gates.required: [...]`（含 capability 注入） |
| 3️⃣ | 终端运行 `feai cap status` / `feai cap list` |

### 6.2 能力包清单（v0.17+）

| 能力 ID | 启用后注入 | 主要硬性规则 |
|--------|----------|-------------|
| `figma-fidelity` | `figma-fidelity-*.md` 规则 + `gate-figma-implementer` 门禁 | F1 零编造 / 间距 ≤2px / 颜色一致 / Auto Layout 优先 / 截图+MCP 双通道回验 |
| `e2e-playwright` | `e2e-rules.md` + `gate-e2e` 门禁 | 两段式流程（Planner 写场景 / Reviewer 转代码，Developer 不写 E2E）/ P0/P1/P2 三级 |

### 6.3 e2e-playwright 启用后的特别约束（**极易踩坑**）

- ❌ **禁止**主动安装 `@playwright/test` 等 npm 包
- ❌ **禁止**修改使用方项目的 `package.json`、自动创建 `playwright.config.ts` / `tests/` / `e2e/` 目录骨架
- ✅ **只**做规则下发与 Reviewer 阶段的执行约束；Playwright 实际依赖由用户自行决定时机

> 📄 详细命令运行 `feai cap --help`

---

## 七、命令速查

| 命令            | 用途                                                         |
| --------------- | ------------------------------------------------------------ |
| `/feai-start`   | 启动开发流程（需求分析 → 开发 → MR）                         |
| `/feai-archive` | 归档沉淀（MR 提了之后；trigger G22）                         |
| `/feai-init`    | 项目初始化（生成深度信息：常用命令、目录结构、代码风格等）   |
| `/feai-review`  | 主动 CR（提交前对本次 git diff 做三级问题检查）              |

**常用参数**：`--quick` 快速 ｜ `--full` 完整 ｜ `--yes` 信任模式

> 📄 详见 [feai-start.md](commands/feai-start.md) ｜ [feai-archive.md](commands/feai-archive.md) ｜ [feai-init.md](commands/feai-init.md) ｜ [feai-review.md](commands/feai-review.md)

---

## 八、不可逆操作必须确认

即使 `--yes` 信任模式，以下操作仍**必须先展示内容、征得用户确认**：

- `git commit` / `git push` — 展示提交信息
- 创建 MR — 展示 MR 标题/描述/标签

---

## 九、项目深度信息（去哪里查）

> 本文件定位为**轻量门户**，不再罗列项目深度信息。具体内容请按下表索引：

| 想了解 | 去哪查 | 维护方 |
|-------|-------|-------|
| 技术栈 / 路由 / 状态管理 / API / 公共组件 / 目录结构 | `.workflow/project.yaml` 的 `context:` 段 | `/feai-init` 自动生成，可手工补充 |
| 常用命令（dev / build / test / lint） | `package.json` 的 `scripts` 段 | 项目自身 |
| 代码风格（Prettier / ESLint / TS strict） | `.prettierrc` / `.eslintrc*` / `tsconfig.json` | 项目自身 |
| 路径别名（`@/*` 等） | `tsconfig.json` 的 `paths` 段 | 项目自身 |
| 各功能模块业务规则 | `openspec/specs/*.md` | `/feai-init` + 用户补充 |

### 项目专属补充（package.json / tsconfig 查不到的）

以下信息项目独有、且无法从配置文件现场查到，**保留在 AGENTS.md**：

- **国内/国际站域名**
  - 国内预览：`https://<branch>.preview.lightclaw.tech`（`frontsandbox/<name>` 分支自动推流）
  - 国际预览：`https://lightvela-preview-hpthlnbc.edgeone.cool`
  - 生产 API：`https://lightclaw.tech`
- **主干分支策略**：`master` 同时承载国内 + 国际站，运行时通过 `src/lib/region.ts` 暴露的 `isCN` / `isGlobal` 编译期常量做差异化（构建时 Tree-shake，未命中分支不会进入产物）。
- **分支自动预览**：把分支推到 `frontsandbox/<name>`（命中 `frontend/**` 路径），CI 自动构建国内 + 国际双产物并发布到 StaticPages，约 2 分钟可访问，**评审/验证首选**，无需手工跑构建。
- **发布脚本**
  - 国际站：`pnpm deploy:eo`（EdgeOne Pages，可通过 `EDGEONE_PAGES_PROJECT_NAME` / `EDGEONE_PAGES_ENV` / `EDGEONE_PAGES_DIR` 覆盖）
  - 国内站：`python3 scripts/build-release-image.py --service frontend --env shprod --tag <tag>`（monorepo 根执行，走 Argo CD `shprod`）
- **GitNexus 影响面检查约定**（来自仓库根 `CLAUDE.md`）
  - 改动**导出的**函数/组件/类型前：`gitnexus_impact({target: "<symbol>", direction: "upstream"})`
  - 提交前：`gitnexus_detect_changes()` 确认范围
  - 仅改 JSX 内闭包函数 / 单文件 helper / 文案字面量时**可跳过**
- **质量门禁（提交前必跑）**：`pnpm check`（tsc -b）+ `pnpm test`（vitest）+ `pnpm i18n:check`（CI 翻译完整性门禁）

### 通用编码原则（与具体项目无关，永久有效）

- 🚫 禁止 `any`：使用 `unknown` 或具体类型替代
- ✅ 复杂逻辑添加 JSDoc 与行内注释
- ✅ 异步操作必须 `try/catch/finally`，禁止静默失败
- ✅ 新代码遵循项目现有命名/目录组织（参考相邻文件）
- ✅ 编码风格以项目自身的 `.eslintrc` / `.prettierrc` / `tsconfig.json` 为准

### `@tencent/tea-sdk-lightclaw` 配置来源

OpenClaw settings 页内嵌的是 `@tencent/tea-sdk-lightclaw`，模型列表、通道列表、OAuth 模型等基础配置默认来自 SDK 的 `createLighthouseConfig(...)` / `productConfig`，不要在 `openclaw-settings-page.tsx` 等宿主页面里临时 patch 或重排这些配置。

遇到“新增 / 调整模型、通道、Coding Plan、后付费 API 列表”等需求时，按这个顺序处理：

1. 先确认 SDK 源码和已发布版本是否已经包含变更（重点查 SDK 的 `src/common/utils/moltbot.ts`、`src/common/config/defaultProductConfig.ts`）。
2. 如果 SDK 已发布，前端只升级 `@tencent/tea-sdk-lightclaw` 依赖和 `pnpm-lock.yaml`，并移除宿主侧重复配置。
3. 如果 SDK 未发布，先在 SDK 仓库改配置、构建/发布新版本，再回到本项目升级依赖；不要把 SDK 内部配置复制到 LightVela。
4. 验证时除了 `pnpm check` / `pnpm i18n:check` / 构建，还要检查 `node_modules/@tencent/tea-sdk-lightclaw/{lib,es}` 产物中的实际配置，确认消费到的新 SDK 生效。

典型反例：为了让 MiniMax M3 出现在 Coding Plan 和后付费 API 列表，直接在宿主侧新增 wrapper 重写 `modelProviders`。正确做法是消费包含该配置的 SDK 版本，例如将 SDK 从 `1.2.2` 升到已发布的 `1.3.0`。

---

<!--
模板变量说明（供 init-project.sh 使用）:

| 变量                  | 说明               | 来源                                          |
| --------------------- | ------------------ | --------------------------------------------- |
| agent-platform-frontend      | 项目名称           | 自动检测 package.json `name`                  |
|     | Gongfeng 仓库路径  | 自动检测 git remote                           |
| （待手动填写到 .codebuddy/project.local.json） | TAPD 项目 ID       | 用户在 project.local.json 中手动填写          |
| master    | 默认分支           | 自动检测 git symbolic-ref                     |
| 2026-06-09      | 生成时间           | date '+%Y-%m-%d'                              |

v3.2.0（移除项目深度字段）：
- 表格中删除 TECH_STACK / UI_LIB / ROUTER / TEST_FRAMEWORK 4 个字段
- 这些字段统一交由 `/feai-init` AI 探测后写入 `.workflow/project.yaml` 的 `context:` 段
- 避免在 install / init-project.sh 阶段询问用户、产生不准确的硬编码值
- 模板渲染中保留 {{TECH_STACK}} / {{UI_LIB}} / {{ROUTER}} / {{TEST_FRAMEWORK}} 占位符语法的 sed 替换以兼容旧版本

v3.1.0 重构说明（breaking change，深度对齐 skillhub/AGENTS.md 极简风格）：
- 章节数 12 → 9；行数 ~265 → ~120
- **删除第十章「项目结构」** —— 业务目录与模块组织已在 `.workflow/project.yaml` 的 `context:` 段（P0 必读，AI 一定加载），AGENTS.md 不再重复
- **合并第九（常用命令）/ 十一（代码风格）/ 十二（路径别名）为新第九章「项目深度信息（去哪里查）」** —— 改为索引型：直接告诉 AI 去 `package.json scripts` / `.prettierrc` / `tsconfig.json paths` 现场查，不再让 `/feai-init` 把这些信息抄一份到 AGENTS.md
- 「通用编码原则」（禁 any 等永久有效条款）保留在第九章末尾

v3.0.0（已被 v3.1.0 取代）：从 15 章精简到 12 章，铁律编号修正为 G1–G22，新增 P0–P3 上下文加载协议。
-->
