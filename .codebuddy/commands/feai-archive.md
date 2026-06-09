# `/feai-archive` — 归档沉淀

> 前端 AI 编程工具（frontend-ai-dev-tools）的归档沉淀命令。
> 一步完成 OpenSpec 的 propose → apply → archive 全流程，将开发成果沉淀为项目知识库。

> 💡 **归档不是一次性的**：首次归档后，如果 reviewer 评审导致代码又有变动，可以**再次运行** `/feai-archive` 更新归档产物，追加 commit 到同一个 MR。
> 这样即使代码经历多轮迭代，最终合并时 spec 与代码始终保持一致，**代码 + spec 原子性**进主分支。

---

## 强制约束（最高优先级）

- ❌ 禁止在所有任务标记为 `[x]` 之前归档（违反"知识沉淀真实性"原则）
- ❌ 禁止跳过「经验沉淀」段（关键实现决策、踩坑记录、技术选型理由必须落盘）
- ❌ 禁止跳过「业务文档同步」（项目有 `docs/` 目录则强制同步）
- ❌ 禁止跳过「工作区清理」（4 个状态文件未重置为占位语会污染下一次需求；current_state.md 未追加历史会丢失项目长期记忆）
- ❌ 禁止将归档产物写入 `openspec/changes/archive/` 之外的路径（违反 G21）
- ❌ 禁止跳过「归档评分上报」（团队需要靠真实评分数据持续优化工具；评分本身不会打断流程，<3 分时才需要补充反馈文本）
- ❌ 禁止凭对话上下文「想象」上报 payload 字段位置或字段名 —— 上报前**必须**重新打开本文件 STEP 6.6 节，使用 jq 模板渲染 payload，禁止手写 JSON
- ❌ 禁止仅凭 HTTP 200 判定上报成功 —— 必须执行回执校验（STEP 6.8）
- ✅ 每一步必须输出 `[STEP N/8]` 格式的步骤追踪（G20）

---

## 命令格式

```
/feai-archive [变更名]
```

### 参数说明

| 参数     | 说明                                 | 示例                         |
| -------- | ------------------------------------ | ---------------------------- |
| `变更名` | 可选，指定归档的变更名（kebab-case） | `/feai-archive batch-export` |
| 无参数   | 自动推断当前开发分支对应的变更       | `/feai-archive`              |

### 使用示例

```bash
# 自动推断（推荐）
/feai-archive

# 指定变更名
/feai-archive vpc-dns-optimization

# 中文描述也可以，AI 会自动转为 kebab-case
/feai-archive 域名批量导入功能
```

---

## 路径基准（v0.6.0+ 多目录支持）

执行前**必须**读取 `.codebuddy/project.local.json` 中的 `projectRoot` 字段：

| `projectRoot` 值 | 实际归档路径 |
|-----------------|-------------|
| 字段不存在 / `""` / `"."` | `openspec/changes/archive/...` |
| `"frontend"` 等子目录 | `<projectRoot>/openspec/changes/archive/...` |

下文中 `<base>` 均指代解析后的实际路径基准。

---

## 8 步归档流程

### [STEP 1/8] 前置条件检查（任务完成 + 工作区状态）

> 对应规则 G3 / G18

#### 1.1 读取 plan.md 任务状态

```bash
# 统计任务完成度
TOTAL=$(grep -c "^\- \[" "<base>/openspec/plan.md")
DONE=$(grep -c "^\- \[x\]" "<base>/openspec/plan.md")
PENDING=$(grep -c "^\- \[ \]" "<base>/openspec/plan.md")
```

#### 1.2 任务未完成处理

如果 `PENDING > 0`：

```
⚠️  检测到 N 个未完成任务，归档将忽略以下任务：
    • 任务 X: <描述>
    • 任务 Y: <描述>

请选择：
  [c] 继续归档（这些任务将标记为「未实现」并记入归档说明）
  [s] 暂停归档，回去完成剩余任务
  [m] 标记为已完成（仅当确实完成但忘记打勾时使用）
```

| 选择 | AI 行为 |
|-----|--------|
| `c` | 在归档说明中记录"未实现任务清单"，继续 STEP 2 |
| `s` | 退出 `/feai-archive`，提示用户继续开发 |
| `m` | 询问用户哪些任务实际已完成 → 标记为 `[x]` 后继续 STEP 2 |

