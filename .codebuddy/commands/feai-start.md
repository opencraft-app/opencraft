# `/feai-start` — 启动开发流程

> 前端 AI 编程工具（frontend-ai-dev-tools）的核心开发入口命令。
> 整合 OpenSpec 上下文加载 + Superpowers 需求驱动开发 + 团队工具链（TAPD/MR/CR），一个命令启动完整开发流程。
>
> 📄 流程选择矩阵、信任模式、MCP 错误恢复等通用规范请参考 `AGENTS.md`。

---

## 强制约束（最高优先级）

- ❌ 禁止使用 `EnterPlanMode` / `ExitPlanMode` 替代本工作流（违反 G19）
- ❌ 禁止将规划产物写入 `.codebuddy/plans/` 或其他非 `openspec/` 路径（违反 G21）
- ❌ 禁止在 `openspec/plan.md` 通过门禁前编写任何业务代码（违反 G3）
- ❌ 禁止在主上下文里直接调用 Figma MCP 拉全量节点数据（必须通过 figma-analyzer sub-agent 派发）
- ❌ 禁止跳过 `git status` 前置检查就创建/切换分支（违反 G8）
- ❌ 禁止在存在未归档变更时直接进入 STEP 2，除非用户回复 `SKIP-ARCHIVE` 二次确认（违反 G22）
- ❌ 禁止跳过任一 STEP（违反 G18）
- ✅ 每一步必须输出 `[STEP N/8]` 格式的步骤追踪（G20）
- ✅ 完成 8 步规划后才进入「执行后续」（阶段 4B/4C/5/6）

---

## 命令格式

```
/feai-start [参数] <需求描述 | TAPD链接 | Story ID>
```

### 参数说明

| 参数      | 说明                                       | 示例                                  |
| --------- | ------------------------------------------ | ------------------------------------- |
| `--quick` | 快速修复模式（小 Bug、文案修改、样式调整） | `/feai-start --quick 修复按钮样式`    |
| `--full`  | 完整流程模式（大型需求、新模块）           | `/feai-start --full 新增批量导入功能` |
| `--yes`   | 信任模式（减少确认交互，仅保留需求确认）   | `/feai-start --yes 分析需求 xxx`      |
| 无参数    | 标准开发模式（AI 自动判断复杂度）          | `/feai-start 实现批量导入`            |

### 使用示例

```bash
# TAPD 链接
/feai-start 分析 https://tapd.woa.com/tapd_fe/10132091/story/detail/1010132091128613253

# Story ID
/feai-start 分析需求 128613253

# 文字描述
/feai-start 实现批量导入功能，支持CSV格式

# 快速修复 + 信任模式
/feai-start --quick --yes 修复列表的分页显示问题

# 完整流程
/feai-start --full 新增健康检查模块
```

---

## 路径基准（v0.6.0+ 多目录支持）

执行前**必须**读取 `.codebuddy/project.local.json` 中的 `projectRoot` 字段：

| `projectRoot` 值 | 实际路径基准 |
|-----------------|-------------|
| 字段不存在 / `""` / `"."` | `openspec/`、`package.json` 等位于仓库根目录 |
| `"frontend"` / `"web"` 等子目录 | `<projectRoot>/openspec/`、`<projectRoot>/package.json` |

下文中 `<base>` 均指代解析后的实际路径基准。

---

## 8 步门禁链（规划阶段）

### [STEP 1/8] 项目上下文加载 + 防遗忘扫描（L3 + L4）

> 对应规则 G1 / G5 / G18

#### 1.1 配置读取
1. 读取 `.codebuddy/project.local.json` → 解析 `projectRoot` 字段，确定 `<base>`
2. 读取 `<base>/.codebuddy/.workflow/project.yaml` → 加载工作流配置（`context_loading` 协议、`capabilities.enabled`、`gates.required`）与项目上下文（`context:` 段落中的技术栈、路由、模块）
3. 按 `context_loading` P0 清单加载必读文件（`<base>/AGENTS.md`、`<base>/.codebuddy/.workflow/rules/global.md`、`<base>/openspec/plan.md`、`<base>/openspec/current_state.md`）；P1 按需加载 `<base>/openspec/specs/` 中与本次需求匹配的模块

