# `/feai-init` — 项目初始化（AGENTS.md 轻量补充 + OpenSpec specs + project.yaml context）

> 通过 AI 对话式分析项目代码和配置，一站式完成：
> 1. 填充 `AGENTS.md` 第九章「项目深度信息索引」中的常用命令 / 代码风格 / 路径别名三个子表（仅探测，不岭入业务）
> 2. 更新 `.workflow/project.yaml` 的 `context:` 段落（项目上下文：技术栈、路由、状态管理、API、公共组件、目录结构等）
> 3. 生成/更新 `openspec/specs/` 各功能模块的 spec 文档
>
> v3.1.0 调整：AGENTS.md 不再作为项目深度信息的存储载体（避免与 project.yaml 重复），只做载体凅轻的「去哪里查」索引。项目结构/路由/状态管理/API 等不再写入 AGENTS.md，统一交给 project.yaml `context:` 段。

---

## 强制约束（最高优先级）

- ❌ 禁止覆盖用户手动编辑的章节（详见下文「智能合并策略」）
- ❌ 禁止越界扫描 `projectRoot` 之外的目录（前后台同仓场景下严禁污染后台代码）
- ❌ 禁止编造未在代码中实际存在的模块、路由、API、组件
- ❌ 禁止跳过任一 STEP（违反 G18）
- ❌ 禁止将分析产物写入 `openspec/`、`AGENTS.md`、`.workflow/project.yaml` 之外的路径（违反 G21）
- ❌ 禁止重写 AGENTS.md 章节一～八（这些是 `feai install` 维护的轻量门户内容，不归 `/feai-init` 管）
- ❌ **禁止在 AGENTS.md 中陈列项目业务目录结构 / 路由表 / 状态树 / API 列表等深度业务上下文**（v3.1.0）—— 这些一律写入 `.workflow/project.yaml` 的 `context:` 段
- ✅ 每一步必须输出 `[STEP N/6]` 格式的步骤追踪（G20）
- ✅ 探测不到的字段在产物中标注 `<待用户补充>`，不允许虚构

---

## 📋 为什么需要这个命令？

`feai install` 生成的 `AGENTS.md` 只是**轻量门户**，不包含项目深度信息；`.workflow/project.yaml` 的 `context:` 段落也只有项目名与默认分支。这些深度信息需要 AI 分析项目代码才能准确生成：

| 信息类型 | 示例 | 来源 | 写入目标 |
|---------|------|------|----------|
| **常用命令** | `pnpm dev`、`pnpm test:unit` | `package.json` scripts | AGENTS.md 第九章「常用命令」子表 |
| **代码风格** | 单引号、尾逗号 es5、行宽 100 | `.prettierrc`、`.eslintrc` | AGENTS.md 第九章「代码风格」子表 |
| **路径别名** | `@components` → `src/components/` | `tsconfig.json` paths | AGENTS.md 第九章「路径别名」子表 |
| **项目结构上下文** | Monorepo 包结构、目录职责 | 目录扫描 + 代码分析 | `.workflow/project.yaml` `context:` 段 |
| **项目业务上下文** | 技术栈、路由、状态管理、API 层 | 代码分析 | `.workflow/project.yaml` `context:` 段 |
| **功能模块文档** | 各模块职责、API、组件 | 代码分析 | `openspec/specs/*.md` |

> 💡 **AGENTS.md 章节边界**：第一～八章是 `feai install/update` 维护的门户骨架（项目概览、核心铁律、上下文协议、文件索引、技能触发、能力包、命令速查、不可逆操作），`/feai-init` **不动**这些章节；只填充第九章中的三个小表（常用命令 / 代码风格 / 路径别名），**业务深度信息不写入 AGENTS.md**，统一进 `project.yaml` `context:` 段。
---

## 命令格式

```
/feai-init [选项]
```

### 参数说明