#### 1.3 git 状态检查

```bash
git status --porcelain
```

**有未提交内容 → 询问用户**：

```
⚠️  检测到未提交变更：
{git status --short 输出}

归档前是否提交？
  [c] 先提交（推荐，建议 commit message: chore: 完成 {需求名} 开发）
  [n] 不提交，归档将与未提交变更一起出现在工作区
```

**产出物检查点：** ✅ 任务完成度已确认；✅ git 状态已确认。

---

### [STEP 2/8] 提出变更（Propose）

> 对应规则 G2 / G21

#### 2.1 推导变更名

| 输入 | 处理 |
|-----|------|
| 用户传入 kebab-case | 直接使用（如 `batch-export`） |
| 用户传入中文描述 | AI 转为 kebab-case（如「域名批量导入」→ `domain-batch-import`） |
| 无参数 | 从当前分支名（`feat/xxx-MMDD-{slug}`）提取 `{slug}` |

#### 2.2 创建变更目录

```bash
openspec new change "<change-name>"
# 等价于 mkdir -p <base>/openspec/changes/<change-name>/
```

#### 2.3 按依赖顺序生成制品

| 顺序 | 文件 | 内容来源 |
|-----|------|---------|
| 1 | `proposal.md` | 变更动机、影响范围（git diff）、能力变更 |
| 2 | `design.md` | 技术方案、架构概述（代码结构分析） |
| 3 | `tasks.md` | 任务清单（来自 plan.md） |

#### 2.4 生成 Delta Specs

如涉及已有模块的规范变更，生成 `<base>/openspec/changes/<change-name>/specs/{module}.md`。

**产出物检查点：** ✅ proposal.md / design.md / tasks.md 全部生成；✅ Delta Specs 已识别。

---

### [STEP 3/8] 经验沉淀（强制，最重要）

> 这是 skillhub 的核心精华——**归档不是流水账，而是知识资产**。

在 proposal.md（M/L 级）或单独的 `<base>/openspec/changes/<change-name>/lessons.md` 中（S 级）必须写入以下五段：

```markdown
## 关键实现决策

> 记录"为什么这样做"，而不是"做了什么"。

- 决策 1：{决策点} → 选择了 {方案A}，因为 {理由}（备选 {方案B} 被否决，原因 {Y}）
- 决策 2：...

## 踩坑记录

> 记录耗时较长的坑，让下次 AI 开发能直接绕过。

- 坑 1：{现象} → 根因 {Z} → 解决方案 {W}（耗时 {N} 小时）
- 坑 2：...

## 技术选型理由

> 记录引入的新依赖、新工具、新模式。

- 引入 {库 X v1.2.3} → 用于 {场景}，相比 {替代方案} 的优势：{...}
- 采用 {模式 Y} → 在 {模块 Z} 中应用，理由：{...}

## 可复用经验

> 提炼出能在其他需求中复用的经验/工具/组件。

- 抽取了通用 hook `useXxx` → 路径 `src/hooks/useXxx.ts` → 适用场景：{...}
- 沉淀了工具函数 `formatYyy` → 适用场景：{...}

## 未实现 / 后续优化

> 本次未做但已识别的优化点（避免遗忘）。

- TODO 1：{优化点} → 优先级 {P0/P1/P2} → 关联 issue/MR：{...}
```

**禁止留空段**：每段至少 1 条，确实没有也要写「本次需求未涉及」。

**产出物检查点：** ✅ 五段经验沉淀全部填写。

---

### [STEP 4/8] 实施变更（Apply）+ 业务/架构文档同步

#### 4.1 标记 tasks.md 全部完成

由于代码已在 `/feai-start` 中完成：
- 将 tasks.md 中所有任务标记为 `- [x]`
- 确认 Delta Specs 与实际代码一致

#### 4.2 业务文档同步（强制，如项目有 `docs/`）

```bash
# 检测 <base>/docs/ 是否存在
[ -d "<base>/docs" ] && DOCS_EXISTS=1 || DOCS_EXISTS=0
```

| 状态 | AI 行为 |
|-----|--------|
| `<base>/docs/` 不存在 | 跳过，并在归档摘要中标注「⏭️ 业务文档：项目无 docs/ 目录」 |
| `<base>/docs/` 存在 | **强制同步** |

强制同步内容（更新或新增对应模块文档）：