> 💡 `current_state.md` 是项目级"长期记忆"：包含上一个需求摘要 + 历史归档清单。读取它能让 AI 在启动新需求时获得跨需求的项目历史感（避免每次"从零开始"）。

#### 1.2 plan.md 状态判定（防丢失）

读取 `<base>/openspec/plan.md`（如存在），按下列三种情况之一处理：

| 情况 | 检测方式 | AI 行为 |
|-----|---------|--------|
| **A. 文件不存在 / 为空** | 文件不存在或仅有占位符 | 进入 STEP 2，正常启动新需求 |
| **B. 所有任务已完成 `[x]`** | grep `^\- \[ \]` 数量为 0 | 提示「上一个需求已完成，建议先 `/feai-archive`」，等待用户选择继续 / 归档 |
| **C. 存在未完成任务** | grep `^\- \[ \]` 数量 ≥ 1 | 提示「当前还有 N 个未完成任务」，提供"继续推进 / 搁置开新需求"选项 |

#### 1.3 防遗忘扫描 L3：未归档变更（G22 强约束）

扫描 `<base>/openspec/changes/`（**不含 archive 子目录**）：

```
⚠️  检测到 N 个未归档的历史变更（按 G22 必须先归档）：
    • <change-name-1>   （创建 X 天前）
    • <change-name-2>   （创建 Y 天前）

根据 global.md G22「未归档变更优先」规则，禁止在存在未归档变更时
直接进入新需求规划阶段。

请选择：
  [a]              全部归档（推荐）
  [1] / [2] / ...  仅归档指定变更
  SKIP-ARCHIVE     强制跳过（需在同一回复中说明跳过原因）
```

| 用户选择 | AI 行为 |
|---------|---------|
| `a` | 逐个执行 `/feai-archive <change-name>`，全部完成后进入 STEP 2 |
| 数字（如 `1`） | 归档指定变更后再次扫描；如还有未归档继续提示 |
| `SKIP-ARCHIVE <原因>` | 记录跳过原因到对话上下文，进入 STEP 2 |
| 其他（`s` / `skip` / `跳过` / 直接 `n` 等） | **不构成豁免**，再次提示并要求用户回复 `SKIP-ARCHIVE` 完整字面 |

**关键约束：**
- ❌ 仅回复 `s` / `跳过` / `skip` 不允许继续，必须明确字面 `SKIP-ARCHIVE`
- ❌ AI 不得替用户决定跳过，不得自作主张
- ✅ 跳过原因必须随 SKIP-ARCHIVE 一并提供，便于后续追溯

> 💡 未归档变更超过 7 天 → 提示框中追加 🔴「已超过 7 天未归档，建议优先归档」红色警示。

#### 1.4 防遗忘扫描 L4：归档过时检测

> 解决"reviewer 评审后改代码导致归档 spec 与代码不一致"问题。

触发条件（同时满足）：
1. `<base>/openspec/changes/<change-name>/archive/` 已存在
2. 当前分支**不是**主分支（`master` / `main`）
3. 归档 commit 之后又有业务代码 commit

检测命令（AI 执行）：