| 参数 | 说明 | 示例 |
|------|------|------|
| 无参数 | 全量分析，生成 AGENTS.md 第九章三个子表 + project.yaml context + openspec specs | `/feai-init` |
| `--agents` | 只填充 AGENTS.md 第九章中的常用命令 / 代码风格 / 路径别名 | `/feai-init --agents` |
| `--openspec` | 只更新 `.workflow/project.yaml` 的 `context:` 段 + 生成 `openspec/specs/` | `/feai-init --openspec` |
| `--section <名称>` | 只更新 AGENTS.md 第九章中的指定子表（`commands` / `style` / `paths`） | `/feai-init --section commands` |
| `--dry-run` | 预览生成内容，不写入文件 | `/feai-init --dry-run` |

### 使用示例

```bash
# 首次全量初始化（推荐在 feai install 之后运行）
/feai-init

# 只更新 AGENTS.md 第九章三个子表（commands / style / paths）
/feai-init --agents

# 只更新 .workflow/project.yaml 的 context: 段 + 生成 openspec/specs/
/feai-init --openspec

# 只更新 AGENTS.md 第九章中的常用命令子表
/feai-init --section commands

# 预览不写入
/feai-init --dry-run
```

---

## 执行流程（6 步）

收到 `/feai-init` 命令后，按以下流程执行：

### [STEP 1/6] 读取项目根目录

**必须**先读取 `.codebuddy/project.local.json` 中的 `projectRoot` 字段：

| `projectRoot` 值 | 含义 | 扫描基准路径 |
|-----------------|------|-------------|
| 字段不存在 / `""` / `"."` | 标准仓库 | 仓库根目录 |
| `"frontend"` / `"web"` / `"apps/admin"` 等 | 前后台同仓场景，前端代码位于子目录 | 仓库根目录 + projectRoot |

> 💡 **前后台同仓场景**：仓库同时包含前端和后台代码（不同目录、不同团队）。此时 AI 的分析、AGENTS.md、project.yaml、openspec/ 都**只针对前端子目录**，不扫描、不污染后台代码。

后续所有"读取配置文件"、"扫描项目结构"、"填充 AGENTS.md"、"更新 project.yaml"、"生成 openspec specs"操作，**路径基准都使用 `projectRoot`**。下文中的 `<base>` 均指代 `projectRoot` 解析后的实际基准路径。

### [STEP 2/6] 读取项目配置文件

自动读取以下文件（存在则读取，不存在则跳过，**路径基准 = `<base>`**）：

| 文件 | 提取信息 |
|------|---------|
| `<base>/package.json` | 项目名、scripts（dev/build/test/lint）、dependencies、devDependencies |
| `<base>/tsconfig.json` / `<base>/jsconfig.json` | 路径别名（paths）、编译选项（strict、jsx 等） |
| `<base>/.prettierrc` / `<base>/.prettierrc.js` / `<base>/prettier.config.js` | 代码格式化配置 |
| `<base>/.eslintrc` / `<base>/.eslintrc.js` / `<base>/eslint.config.js` | ESLint 规则摘要 |
| `<base>/jest.config.*` / `<base>/vitest.config.*` | 测试框架配置 |
| `<base>/vite.config.*` / `<base>/webpack.config.*` | 构建工具配置 |
| `<base>/pnpm-workspace.yaml` / `<base>/lerna.json` | Monorepo 配置 |

### [STEP 3/6] 扫描项目结构（仅为 project.yaml `context:` 服务）

```bash
# 扫描 <base>/src/ 或 <base>/packages/ 下的主要目录
# 识别 pages/、components/、hooks/、utils/、lib/、features/ 等
# 对于 Monorepo，识别各个包的职责
# ⚠️ 扫描结果仅用于写入 project.yaml `context:` 段的「目录结构」子项，AGENTS.md 不再写入
# ⚠️ 严禁越界扫描 projectRoot 之外的目录（如后台代码）
```

### [STEP 4/6] 深度代码分析（用于 project.yaml + openspec specs）

在 STEP 2、3 的基础上，进一步分析：