```markdown
## {模块名称}

**核心逻辑变更**：本次需求对业务流转的改变 — {...}
**组件依赖更新**：新增/修改的 UI 基础组件 — {...}
**体验优化点**：针对体验痛点的修复或提升 — {...}
**质量保障说明**：新增的兜底机制、防丢机制等 — {...}
**变更日期**：YYYY-MM-DD（关联变更：<change-name>）
```

#### 4.3 架构文档同步（条件触发）

| 触发条件 | 更新目标 |
|---------|---------|
| 新增 / 删除 package | `<base>/openspec/config.yaml` 模块索引 |
| 新增 components / features 目录 | `<base>/openspec/config.yaml` 架构概览 |
| 技术栈升级（新增/删除依赖） | `<base>/openspec/config.yaml` 技术要点 |
| 依赖关系变更 | `<base>/openspec/config.yaml` 依赖关系 |

#### 4.4 Delta Spec 同步评估

如存在 Delta Specs：

```
📐 检测到 Delta Specs：
   • specs/{module-A}.md（新增能力）
   • specs/{module-B}.md（修改约束）

是否同步到主 Spec 库 <base>/openspec/specs/？
  [y] Sync now（推荐）— 合并到主 Spec 库
  [n] Archive without syncing — 跳过同步直接归档
```

| 选择 | AI 行为 |
|-----|--------|
| `y` | 将 Delta Specs 合并到 `<base>/openspec/specs/{module}.md` |
| `n` | 在归档摘要中标记「⚠️ Delta 未同步，需后续手动处理」 |

**产出物检查点：** ✅ tasks.md 全部 `[x]`；✅ 业务文档已同步（或确认无 docs/）；✅ 架构文档按需更新；✅ Delta Specs 处理完成。

---

### [STEP 5/8] 归档变更（Archive）

#### 5.1 移动变更目录

```bash
# 从 <base>/openspec/changes/<change-name>/
# 移到 <base>/openspec/changes/archive/YYYY-MM-DD-<change-name>/
mv "<base>/openspec/changes/<change-name>" "<base>/openspec/changes/archive/$(date +%Y-%m-%d)-<change-name>"
```

#### 5.2 更新 `.openspec.yaml` 状态

将本次变更状态置为 `done`。

**产出物检查点：** ✅ 归档目录已移动；✅ 状态已更新。

---

### [STEP 6/8] 归档评分 + 上报（团队飞轮）

> 这一步用于收集真实使用数据，驱动工具持续优化。**不打扰用户**：高分一秒钟跳过，低分才需要补充一句反馈。

#### 6.1 配置加载

按以下优先级解析上报配置：

| 优先级 | 来源 | 字段 |
|-------|------|------|
| 1 | `<base>/.codebuddy/project.local.json` 的 `reporting` 段 | `enabled` / `endpoint` / `apiKey` |
| 2 | 工具内置默认值（fallback） | `enabled=true` / `endpoint=http://21.214.142.151/api/v1/report` / `apiKey=rh_ad2e2a0b1b992255e6ed43ae42b6aefdaa5e2bde7f34e1bc` |

> 💡 内置 apiKey 是 feai-tools 的团队公共 Key，所有使用者共用，**用于在 ReportHub 后台聚合统计**。如需为本项目独立追踪可在 `project.local.json` 中覆盖。

**配置加载（显式 shell 赋值，禁止 AI 脑补）**：

```bash
LOCAL_CONFIG="<base>/.codebuddy/project.local.json"

REPORT_ENABLED=$(jq -r '.reporting.enabled // true' "$LOCAL_CONFIG" 2>/dev/null || echo "true")
REPORT_ENDPOINT=$(jq -r '.reporting.endpoint // "http://21.214.142.151/api/v1/report"' "$LOCAL_CONFIG" 2>/dev/null || echo "http://21.214.142.151/api/v1/report")
REPORT_API_KEY=$(jq -r '.reporting.apiKey // "rh_ad2e2a0b1b992255e6ed43ae42b6aefdaa5e2bde7f34e1bc"' "$LOCAL_CONFIG" 2>/dev/null || echo "rh_ad2e2a0b1b992255e6ed43ae42b6aefdaa5e2bde7f34e1bc")

# 工具版本号（用于 metadata.version，分析 AI 工具版本影响）
FEAI_VERSION=$(jq -r '.version // "unknown"' "<base>/.codebuddy/.feai-installed" 2>/dev/null || echo "unknown")

# 当前需求名（占位语 <change-name> 在 STEP 1 已确定，这里固化为变量）
CHANGE_NAME="<change-name>"

if [ "$REPORT_ENABLED" != "true" ]; then
  echo "⏭️ reporting.enabled=false，跳过 STEP 6"
  # → 进入 STEP 7
fi
```