```bash
# 0. 主分支跳过
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" == "master" || "$CURRENT_BRANCH" == "main" ]]; then exit 0; fi

# 1. 解析 projectRoot
PROJECT_ROOT=""
if [ -f ".codebuddy/project.local.json" ]; then
  PROJECT_ROOT=$(python3 -c "import json; c=json.load(open('.codebuddy/project.local.json')); print(c.get('projectRoot',''))" 2>/dev/null)
fi
OPENSPEC_DIR="openspec"
[ -n "$PROJECT_ROOT" ] && [ "$PROJECT_ROOT" != "." ] && OPENSPEC_DIR="${PROJECT_ROOT}/openspec"

# 2. 定位归档 commit（基于文件路径，比 --grep 更可靠）
ARCHIVE_SHA=$(git log -n 1 --format="%H" -- "${OPENSPEC_DIR}/changes/${CHANGE_NAME}/archive/")

# 3. 反向排除归档目录/文档/测试，看是否有业务代码改动
SCOPE_PATH=""
[ -n "$PROJECT_ROOT" ] && [ "$PROJECT_ROOT" != "." ] && SCOPE_PATH="-- ${PROJECT_ROOT}/"
git diff --name-only "${ARCHIVE_SHA}..HEAD" ${SCOPE_PATH} \
  ":!${OPENSPEC_DIR}/changes/*/archive/" \
  ":!${OPENSPEC_DIR}/specs/" \
  ':!docs/' ':!*.md' \
  ':!**/__tests__/**' ':!**/*.test.*' ':!**/*.spec.*'
```

返回非空 → 展示 L4 提醒：

```
⚠️  检测到归档可能已过时：
    变更：<change-name>
    归档后又有 N 次业务代码 commit：
       • abc1234  fix: 增加 Excel 导入支持（评审反馈）
       • def5678  refactor: 优化导入错误提示

    [y] 检查并更新归档（推荐，自动追加 commit 到当前 MR）
    [n] 不需要（仅改了测试/文案/注释）
    [s] 跳过提醒
```

| 选择 | AI 行为 |
|-----|--------|
| `y` | 重新运行 `/feai-archive <change-name>`，追加 commit 到当前分支 |
| `n` | 当前分支内不再重复提醒 |
| `s` | 临时跳过 |

**产出物检查点：** ✅ projectRoot 已解析；✅ P0 文件加载完毕；✅ plan.md 状态判定完成；✅ L3/L4 扫描完成。

---

### [STEP 2/8] 需求获取（条件触发）

#### 2.1 输入识别
- TAPD 链接 / Story ID → 进入 2.2
- 文字描述 → 跳过 2.2，直接进入 STEP 3

#### 2.2 调用 `tapd-requirement-fetch` skill
1. 调用 skill 拉取 TAPD 需求详情
2. 调用 `ai-usage-tracking` skill **自动添加 FE-AI 标签**

**产出物检查点：** ✅ 需求详情已获取（TAPD）或 ✅ 已收到用户文字描述。

---

### [STEP 3/8] 插件依赖检查

> 对应规则 G16

1. 读取 `<base>/.codebuddy/.workflow/project.yaml` 中的 `dependencies.plugins` 配置
2. 逐一验证所需插件（尝试加载任一 skill 如 `brainstorming`）
3. 检测到缺失：
   - 输出：「⚠️ 检测到缺失插件：{插件名}，正在安装...」
   - 执行：`/install-plugin {name}@{source}`
   - 安装失败 → 停止流程，提示手动处理
4. 全部通过 → 输出：「✅ 插件环境就绪」

**产出物检查点：** ✅ 所有依赖插件可用，否则停止。

---

### [STEP 4/8] 分支管理（强制前置 git status 拦截）

> 对应规则 G8

#### 4.1 未提交变更前置拦截（强制）

```bash
git status --porcelain
```

**有任何未提交内容 → 立即停止**，禁止：
- ❌ 自动 stash
- ❌ 自动 commit
- ❌ 强制切换分支

输出：

```
⚠️ 检测到未提交的变更，无法继续创建新分支：
{git status --short 输出}

请选择处理方式：
1. 提交（commit）当前变更后再继续
2. 暂存（git stash）当前变更后再继续
3. 放弃（git checkout -- .）当前变更后再继续
4. 取消本次 /feai-start 流程
```

**必须等待用户明确选择并完成处理后**才能进入 4.2。**禁止替用户做决定。**

#### 4.2 调用 `branch-auto-create` skill
1. 检查当前分支
2. 如果在 `master` / `main`：
   - 解析 `currentuser`：`git config user.name` → 兜底 `whoami` → slug 化（小写、空格转 `-`、保留 `[a-z0-9-]`）
   - 创建分支：`feat/{currentuser}-{MMDD}-{slug}`