| 分析项 | 方法 | 输出 |
|--------|------|------|
| **路由结构** | 读取路由配置文件，识别一级/二级路由 | `project.yaml` `context:` 路由章节 |
| **状态管理** | 读取 store/reducer/slice 文件，识别数据模块 | `project.yaml` `context:` 状态管理章节 |
| **API 请求层** | 读取 api/services 目录，识别核心 API | `project.yaml` `context:` API 章节 |
| **公共组件** | 扫描 components/ 目录，识别组件职责 | `project.yaml` `context:` 公共组件章节 |
| **功能模块** | 按页面/路由模块划分，分析各模块职责 | `openspec/specs/*.md` 功能文档 |

### [STEP 5/6] 生成 / 更新产物

> 本步骤包含 AGENTS.md、project.yaml、openspec/specs/ 三类产物，均严格遵守「智能合并策略」段中的规则。

#### 5.1 填充 AGENTS.md 第九章中的三个子表

**仅修改第九章「项目深度信息」下面的表格中的**：

| 子表 | 来源 | 写什么 |
|------|------|--------|
| **常用命令**（可选附在表格下方作为 `bash` 代码块） | `package.json` scripts | 列出 `安装依赖 / 开发 / 构建 / 测试 / lint+typecheck` 五类常用命令，**不超过 6 行**；设计为指引型，仅列准常用命名，详细参数让 AI 去 `package.json` 现场查 |
| **代码风格** | `.prettierrc` / `.eslintrc` / `tsconfig.json` | `Prettier:` `ESLint:` `TypeScript:` 三行摘要，每行不超过 60 字符；保留模板内置的「通用编码原则」清单 |
| **路径别名** | `tsconfig.json` paths | Markdown 表格 \| 别名 \| 实际路径 \| |

> ⚠️ **严禁**在 AGENTS.md 中陈列业务目录树、路由表、状态树、API 列表等业务上下文。这些信息一律写入 `.workflow/project.yaml` 的 `context:` 段（见 5.2）。

#### 5.2 更新 `.codebuddy/.workflow/project.yaml` 的 `context:` 段

读取 `<base>/.codebuddy/.workflow/project.yaml`，**只修改 `context:` 这一段**，其它段（`schema` / `context_loading` / `multi_agent` / `capabilities` / `gates` / `dependencies` / `forbidden_tools` 等）原样保留。

`context:` 段使用 YAML 多行字符串（`context: |`）填充以下内容：

```yaml
context: |
  # 项目概述
  {从 package.json description + README.md 提取}

  # 技术栈
  - 框架: {从 dependencies 识别，如 React 19 + TypeScript}
  - UI 组件库: {从 dependencies 识别}
  - 状态管理: {从 dependencies 识别，如 Redux Toolkit / Zustand / Context}
  - 路由: {从 dependencies 识别，如 wouter / react-router-dom}
  - 语言: {从 tsconfig.json 识别}
  - HTTP 请求: {从 dependencies 识别，如 axios / fetch / @tanstack/query}
  - 测试: {从 devDependencies 识别}
  - 构建: {从 devDependencies 识别，如 Vite / Webpack}

  # 入口与初始化流程
  {从入口文件分析，如 client/src/main.tsx → App.tsx 的挂载与 provider 嵌套}

  # 路由结构
  {从路由配置文件分析，列出一级路由及对应页面组件}

  # 状态管理
  {从 store/slices/ 或 stores/ 目录分析，列出各 slice 职责}

  # API 请求层
  {从 api/services/ 目录分析，列出核心 API 模块}

  # 公共组件
  {从 components/ 目录分析，区分 ui/（基础库）与业务组件}

  # 目录结构
  {与 AGENTS.md 第十章保持一致}
```

#### 5.3 生成 / 更新 `openspec/specs/`

按功能模块生成 spec 文档，每个核心模块一个文件：

```
openspec/
├── specs/
│   ├── module-a.md          # 模块 A 功能规范
│   ├── module-b.md          # 模块 B 功能规范
│   └── ...
```

每个 spec 文件模板：