#### 6.2 评分采集（核心交互）

输出如下提示，等待用户输入一个 1-5 的整数：

```
📊 本次归档对你有帮助吗？请打分（1-5）：
   1 ⭐         完全没帮助
   2 ⭐⭐       帮助有限
   3 ⭐⭐⭐     基本满意
   4 ⭐⭐⭐⭐   比较满意
   5 ⭐⭐⭐⭐⭐ 非常满意
>
```

用户输入非 1-5 的内容 → 重试 1 次，仍无效则按「3 分 + feedback="评分输入异常"」兜底，不阻塞归档。

#### 6.3 反馈采集（仅 score < 3 触发）

```
😢 抱歉这次没帮上忙，能简单说说哪里出了问题吗？（≤500 字，直接回车结束）
>
```

- score >= 3 → 不询问，`feedback = ""`
- score < 3 → 强制要求 1-500 字反馈文本，超过 500 字截断

#### 6.4 智能识别上下文（不打扰用户）

AI 在归档对话里已经掌握大量上下文，**只识别、不补问**。识别不到就留空，绝不打扰用户：

| 字段 | 识别来源（按优先级） | 识别不到 |
|-----|---------------------|---------|
| `mr.url` / `mr.iid` | ① 当前对话历史中的 MR 链接 / `MR !123` 等关键词；② 最近 5 条 commit message 中的 MR 引用；③ 分支名匹配 | 留空字符串 / null |
| `requirement.title` | ① `<base>/openspec/changes/archive/<dated-name>/proposal.md` 一级标题；② 归档前 `<base>/openspec/proposal.md`；③ 对话上下文中的 TAPD story title | 留空字符串 |
| `requirement.description` | 同上来源的「动机/背景」段，截断 500 字 | 留空字符串 |
| `tapd.id` | ① 对话上下文中的 `--story=` / `--bug=` 关键字；② 分支名 `feat/xxx-{tapdId}` 模式 | 留空字符串 |
| `tapd.workspaceId` | `<base>/.codebuddy/project.local.json` 的 `tapd.workspaceId` | 留空字符串 |
| `requirement.scale` | 当前对话中已有的需求级别（S/M/L） | 留空字符串 |

**识别完成后必须显式赋值到 shell 变量（禁止 AI 在 jq 模板里脑补）**：

```bash
# 以下变量由 AI 根据上表识别结果填入；识别不到必须留空字符串，禁止留 <占位语>
REQ_TITLE=""            # 例如："评分上报链路加固"，识别不到留 ""
REQ_DESC=""             # 例如："修复 metadata=null 假成功问题"，截断 500 字
SCALE=""                # S / M / L / 空串
TAPD_ENABLED=$(jq -r '.integrations.tapd.enabled // false' "<base>/.codebuddy/project.yaml" 2>/dev/null || echo "false")
TAPD_TYPE=""            # story / bug / task / 空串
TAPD_ID=""              # 识别到的 TAPD ID 字符串，否则空串
TAPD_WORKSPACE_ID=$(jq -r '.tapd.workspaceId // ""' "<base>/.codebuddy/project.local.json" 2>/dev/null || echo "")
if [ -n "$TAPD_ID" ] && [ -n "$TAPD_WORKSPACE_ID" ]; then
  TAPD_URL="https://www.tapd.cn/${TAPD_WORKSPACE_ID}/prong/stories/view/${TAPD_ID}"
else
  TAPD_URL=""
fi
MR_URL=""               # 识别到的 MR 链接，否则空串
MR_IID=""               # 识别到的 MR iid（数字字符串），否则空串
MR_STATE=""             # 识别到的 MR 状态，否则空串
WORKFLOW_MODE=$(jq -r '.workflow.mode // "single-agent"' "<base>/.codebuddy/project.yaml" 2>/dev/null || echo "single-agent")
```

#### 6.5 收集环境与项目元数据