3. 如果已在 `feat/` 分支 → 跳过创建

**产出物检查点：** ✅ 工作区干净（或用户已处理完毕）；✅ 当前分支为 `feat/{currentuser}-{MMDD}-{slug}` 格式。

---

### [STEP 5/8] 需求规模判定 + Agent 模式选择

> 对应规则 G11 / G17

根据 brainstorming 前的初步评估或 `--quick` / `--full` 参数判定：

| 级别 | 判定标准 | Agent 模式 | OpenSpec 产物 |
|------|---------|-----------|--------------|
| **S** | 改动 ≤ 2 文件 / `--quick` | 单 Agent（default） | 仅 `plan.md` |
| **M** | 改动 3-5 文件 / 默认 | 单 Agent（default） | `proposal.md` + `spec.md` + `plan.md` |
| **L** | 改动 > 5 文件 / `--full` | 建议多 Agent（leader 调度） | `proposal.md` + `spec.md` + `plan.md` |

L 级需求额外提示：

```
📊 需求规模为 L 级（预计改动 > 5 文件）
   建议使用多 Agent 模式（leader/implementer/developer/reviewer 串行）。

是否切换到多 Agent 模式？
  [y] 是，唤醒 leader agent 进行调度（推荐）
  [n] 否，沿用单 Agent 完成
```

| 选择 | AI 行为 |
|-----|--------|
| `y` | 后续 STEP 6/7/8 由 leader 调度，违反 G17 → Leader 不得直接写业务代码 |
| `n` | 沿用 default agent 串联整个流程 |

**产出物检查点：** ✅ 规模级别已确定；✅ Agent 模式已确定。

---

### [STEP 6/8] 需求分析（brainstorming）

> 对应规则 G12（Skill 调用强制规则）

1. 调用 `brainstorming` skill（**强制 use_skill tool call**，不可口头跳过）
2. 按 skill 指导与用户完成苏格拉底式需求分析
3. 生成需求确认文档
4. ⏸️ **等待用户确认**，禁止跳过此步骤直接进入 STEP 7

> 快速修复模式（`--quick`）下，brainstorming 简化为一次性确认提问，不生成完整确认文档。

**产出物检查点：** ✅ 需求分析完成，对功能范围、边界、交互达成共识。

---

### [STEP 7/8] Figma 结构分析（条件触发，sub-agent 派发）

> ⚠️ 本步骤通过派发 **figma-analyzer sub-agent** 执行，目的是**隔离 Figma MCP 原始数据，避免污染主上下文**。
> 详见 `.codebuddy/.workflow/agents/figma-analyzer.md`。

#### 7.1 触发条件（自动检测）

满足以下任一即进入本步骤：
- 用户消息包含 `figma.com` URL
- brainstorming 阶段确认本需求涉及 UI 还原

**不满足 → 跳到 STEP 8**（纯逻辑/重构需求无需 Figma 分析）。

#### 7.2 派发 sub-agent

从用户消息或 brainstorming 结论提取：
- `figmaUrl`、`feature`（与分支名后缀一致的英文 slug）、`rootNodeId`、`scope`

通过 `Agent` 工具派发 `figma-analyzer`，prompt 模板：

```
你是 figma-analyzer sub-agent，参考 .codebuddy/.workflow/agents/figma-analyzer.md 执行 Figma 结构分析。

输入参数：
- figmaUrl: {url}
- feature: {feature-slug}
- rootNodeId: {nodeId}
- scope: {范围说明}

严格执行 3 个子任务：
1. 设计稿质量预检
2. Component 全局识别 → 写入 _components.md
3. 顶层 Section 分析 + 截图导出 → 写入 _overview.md + *.png

返回 < 500 字摘要，不返回 MCP 原始数据。
```

#### 7.3 等待 sub-agent 返回摘要 → 用户确认分批计划

```
📊 Figma 分析完成（详见 <base>/openspec/figma-specs/{feature}/）
{摘要内容}

请确认分批计划是否合理，确认后进入 STEP 8 生成 plan.md。
```