```markdown
# {模块名}

## 概述
{模块职责描述}

## 页面/路由
{该模块包含的页面和路由}

## 核心组件
{该模块的核心组件及其职责}

## 数据流
{该模块的状态管理和 API 调用}

## 业务规则
{该模块的核心业务逻辑}
```

### [STEP 6/6] 输出总结 + 待用户确认提醒

完成后输出：

```
✅ 初始化完成！

📄 AGENTS.md 第九章三个子表已填充：
   - 常用命令（5 类）
   - 代码风格（Prettier + ESLint + TypeScript 摘要）
   - 路径别名（N 个）

⚙️  .workflow/project.yaml `context:` 段已更新：
   - 项目概述 / 技术栈 / 入口流程 / 路由 / 状态管理 / API / 公共组件 / 目录结构

📐 openspec/specs/ 已更新：
   - specs/module-a.md
   - specs/module-b.md
   - specs/module-c.md

⚠️ 以下内容请你过目并按需修订（未探测到时已标 <待用户补充>）：
   - .workflow/project.yaml > context > 状态管理 / API 请求层（如项目结构特殊，AI 可能未识别全）
   - openspec/specs/*.md（AI 仅做基础梳理，业务规则需人工补充）
```

---

## 智能合并策略

当文件已存在时，采用以下策略：

### AGENTS.md 合并策略

| 位置 | 合并策略 |
|------|---------|
| 一～八章（门户骨架） | **保留不动** — 由 `feai install / update` 维护，`/feai-init` 严禁触碰 |
| 九、项目深度信息 → 常用命令子表 | **覆盖更新**，以最新 `package.json` scripts 为准 |
| 九、项目深度信息 → 代码风格子表 | **覆盖更新摘要部分**；「通用编码原则」清单原样保留 |
| 九、项目深度信息 → 路径别名子表 | **覆盖更新**，以最新 `tsconfig.json` paths 为准 |
| 用户在末尾追加的自定义章节（如十、十一…） | **保留不动**，追加内容写到这些章节之前 |

### `.workflow/project.yaml` 合并策略

| 段 | 合并策略 |
|----|---------|
| `schema` / `context_loading` / `multi_agent` / `capabilities` / `gates` / `dependencies` / `forbidden_tools` | **保留不动** — 由 `feai install / update` 与 `feai cap` 维护 |
| `context:` | **智能合并**：自动生成的子段（技术栈、路由、状态管理、API、公共组件、目录结构）覆盖更新；用户手动添加的自定义子段保留 |

### `openspec/specs/` 合并策略

| 文件 | 合并策略 |
|------|---------|
| `specs/*.md`（已存在） | **保留不动**，不覆盖用户编辑的 spec 文档 |
| `specs/*.md`（新模块） | **新增**，为新发现的模块生成 spec 文档 |

---

## 与其他命令的关系

```
feai install (init-project.sh)
         │
         ▼
  生成 AGENTS.md 门户骨架（一～八章）+ .workflow/ + .codebuddy/ + 空 openspec/
         │
         ▼
  /feai-init（本命令）
         │
         ▼
  填充 AGENTS.md 第九章中的三个子表（commands / style / paths）
  + .workflow/project.yaml context: 段（项目业务上下文）
  + openspec/specs/*.md
         │
         ▼
  /feai-start（开发时 AI 按 P0 协议读取 .workflow/project.yaml + openspec/）
```

> 💡 **推荐流程**：`feai install` → `/feai-init` → 开始开发

---

## 用户也可以手动补充

除了运行命令自动生成，用户也可以：

1. **直接编辑文件** — 手动添加 AI 无法探测的信息（如团队约定、业务规则、跨模块依赖）
2. **分步执行** — 先 `/feai-init --agents` 填充 AGENTS.md，再 `/feai-init --openspec` 更新 project.yaml + specs
3. **参考示例** — 参考 SkillHub、OrcaTerm 等成熟项目的 AGENTS.md 与 `.workflow/project.yaml`