```bash
# 用户身份
USER_NAME=$(git config user.name 2>/dev/null || whoami)
USER_EMAIL=$(git config user.email 2>/dev/null || echo "")

# 项目身份
REPO_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
BASE_BRANCH=$(jq -r '.git.defaultBranch // "master"' "<base>/.codebuddy/project.local.json" 2>/dev/null || echo "master")
PROJECT_NAME=$(jq -r '.name // ""' "<base>/.codebuddy/project.local.json")
PROJECT_CODE=$(jq -r '.code // ""' "<base>/.codebuddy/project.local.json")
GIT_PROJECT_ID=$(jq -r '.git.projectId // ""' "<base>/.codebuddy/project.local.json")

DATED_NAME="$(date +%Y-%m-%d)-<change-name>"
ARCHIVE_DIR="<base>/openspec/changes/archive/${DATED_NAME}"

# 需求统计
TASKS_TOTAL=$(grep -c "^\- \[" "${ARCHIVE_DIR}/tasks.md" 2>/dev/null || echo 0)
TASKS_DONE=$(grep -c "^\- \[x\]" "${ARCHIVE_DIR}/tasks.md" 2>/dev/null || echo 0)

# 代码统计（与 baseBranch 比对）
FILES_CHANGED=$(git diff --name-only "$BASE_BRANCH"...HEAD | wc -l | tr -d ' ')
LINES_STAT=$(git diff --shortstat "$BASE_BRANCH"...HEAD)
LINES_ADDED=$(echo "$LINES_STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
LINES_DELETED=$(echo "$LINES_STAT" | grep -oE '[0-9]+ deletion'  | grep -oE '[0-9]+' || echo 0)
```

#### 6.6 ⚠️ 必须使用 jq 模板渲染 payload（禁止手写 JSON）

> **严格契约**：服务端只解构 5 个顶层字段：`source` / `event` / `userId` / `metadata` / `timestamp`。
> 业务字段全部必须放在 `metadata` 内，否则**全部丢弃为 null**。
> **禁止手写 JSON 字符串**，必须用以下 jq 模板渲染：

```bash
PAYLOAD_FILE="<base>/.codebuddy/.cache/report-$(date +%s).json"
mkdir -p "$(dirname "$PAYLOAD_FILE")"

jq -n \
  --arg source "feai-tools" \
  --arg event "archive_rating" \
  --arg userId "$USER_NAME" \
  --arg version "$FEAI_VERSION" \
  --argjson score "$SCORE" \
  --arg feedback "$FEEDBACK" \
  --arg archivedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg userName "$USER_NAME" \
  --arg userEmail "$USER_EMAIL" \
  --arg projectName "$PROJECT_NAME" \
  --arg projectCode "$PROJECT_CODE" \
  --arg repoUrl "$REPO_URL" \
  --arg gitProjectId "$GIT_PROJECT_ID" \
  --arg branch "$BRANCH" \
  --arg baseBranch "$BASE_BRANCH" \
  --arg changeName "$CHANGE_NAME" \
  --arg reqTitle "$REQ_TITLE" \
  --arg reqDesc "$REQ_DESC" \
  --arg scale "$SCALE" \
  --argjson tasksTotal $TASKS_TOTAL \
  --argjson tasksDone $TASKS_DONE \
  --argjson filesChanged $FILES_CHANGED \
  --argjson linesAdded $LINES_ADDED \
  --argjson linesDeleted $LINES_DELETED \
  --argjson tapdEnabled $TAPD_ENABLED \
  --arg tapdType "$TAPD_TYPE" \
  --arg tapdId "$TAPD_ID" \
  --arg tapdUrl "$TAPD_URL" \
  --arg tapdWsId "$TAPD_WORKSPACE_ID" \
  --arg mrUrl "$MR_URL" \
  --argjson mrIid "$([[ "$MR_IID" =~ ^[0-9]+$ ]] && echo "$MR_IID" || echo null)" \
  --arg mrState "$MR_STATE" \
  --arg wfMode "$WORKFLOW_MODE" \
  --arg archivePath "openspec/changes/archive/${DATED_NAME}/" \
  '{
    source: $source,
    event: $event,
    userId: $userId,
    metadata: {
      version: $version,
      score: $score,
      feedback: $feedback,
      archivedAt: $archivedAt,
      user:    { name: $userName, email: $userEmail },
      project: { name: $projectName, code: $projectCode, repoUrl: $repoUrl,
                 gitProjectId: $gitProjectId, branch: $branch, baseBranch: $baseBranch },
      requirement: { changeName: $changeName, title: $reqTitle, description: $reqDesc,
                     scale: $scale, tasksTotal: $tasksTotal, tasksDone: $tasksDone,
                     filesChanged: $filesChanged, linesAdded: $linesAdded, linesDeleted: $linesDeleted },
      tapd: { enabled: $tapdEnabled, type: $tapdType, id: $tapdId, url: $tapdUrl, workspaceId: $tapdWsId },
      mr:   { url: $mrUrl, iid: $mrIid, state: $mrState },
      workflow: { mode: $wfMode, archivePath: $archivePath }
    },
    timestamp: (now * 1000 | floor)
  }' > "$PAYLOAD_FILE"
```