#### 7.4 降级处理
- Figma MCP 不可用 → sub-agent 返回失败摘要 → 提示用户启用 MCP 后重试
- 用户拒绝 Figma 分析 → 在 plan.md 中标注「未做 Figma 结构分析」，不阻塞流程

**产出物检查点：** ✅ `_overview.md` / `_components.md` / `*.png` 全部存在；✅ 用户已确认分批计划。

---

### [STEP 8/8] 生成 OpenSpec 产物 + 门禁检查

> 对应规则 G3 / G10 / G21

#### 8.1 调用 `writing-plans` skill（强制）

1. 按 STEP 5 判定结果生成产物：
   - **S 级**：仅 `<base>/openspec/plan.md`
   - **M / L 级**：`proposal.md` + `spec.md` + `plan.md`
2. **如果 STEP 7 已生成 `_overview.md`** → writing-plans 必须 Read 该文件，按 section 拆分 plan.md 任务

#### 8.2 plan.md 顶部强制注入「上下文产物索引段」（如有 Figma 分析）

```markdown
# 需求名: {标题}

## 上下文产物（Figma 分析阶段已生成，后续 agent 必读）

| 产物 | 路径 | 用途 |
|------|------|------|
| Section 总览 | <base>/openspec/figma-specs/{feature}/_overview.md | section 清单 / 分批 / 间距 |
| Component 映射 | <base>/openspec/figma-specs/{feature}/_components.md | 可复用组件 |
| 设计稿截图 | <base>/openspec/figma-specs/{feature}/*.png | F12/F13 视觉对照基准 |

## UI 还原阶段
- [ ] 任务 1: 还原 Hero section（参考 _overview.md 中 Hero 行）
- [ ] 任务 2: 还原 Stats section
...

## 逻辑接入阶段
- [ ] 任务 N: 接入 ...
```

#### 8.3 grep 硬校验（强制，违反即回退）

```bash
# 1. 检查至少有 1 条任务
grep -c "^\- \[ \]" "<base>/openspec/plan.md"
# 结果为 0 → plan.md 无效，禁止结束本流程，必须修正

# 2. 检查产物索引段（如适用）
grep -c "上下文产物" "<base>/openspec/plan.md"
# 结果为 0 且 STEP 7 有产物 → 必须补充
```

#### 8.4 门禁检查（gate-planning.md）

对照 `<base>/.codebuddy/.workflow/checklists/gate-planning.md` 逐项检查，输出门禁结论：**通过 / 打回 / 有条件通过**。

#### 8.5 等待用户确认 plan.md

⏸️ ⏸️ ⏸️ 用户确认前**禁止进入执行阶段**（违反 G3）。

**产出物检查点：** ✅ plan.md 存在且包含至少 1 条 `- [ ]` 任务；✅ 产物索引段已注入（如适用）；✅ gate-planning 门禁通过；✅ 用户已确认。

---

## 规划完成输出

```
📌 需求开启清单
├── ✅ 上下文：projectRoot={X}，P0 文件加载完毕
├── ✅ 防遗忘：L3 扫描{N}个未归档/L4 检测{已通过/已忽略}
├── ✅ 需求：{TAPD-128613253 / 文字描述}
├── ✅ 插件：依赖检查通过
├── ✅ 分支：{feat/xxx-MMDD-yyy}
├── ✅ 规模：{S/M/L}
├── ✅ 模式：{单 Agent / 多 Agent}
├── ✅ Figma 分析：{已完成 N 个 section / 不涉及}
├── ✅ OpenSpec：{产物列表}
└── ✅ 门禁：gate-planning ✅ 通过，等待用户确认
```

---

## 执行后续（plan.md 通过后才进入）

> 规划阶段（STEP 1-8）完成后，按以下顺序执行编码与发布：