#### 6.7 上报前自检（5 项缺一不可，任一失败必须短路）

```bash
SAVE_FAILED=0

# 自检 1：JSON 合法性
jq empty "$PAYLOAD_FILE" 2>/dev/null || { echo "❌ payload JSON 非法"; SAVE_FAILED=1; }

# 自检 2：顶层只允许 5 个字段（差集判断，可读性优于字典序硬编码）
EXTRA_KEYS=$(jq -r '(keys) - ["source","event","userId","metadata","timestamp"] | join(",")' "$PAYLOAD_FILE" 2>/dev/null)
MISSING_KEYS=$(jq -r '["source","event","metadata"] - keys | join(",")' "$PAYLOAD_FILE" 2>/dev/null)
[ -z "$EXTRA_KEYS" ] || { echo "❌ payload 顶层多余字段：$EXTRA_KEYS"; SAVE_FAILED=1; }
[ -z "$MISSING_KEYS" ] || { echo "❌ payload 顶层缺失必填字段：$MISSING_KEYS"; SAVE_FAILED=1; }

# 自检 3：metadata 必须是非空对象
META_TYPE=$(jq -r '.metadata | type' "$PAYLOAD_FILE" 2>/dev/null)
META_KEYS=$(jq -r '.metadata | keys | length' "$PAYLOAD_FILE" 2>/dev/null)
{ [ "$META_TYPE" = "object" ] && [ "${META_KEYS:-0}" -gt 0 ]; } \
  || { echo "❌ metadata 不是非空对象"; SAVE_FAILED=1; }

# 自检 4：score 是 1-5 整数
SCORE_VAL=$(jq -r '.metadata.score' "$PAYLOAD_FILE" 2>/dev/null)
[[ "$SCORE_VAL" =~ ^[1-5]$ ]] || { echo "❌ score 非法：$SCORE_VAL"; SAVE_FAILED=1; }

# 自检 5：timestamp 必须是数字（Unix ms）
TS_TYPE=$(jq -r '.timestamp | type' "$PAYLOAD_FILE" 2>/dev/null)
[ "$TS_TYPE" = "number" ] || { echo "❌ timestamp 必须是数字"; SAVE_FAILED=1; }

# ⚠️ 关键：任一自检失败 → 必须短路，禁止把脏 payload 打到服务端
if [ "$SAVE_FAILED" = "1" ]; then
  echo "❌ 自检未通过，跳过上报。payload 已留档：$PAYLOAD_FILE"
  echo "   → 直接进入 STEP 7（按 6.9 兜底处理）"
  # AI 必须在此处终止 STEP 6，不得执行 6.8
fi
```

#### 6.8 执行上报 + 回执校验（强制，仅在 6.7 全部通过后执行）

> 前置条件：`SAVE_FAILED=0`。若 6.7 任一自检失败，本节**整段跳过**。

```bash
# 注意：服务端使用 X-API-Key 请求头进行认证（不是 Authorization: Bearer）
RESP=$(curl -sS -m 5 -X POST "$REPORT_ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $REPORT_API_KEY" \
  --data-binary @"$PAYLOAD_FILE" \
  -w "\n---HTTP=%{http_code}---")

HTTP_CODE=$(echo "$RESP" | grep -oE 'HTTP=[0-9]+' | grep -oE '[0-9]+')
BODY=$(echo "$RESP" | sed '/---HTTP=/d')

# 校验 1：HTTP 状态码必须 200
[ "$HTTP_CODE" = "200" ] || { echo "⚠️ 上报失败 HTTP=$HTTP_CODE: $BODY"; SAVE_FAILED=1; }

# 校验 2：业务返回码必须 0
BIZ_CODE=$(echo "$BODY" | jq -r '.code // empty' 2>/dev/null)
[ "$BIZ_CODE" = "0" ] || { echo "⚠️ 上报业务失败 code=$BIZ_CODE: $BODY"; SAVE_FAILED=1; }

# 校验 3：服务端回执 id（可选，依赖服务端 GET /report/:id 接口）
REPORT_ID=$(echo "$BODY" | jq -r '.data.id // empty' 2>/dev/null)
if [ -n "$REPORT_ID" ]; then
  DETAIL=$(curl -sS -m 5 "${REPORT_ENDPOINT%/}/${REPORT_ID}" \
    -H "X-API-Key: $REPORT_API_KEY")
  META_SCORE=$(echo "$DETAIL" | jq -r '.data.metadata.score // empty' 2>/dev/null)
  [ -n "$META_SCORE" ] || echo "⚠️ 回执校验：服务端入库的 metadata.score 为空，请检查服务端"
fi
```

#### 6.9 失败兜底

上报失败（任意校验未通过、网络异常、超时）：
- ❌ **不打断**归档流程
- ✅ STEP 8 摘要静默标注「⚠️ 评分上报失败（已忽略）」
- ✅ 失败 payload 已落盘 `<base>/.codebuddy/.cache/report-*.json`，下次 `/feai-archive` 启动时检测并提示补传

**产出物检查点：**
✅ 评分已采集；
✅ <3 分时反馈已采集；
✅ payload 由 jq 模板渲染（非手写）；
✅ 5 项自检全部通过；
✅ 回执校验已执行；
✅ 失败 payload 已落盘留档。

---

### [STEP 7/8] 工作区清理（防污染）

> 这是 skillhub 防止"残留污染下次需求"的关键步骤。

清空以下文件，使工作区进入"可接受新需求"状态。**4 个状态文件统一保留并改写为占位语**（参考 skillhub `.openspec/` 状态机制）：

| 文件 | 处理方式 |
|------|---------|
| `<base>/openspec/plan.md` | 清空内容，写入占位语：「工作区已清理（上一需求归档于 YYYY-MM-DD：{需求名}）。请通过 `/feai-start` 启动新流程。」 |
| `<base>/openspec/proposal.md` | 同上占位语 |
| `<base>/openspec/spec.md` | 同上占位语 |
| `<base>/openspec/current_state.md` | **追加一行历史记录**到「历史归档」段落：`  - YYYY-MM-DD：{需求名}（{完成数}/{总数} 任务）`；并把开头的「上一个需求」指针更新为本次归档（含归档目录链接、源分支） |

#### 7.1 current_state.md 追加格式（强约束）

执行后，`current_state.md` 顶部应呈现如下结构：

```markdown
# 当前需求状态

> 当前没有进行中的需求。
>
> 上一个需求：「{需求名}」已于 YYYY-MM-DD 归档（X/Y 任务完成）。
> - 详细变更记录：`openspec/changes/archive/YYYY-MM-DD-<change-name>/`
> - 分支：`{当前 git 分支}`
>
> 历史归档：
>   - YYYY-MM-DD：{需求名}（X/Y 任务）   ← 本次新增
>   - （历史已有记录保留在下方）
>
> 执行 `/feai-start` 启动新需求。
```

⚠️ **`<base>/openspec/specs/`（主 Spec 库）和 `<base>/openspec/config.yaml` 必须保留** — 这是项目知识库本体。

⚠️ **4 个状态文件不允许直接删除**，必须保留为占位语形式 — 这是 P0 必读清单的稳定性保障，删除会导致下次 `/feai-start` 加载 P0 时报

---

### [STEP 8/8] 门禁检查 + 归档输出

#### 8.1 对照 gate-archive.md 逐项检查

对照 `<base>/.codebuddy/.workflow/checklists/gate-archive.md` 逐项检查（如清单文件存在）。

#### 8.2 输出归档摘要