```
阶段 4:  TDD 开发（test-driven-development → executing-plans）
              │
              ▼
阶段 4A: 每批任务（≤ 3 个）完成后调用 ⭐ /feai-review ⭐
              │
              ▼
阶段 4B: 关联 TAPD 分支（TAPD MCP add_git_branch_to_object）
              │
              ▼
阶段 4C: 主动 CR 检查 + 代码提交
         cr-check → P0/P1/P2 → git commit（按 global.md G14 + ai-usage-tracking 注入 FE-AI 标记）
              │
              ▼
阶段 5:  自检 → 创建 MR
         requesting-code-review → verification-before-completion → mr-auto-submit
              │
              ▼
阶段 6:  L1 强提醒 → 询问是否立即 /feai-archive 归档沉淀
```

### 快速修复模式（`--quick`）省略项

- ❌ STEP 1.3 / 1.4（L3 / L4 防遗忘扫描）
- ❌ STEP 6（brainstorming）— 改为简短确认
- ❌ STEP 7（Figma 分析）
- ❌ 阶段 4B（TAPD 分支关联）
- ❌ 阶段 6（L1 归档强提醒）

---

## 阶段 6：L1 防遗忘强提醒（MR 创建成功后）

```
🎉 MR 创建成功！

┌─────────────────────────────────────────────────┐
│  📐 下一步：归档沉淀（强烈推荐）                 │
├─────────────────────────────────────────────────┤
│                                                 │
│  ⚠️  不归档会发生什么？                          │
│    • 项目知识散落在各 MR 里，无法复用           │
│    • 下次 AI 开发时仍"不懂项目"                 │
│    • 团队无法形成知识资产                       │
│                                                 │
│  ✨ 立即执行（30 秒完成）：                      │
│                                                 │
│     /feai-archive                                │
│                                                 │
│  ➤ 是否现在归档？[Y/n]                          │
└─────────────────────────────────────────────────┘
```

| 用户回复 | AI 行为 |
|---------|---------|
| `Y` / `y` / 直接回车 | 立即执行 `/feai-archive` |
| `n` / `N` | 记录跳过，提示"已记录待办，下次 /feai-start 会扫描提醒" |
| 其他 | 视为未明确回复，再次简短询问一次 |

> ⚠️ 与 STEP 1.3 形成闭环：用户此时跳过 → 下次 `/feai-start` 旧账扫描会强制提醒。

---

## 失败处理

| 失败点 | 处理方式 |
|-------|---------|
| STEP 1 P0 文件加载失败 | 停止，提示用户检查 `<base>/openspec/` 目录 |
| STEP 3 插件缺失且安装失败 | 停止，输出手动安装指南 |
| STEP 4 工作区不干净 | 停止等待用户处理，禁止替用户决定 |
| STEP 6 brainstorming skill 未真实调用 | 视为违反 G12，回退重新调用 |
| STEP 7 Figma MCP 不可用 | sub-agent 返回失败摘要，提示启用 MCP 或继续无 Figma 模式 |
| STEP 7 sub-agent 产物缺失 | 重派一次；仍失败则降级（用户手动提供 section 清单） |
| STEP 8 plan.md 无有效任务 | 回到 STEP 6 或 STEP 8 重新生成 |
| STEP 8 plan.md 缺产物索引段 | 回到 STEP 8 补充 |
| STEP 8 门禁打回 | 回到对应步骤修正 |

---

## 数据来源

| 数据 | 来源 | 用途 |
|-----|------|-----|
| 项目根目录 | `.codebuddy/project.local.json` 的 `projectRoot` | 路径基准解析 |
| 项目上下文 | `<base>/.codebuddy/.workflow/project.yaml`（`context:` 段）+ `<base>/openspec/specs/*.md` | STEP 1 加载 |
| 已有变更 | `<base>/openspec/changes/` | STEP 1.3 / 1.4 扫描 |
| TAPD 需求 | `tapd-requirement-fetch` skill | STEP 2 |
| 插件清单 | `<base>/.codebuddy/.workflow/project.yaml` | STEP 3 |
| 当前分支/工作区 | `git status --porcelain` / `git branch --show-current` | STEP 4 |
| 用户名 | `git config user.name` → `whoami` | STEP 4 分支命名 |
| 检查清单 | `<base>/.codebuddy/.workflow/checklists/gate-planning.md` | STEP 8 |