```
## ✅ 归档完成

**变更名:** <change-name>
**归档位置:** <base>/openspec/changes/archive/YYYY-MM-DD-<change-name>/

### 归档清单
├── ✅ 任务完成：X/Y 个任务
├── ✅ 制品：proposal.md / design.md / tasks.md（已完成）
├── ✅ 经验沉淀：5 段（关键决策/踩坑/选型/复用/TODO）
├── ✅ 业务文档：<base>/docs/{module}.md 已更新 / ⏭️ 项目无 docs/
├── ✅ 架构文档：<base>/openspec/config.yaml [已更新 / 无需更新]
├── ✅ Delta Spec 同步：[已同步 / 跳过 / 无 Delta Specs]
├── ✅ 工作区清理：plan.md / proposal.md / spec.md 已重置为占位语
├── ✅ 长期记忆：current_state.md 已追加本次归档历史
├── ✅ 评分上报：score=N，[已上报 / 已禁用 / ⚠️ 上报失败已忽略]
└── ✅ 门禁：gate-archive ✅ 通过

💡 本次变更已沉淀到项目知识库，下次 /feai-start 时 AI 将自动加载相关上下文。
```

#### 8.3 TAPD 流程（条件触发，对应 G15）

当 `<base>/.codebuddy/.workflow/project.yaml` 中 `integrations.tapd.enabled: true` 时：
- 更新 TAPD 需求状态为「已完成」
- 发布 TAPD 归档评论（含归档路径、关键决策摘要）

**产出物检查点：** ✅ 门禁通过；✅ 摘要已输出；✅ TAPD 已闭环（如启用）。

---

## 与 `/opsx:*` 命令的关系

`/feai-archive` 是 `/opsx:propose` + `/opsx:apply` + `/opsx:archive` 的**一步整合版**：

```
改造前（3 步）                    改造后（1 步）
─────────────                    ─────────────
/opsx:propose  ──┐
/opsx:apply    ──┼──▶  /feai-archive
/opsx:archive  ──┘
```

> 💡 `/opsx:*` 命令仍然保留，供需要细粒度控制的高级用户使用。

---

## 数据来源

| 数据 | 来源 | 用途 |
|-----|------|-----|
| 任务清单 | `<base>/openspec/plan.md` 的 `- [x]` / `- [ ]` | STEP 1 检查 |
| 变更文件列表 | `git diff --name-only` | proposal.md 影响范围 |
| 新增/修改功能点 | 代码分析 + commit 信息 | proposal.md 能力变更 |
| 技术方案 | 代码结构分析 | design.md 架构概述 |
| 任务详情 | commit 历史 | tasks.md |
| 测试用例 | 测试文件分析 | 验证覆盖度 |
| 关联 TAPD | 分支名中的 Story ID | proposal.md 动机 |
| 检查清单 | `<base>/.codebuddy/.workflow/checklists/gate-archive.md` | STEP 8 |

---

## 何时必须归档？

**凡是涉及功能性变更的开发，原则上都应归档**：

| 变更类型 | 是否需要归档 | 说明 |
| -------- | :----------: | ---- |
| 🟢 新增功能 / 模块 | ✅ **必须** | 新能力必须沉淀为 spec，否则 AI 无法在后续开发中识别 |
| 🟡 功能重构 / 优化 | ✅ **必须** | 架构决策和新约束必须同步到 spec 库 |
| 🟠 Bug 修复 | ✅ **推荐** | 修复可能隐含业务规则变化，归档能固化正确行为 |
| 🔵 文档 / 配置调整 | ⚪ 可选 | 非功能性变更，不强制 |
| 🔴 紧急 hotfix | ⚪ 补归档 | 先上线后，稳定后补归档，确保知识不遗漏 |

> 💡 **核心原则**：**归档是团队知识资产的积累**，不是额外负担。
> 每次归档，AI 在项目里就"多懂一点"，下次 `/feai-start` 时它会自动加载这些上下文，形成飞轮效应。

### 忘记归档怎么办？

- `/feai-start` **STEP 1.3** 会自动扫描 `<base>/openspec/changes/` 下的未归档变更，发现后会强制引导归档（L3 防遗忘机制）
- `/feai-start` **STEP 1.4** 会检测归档过时（reviewer 改代码后 spec 没同步，L4 防遗忘机制）
- `/feai-start` **阶段 6** 会在 MR 创建成功后以醒目提示框询问是否归档（L1 防遗忘机制）
- 普通对话中，提到"MR 创建成功 / MR 提了 / 开了 MR / 推上去了"等关键词时，AI 会主动提示运行 `/feai-archive`（趁 MR 未合并，归档 commit 可追加到同一个 MR）
