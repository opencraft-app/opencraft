# `/feai-start` — 启动开发流程

> 前端 AI 编程工具（frontend-ai-dev-tools）的核心开发入口命令。
> 整合 OpenSpec 上下文加载 + `prd-creator` 产品前置 + 团队工具链（TAPD/MR/CR），一个命令启动完整开发流程。
>
> 📄 流程选择矩阵、信任模式、MCP 错误恢复等通用规范请参考 `AGENTS.md`。

---

## 强制约束（最高优先级）

- ❌ 禁止使用 `EnterPlanMode` / `ExitPlanMode` 替代本工作流（违反 G19）
- ❌ 禁止将规划产物写入 `.codebuddy/plans/` 或其他非 `openspec/` 路径（违反 G21）
- ❌ 禁止在 `openspec/plan.md` 通过门禁前编写任何业务代码（违反 G3）
- ❌ 禁止在主上下文里直接调用 Figma MCP 拉全量节点数据（必须通过 figma-analyzer sub-agent 派发）
- ❌ 禁止跳过 `git status` 前置检查就创建/切换分支（违反 G8）
- ❌ 禁止在 plan.md 状态判定为"未归档"（1.2 三信号公式返回 B/C）时直接进入 STEP 2，除非用户回复 `SKIP-ARCHIVE` 二次确认（违反 G22）
- ❌ 禁止跳过任一 STEP（违反 G18）
- ❌ 禁止 SLUG 漂移（v0.31+ 关键约束）：`prd-creator` 输出的英文 feature slug → STEP 4.2 EXPECTED_BRANCH → 实际 git 创建的分支名 → STEP 4.3 公式产出的 CHANGE_NAME → metrics 目录名，**必须从头到尾保持完全一致**。任何环节（包括"分支名太长不好看"的人工/AI 截断、`prd-creator` 用业务长名 + 4.2.1 用业务短名）都不允许。一旦在 STEP 4.3 漂移目录自检触发，**必须 exit 1 阻断**，禁止 AI 与用户协商"凑活合并"。
- ✅ 每一步必须输出 `[STEP N/8]` 格式的步骤追踪（G20）
- ✅ 完成 8 步规划后才进入「执行后续」（阶段 4B/4C/4D/5/6）

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

## 📊 工作流诊断埋点（v0.28.0+ 全局约束）

> 目的：以"改善工作流"为目的的真实数据采集。所有埋点失败均为静默（`|| true`），永不阻塞主流程。

### 埋点目录（两阶段）

本命令的埋点目录分**两个阶段**，STEP 4.3 是分水岭：

| 阶段 | 变量 | 实际路径 | 说明 |
|-----|------|---------|------|
| **STEP 1 ~ STEP 4.2**（分支未确定）| `$PENDING_DIR` | `<base>/.codebuddy/.cache/metrics/.pending/` | 根级临时目录，**与 change-name 无关** |
| **STEP 4.3 ~ STEP 8**（分支确定后）| `$METRICS_DIR` | `<base>/.codebuddy/.cache/metrics/<change-name>/` | `<change-name>` 由分支名按公式提取（见 STEP 4.3） |

```bash
# STEP 1 顶部首先初始化（仅初始化 PENDING_DIR，不要尝试构造 METRICS_DIR）
PENDING_DIR="<base>/.codebuddy/.cache/metrics/.pending"
mkdir -p "$PENDING_DIR" 2>/dev/null || true
```

> ⚠️ **强制约束（v0.31+）**：
> - 在 STEP 4.3 **之前**，**严禁**构造、推断或写入 `$METRICS_DIR`（含字面量替换）。所有 STEP 1-3 的埋点**必须**写入 `$PENDING_DIR/`。
> - **严禁**根据

### AI 自报字段（强制约束，对应 G23）

`tokenIn` / `tokenOut` 无法由 shell 兑底，只能由 AI 填入。`userIdleRatio` 在 v0.31 起标记为 **deprecated**（采集端无法可靠区分「等用户」/「跑工具」），**写入端不必再填**，即使填了也会被 archive 阶段聚合时统一抹为 `null`，下个版本将从 schema 移除。

> 🔴 **禁止估算（v0.31+ 硬约束）**：
> 
> - **tokenIn / tokenOut**：**只允许从运行平台的 usage 元数据**（如 Claude Code 响应包中的 `usage.input_tokens` / `usage.output_tokens`）读取后填入。**任何情况下禁止**根据「对话长度感觉」「输入文件体量」等进行估算。读不到 usage 元数据时（不支持的平台/仅返回文本）一律填 `null`。
> - **userIdleRatio**：**已废弃（deprecated）**。该字段无法被客户端可靠采集，下游消费方禁止依赖；写入端继续输出仅为兼容旧 schema，建议直接填 `null`。
> - 违反本约束（即估算了一个看似合理的数字）是**伪造遵从信号**，会在 archive 阶段被 `dataIntegrity.tokenSource` 标记为 `ai-estimated` 并上报后台，不能用于跨需求对比。

> ⚠️ **v0.34 下线提示**：v0.31 引入的 `outputChars` / `tokenOutEstimated` 输出侧粗估路径，因 AI 实际无可靠采集渠道（bash 拿不到 LLM 上一轮回复，让 AI 心算字符数本身就是被禁止的「凭感觉估算」），整条链路上报值长期为 null，已于 v0.34 干净下线，从 timeline.log 与聚合 schema 中移除。timeline.log 仅保留可由平台 usage 元数据真实采集的 `tokenIn` / `tokenOut`。

读不到时保持变量未赋值，模板会自动堆 `null`，不要为了「凑个数」手填。
### 埋点示例（STEP 1 开始 —— 使用 `$PENDING_DIR`）

```bash
# ⚠️ STEP 1-3 阶段一律写入 $PENDING_DIR，绝不能凭空构造 $METRICS_DIR
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step1","phase":"begin","ts":'$NOW_MS'}' \
  >> "$PENDING_DIR/timeline.log" 2>/dev/null || true
```

### 埋点示例（STEP 1 结束 + AI 自报 —— 使用 `$PENDING_DIR`）

```bash
# ⚠️ 仅在能从平台 usage 元数据读到真实 token 时才赋值，读不到保持未赋值（模板堆 null）
# 🔴 禁止凭「对话长度感觉」估算 token；违者在 archive 会被 tokenSource=ai-estimated 标记
TOKEN_IN=        # 例：TOKEN_IN=12000（仅当平台 usage 元数据中看到 input_tokens=12000 时）
TOKEN_OUT=       # 同上
IDLE=            # 仅当能从对话 timestamp 明确算出等待时间占比时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
# ⚠️ 变量为空时 ${VAR:-null} 会填 null，避免生成 "tokenIn":, 类非法 JSON
echo '{"stage":"start.step1","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$PENDING_DIR/timeline.log" 2>/dev/null || true
```

> 💡 STEP 4 之后的埋点（STEP 5/6/8.5 等）改用 `$METRICS_DIR`，模板见各 STEP 内部代码块。

> ⚠️ 埋点失败（如目录不可写、jq 不可用）**不视为流程失败**，绝不能因此中断 STEP 流转。

---

## 8 步门禁链（规划阶段）

### [STEP 1/8] 项目上下文加载 + 防遗忘扫描（L3 + L4）

> 对应规则 G1 / G5 / G18

#### 1.1 配置读取
1. 读取 `.codebuddy/project.local.json` → 解析 `projectRoot` 字段，确定 `<base>`
2. 读取 `<base>/.workflow/project.yaml` → 加载工作流配置（`context_loading` 协议、`capabilities.enabled`、`gates.required`）与项目上下文（`context:` 段落中的技术栈、路由、模块）
3. 按 `context_loading` P0 清单加载必读文件（`<base>/AGENTS.md`、`<base>/.workflow/rules/global.md`、`<base>/openspec/plan.md`、`<base>/openspec/current_state.md`）；P1 按需加载 `<base>/openspec/specs/` 中与本次需求匹配的模块

> 💡 `current_state.md` 是项目级"长期记忆"：包含上一个需求摘要 + 历史归档清单。读取它能让 AI 在启动新需求时获得跨需求的项目历史感（避免每次"从零开始"）。

#### 1.2 plan.md 状态判定（防丢失）

读取 `<base>/openspec/plan.md`（如存在），按下列三种情况之一处理。

> 🔴 **A/B/C 必须用确定性 shell 指令判定，禁止 AI 主观看文本猜。**
>
> 判定前必须跑完下面三个 grep，并把三个计数同时拿到手：
>
> ```bash
> PLAN="<base>/openspec/plan.md"
> # 信号 1：归档占位语（是否上次已 archive）
> ARCHIVED_HINT=$(grep -c "工作区已清理\|上一需求归档于" "$PLAN" 2>/dev/null || echo 0)
> # 信号 2：任何 任务行（含已完成/未完成）
> TASK_TOTAL=$(grep -c "^\- \[" "$PLAN" 2>/dev/null || echo 0)
> # 信号 3：未完成任务行
> TASK_PENDING=$(grep -c "^\- \[ \]" "$PLAN" 2>/dev/null || echo 0)
> ```

| 情况 | 检测公式（三个信号同时成立） | AI 行为 |
|-----|------------------------|--------|
| **A. 文件不存在 / 已归档占位语** | 文件不存在 或 `ARCHIVED_HINT ≥ 1 且 TASK_TOTAL = 0` | 进入 STEP 2，正常启动新需求 |
| **B. 所有任务已完成（忘归档）** | `TASK_TOTAL ≥ 1 且 TASK_PENDING = 0` | 输出 **B 卡片**，等待用户选择继续 / 归档 |
| **C. 存在未完成任务** | `TASK_PENDING ≥ 1` | 输出 **C 卡片**，等待用户选择，禁止自作主张往下走 |

> ⚠️ **必须重要补充**：若 `plan.md` 既 不包含归档占位语 又 `TASK_TOTAL = 0`（文件存在但内容是人为清空/被别的序列覆盖），这是可疑状态，**统一归为情况 A** 并在进入 STEP 2 前提示用户「检测到 plan.md 存在但为空，如果之前有未完成需求请手动从 git 恢复」。

> 🔴 **强制约束（v0.32+）**：B / C 情况 AI **必须照下方卡片原文输出**（仅替换花括号变量），**禁止用一句话总结**糊弄过去。卡片输出后**必须停下来等用户回复**，不得连贯继续下一步。
> 违反此约束 = 把"用户决策点"吞掉，等价于 G3 违规（规划阶段未经用户确认进入执行）。

##### 卡片 B（任务全部完成、待归档）

```
📋 当前「{plan.md 顶部读到的需求标题}」所有任务已完成 ✅（{已完成数}/{总数}）。

⚠️ 未归档将造成三重损失：
   · current_state.md 项目长期记忆丢失本需求历史
   · lessons 知识库未沉淀，经验不可复用
   · plan.md 如被覆盖，任务清单与完成证据永久丢失

请选择：
  [1] 立即执行 /feai-archive 归档（强烈推荐）
  [2] 取消本次 /feai-start，我去处理归档
  [3] 仅调试、不需要归档（需输入 SKIP-ARCHIVE 及原因）

请回复 1 / 2 / 3 。**AI 不得替用户决定**，必须等待明确回复。
```

##### 卡片 C（仍有未完成任务）

```
⚠️ 当前「{plan.md 顶部读到的需求标题}」还有 {N} 个未完成任务：
   {列出前 5 条未完成任务文本，超过 5 条用 "...还有 X 条" 折叠}

请选择：
  [1] 继续推进当前需求（退出 /feai-start，回到执行阶段）
  [2] 搁置当前需求，开启新需求（旧 plan.md 会被覆盖，未完成任务将丢失）
  [3] 先归档当前进度（任务部分完成也允许归档），再开启新需求
  [4] 取消本次 /feai-start

请回复 1 / 2 / 3 / 4 。**AI 不得替用户决定**，必须等待明确回复。
```

> 💡 **B / C 卡片埋点**（用于事后回查"用户是否真在这个决策点上停下"）：
>
> ```bash
> # 在卡片输出后立即写入，phase=cardShown
> NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
> jq -nc --arg state "B或C" --arg title "{需求标题}" --argjson n {N} \
>   '{stage:"start.step1.gate",phase:"cardShown",state:$state,title:$title,unfinished:$n,ts:'"$NOW_MS"'}' \
>   >> "$PENDING_DIR/timeline.log" 2>/dev/null || true
> ```
#### 1.3 防遗忘扫描 L3：`changes/` 历史遗留目录清扫（辅助层）

> 💡 **L3 的真实职责**（诚实声明，不要夸大）：
>
> **未归档检测的金标准是 1.2**（`plan.md` 三信号公式）。原因：
> - `feai-archive.md` STEP 5 完成后会执行 `rm -rf openspec/changes/<name>/`、并把 `plan.md` 重写为占位语，所以“plan.md 是否为占位语”是**全规模（S/M/L）通吃**的唯一权威信号。
> - **S 级需求从不创建 `changes/<name>/` 子目录**（`writing-plans` 只产出 `plan.md`），所以以“子目录是否存在”为未归档依据会对 S 级需求 100% 漏报。
>
> 所以 L3 **不是未归档检测的主信号源**，它只负责两件辅助事：
>
> 1. **M/L 开发期辅证**：如果 1.2 已报警，L3 的目录列表可作为補充证据列出“到底哪些产物需要处理”。
> 2. **历史残骨清扫**：发现旧版本（v0.28-）流程遗留、或 archive 中途崩溃未清理、或用户手工 mkdir 出的孤立目录。
>
> ⚠️ **L3 静默不等于已归档**：“扫不到目录”只说明 M/L 开发期产物不在，不能推出“未归档”结论。**最终是否进 STEP 2 以 1.2 为准。**

扫描 `<base>/openspec/changes/`，**仅识别"历史遗留目录"**，必须同时满足：

1. 是**目录**（不是文件）
2. 目录名**不是** `archive`（旧版 v0.28- 的归档子目录）
3. 目录内**至少存在** `proposal.md` 或 `tasks.md` 之一（确认是 openspec 开发期产物，而非用户随手建的杂目录）

> ⚠️ **必须忽略 `<base>/openspec/changes/*.md` 文件**：从 v0.29+ 起，已归档变更以扁平单文件形态存在（如 `2026-06-12-foo.md`），这些是**已归档**产物，**绝不能**当作"未归档历史变更"再次提示用户归档（否则会陷入"归档完立刻又被要求归档"的死循环）。

> 💡 **与 1.2 的联动逻辑**：
> - 1.2 判为 B/C （未归档） + L3 扫到目录 → 是 **M/L 级需求**，卡片中附上“包含以下产物需被归档处理：proposal/tasks/spec”。
> - 1.2 判为 B/C （未归档） + L3 扫不到目录 → 是 **S 级需求**，仅 plan.md 需被归档。
> - 1.2 判为 A （已归档） + L3 扫到目录 → 不一致状态，表示“历史残骨”，走下方 L3 卡片让用户选择归档或手动清理。
> - 1.2 判为 A + L3 扫不到目录 → 工作区真干净，直接进 STEP 2。

**推荐扫描命令（AI 必须执行，不得仅凭 ls 推理）**：

```bash
# 列出待归档目录（开发期未归档形态）
find "<base>/openspec/changes" -mindepth 1 -maxdepth 1 -type d \
  ! -name 'archive' \
  -exec sh -c '[ -f "$1/proposal.md" ] || [ -f "$1/tasks.md" ]' _ {} \; \
  -print 2>/dev/null
```

输出非空时，按下方卡片提示用户（**文案以“历史遗留”为准，不再抖“未归档”**，避免误导）：

```
⚠️  检测到 N 个 `openspec/changes/` 历史遗留目录（可能是旧版流程残留 / 归档崩溃 / 手工创建）：
    • <change-name-1>   （创建 X 天前）
    • <change-name-2>   （创建 Y 天前）

> 这些目录并不一定意味着未归档（未归档以 1.2 的 plan.md 判定为准），
>  但它们占据仓库且可能误导后续扫描，建议处理。

请选择：
  [a]              全部走 /feai-archive 归档流程（适用于确实是未归档的需求）
  [1] / [2] / ...  仅处理指定项
  [c]              手动确认这些是废弃残骨，直接从 git 删除（需输入 SKIP-ARCHIVE 及原因）
  SKIP-ARCHIVE     强制跳过（需在同一回复中说明跳过原因）
```

| 用户选择 | AI 行为 |
|---------|---------|
| `a` | 逐个执行 `/feai-archive <change-name>`，全部完成后进入 STEP 2 |
| 数字（如 `1`） | 归档指定变更后再次扫描；如还有未归档继续提示 |
| `c` + `SKIP-ARCHIVE <原因>` | 用户判定为残骸：执行 `git rm -rf <base>/openspec/changes/<change-name>/`（**不得用裸 `rm -rf`**，必须经 git 跟踪）；同时按下方埋点写入 `explicit-skips.log`；进入 STEP 2 |
| `SKIP-ARCHIVE <原因>` | 记录跳过原因到对话上下文，进入 STEP 2；**同时按下方埋点写入 `explicit-skips.log`** |
| 其他（`s` / `skip` / `跳过` / 直接 `n` 等） | **不构成豁免**，再次提示并要求用户回复 `SKIP-ARCHIVE` 完整字面 |

**SKIP-ARCHIVE 触发时强制埋点（对应 G22 规则有效性追踪）**：

```bash
# ⚠️ reason 是用户填写的字符串，可能含中文双引号/换行/Unicode → 必须用 jq 渲染（global.md 铁律 2）
# ⚠️ STEP 1.3 处于 STEP 4.3 之前，分支名尚未确定 → 必须使用 $PENDING_DIR（根级 .pending），
#    严禁构造 $METRICS_DIR 或自造 change-name 子目录
SKIP_REASON="<用户原因>"   # AI 把用户回复中 SKIP-ARCHIVE 后的原文填入
SKIP_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$PENDING_DIR" 2>/dev/null || true
jq -nc --arg reason "$SKIP_REASON" --arg at "$SKIP_AT" \
  '{rule:"G22",reason:$reason,at:$at}' \
  >> "$PENDING_DIR/explicit-skips.log" 2>/dev/null || true
```

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
  ":!${OPENSPEC_DIR}/changes/*.md" \
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

1. 读取 `<base>/.workflow/project.yaml` 中的 `dependencies.plugins` 配置
2. 逐一验证所需插件/本地 skill（尝试加载任一 skill 如 `.agents/skills/product-skills/prd-creator/SKILL.md`）
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

#### 4.2 分支名规范前置校验（强制，在创建/沿用分支前完成）

> 核心目的：**防止分支名违规悄悄跑完整条流程**，让 metrics / openspec / TAPD 关联的 `<change-name>` 命名分裂。
> 规范分支名格式：`^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-[0-9]{4}-[a-z0-9-]+$`
> 　　　　　　　　　└──类型──┘ └──currentuser──┘ └─MMDD─┘ └──slug──┘

**4.2.1 当前不在 `feat/...` 分支（即将由 `branch-auto-create` 新建）**

执行 dry-run 拼接出**预期分支名**并校验：

```bash
# 预解析 currentuser
RAW_USER=$(git config user.name 2>/dev/null || whoami)
SLUG_USER=$(echo "$RAW_USER" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed -E 's/[^a-z0-9-]+//g; s/-+/-/g; s/^-+|-+$//g')
MMDD=$(date +%m%d)
SLUG="<由 prd-creator 输出的英文 feature slug>"   # 同样需 slug 化为 [a-z0-9-]
EXPECTED_BRANCH="feat/${SLUG_USER}-${MMDD}-${SLUG}"

# 强校验
echo "$EXPECTED_BRANCH" | grep -Eq '^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-[0-9]{4}-[a-z0-9-]+$' \
  || { echo "❌ 预期分支名 [$EXPECTED_BRANCH] 不符合规范，禁止继续"; exit 1; }
```

不通过的常见原因 → AI 必须**显式提示用户并停下**，不得静默 fallback：
- `git config user.name` 返回空或纯中文 → 让用户手动指定英文短名
- `slug` 含中文/特殊字符 → 让用户回到 `prd-creator` 重新输出英文 feature slug

**4.2.2 当前已在 `feat/...` / `fix/...` 等分支（沿用现有分支）**

```bash
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "$CUR_BRANCH" | grep -Eq '^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-[0-9]{4}-[a-z0-9-]+$' \
  || {
    cat <<EOF
⚠️ 当前分支 [$CUR_BRANCH] 不符合规范命名：
   feat|fix|feature|hotfix|chore / <user-slug> - <MMDD> - <feature-slug>

继续会导致 <change-name> 命名分裂（metrics / openspec / TAPD 三处对不齐）。
请选择：
  [1] 切回 master 重新走 4.2.1 创建规范分支（推荐）
  [2] 手动重命名当前分支：git branch -m feat/<user>-<MMDD>-<slug>
  [3] FORCE-CONTINUE <理由>  强制沿用并记录埋点（仅用于历史分支兼容）
EOF
    exit 1
  }
```

**关键约束：**
- ❌ AI 不得自作主张走 `[3] FORCE-CONTINUE`，必须由用户明确字面回复
- ❌ 不得在校验未通过时继续 4.2.3
- ✅ 通过后才进入 4.2.3 实际创建/沿用

**4.2.3 调用 `branch-auto-create` skill**

1. 检查当前分支
2. 如果在 `master` / `main`：使用 4.2.1 校验通过的 `EXPECTED_BRANCH` 创建
3. 如果已在 `feat/` 分支 → 跳过创建

**产出物检查点：** ✅ 工作区干净；✅ 当前分支命中规范正则 `^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-[0-9]{4}-[a-z0-9-]+$`。

**STEP 4 埋点（v0.31+ 统一规约）**：

> 🔴 STEP 4 跨越分水岭：4.1/4.2 用 `$PENDING_DIR`、4.3 后用 `$METRICS_DIR`。**begin 写 PENDING、end 写 METRICS**，archive 端按 stage 名 `start.step4` 配对。

```bash
# STEP 4 开始（4.1 顶部，分支未确定，写 PENDING_DIR）
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step4","phase":"begin","ts":'$NOW_MS'}' \
  >> "$PENDING_DIR/timeline.log" 2>/dev/null || true

# STEP 4 结束（4.3 末尾，已合并到 METRICS_DIR，写 METRICS_DIR）
# ⚠️ 仅在平台 usage 元数据中看到真实 token 时才赋值，读不到保持未赋值
TOKEN_IN=        # 读取平台 usage 元数据中的 input_tokens；读不到留空
TOKEN_OUT=       # 同上
IDLE=            # 4.1 等用户处理 git status / 4.2 等用户回复分支选择 → 仅当能从 timestamp 明确算出时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step4","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

---

#### 4.3 metrics 目录归位（确定 change-name 后立即执行）

分支创建/确认后，从分支名提取 `<change-name>`（slug 部分），将 STEP 1-3 写入的 `$PENDING_DIR`（根级 `.pending/`，与 change-name 无关）整体合并到正式目录：

```bash
# 从分支名提取 slug 作为 change-name（与 feai-review / feai-archive 保持完全一致）
# 支持 feat | fix | feature | hotfix | chore 五种前缀
# 用 .* 贪婪匹配，吃到最后一段 4 位 MMDD —— 兼容用户名含连字符（如 eric-hu / zhang-san-feng）
CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | sed -E 's|^(feat\|fix\|feature\|hotfix\|chore)/.*-[0-9]{4}-||')
# Fallback：剥不出来（说明 4.2 校验被 FORCE-CONTINUE 强制跳过）→ 回退为整个分支名（/ 替换为 -），保证 CHANGE_NAME 永远非空
if [ "$CHANGE_NAME" = "$(git rev-parse --abbrev-ref HEAD)" ]; then
  CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
fi
FINAL_DIR="<base>/.codebuddy/.cache/metrics/${CHANGE_NAME}"
# PENDING_DIR 在 STEP 1 顶部已初始化为根级 .pending；此处不重新赋值，确保跨 STEP 一致
: "${PENDING_DIR:=<base>/.codebuddy/.cache/metrics/.pending}"

# 合并 .pending 到正式目录（已存在则追加）
if [ -d "$PENDING_DIR" ]; then
  mkdir -p "$FINAL_DIR"
  for f in "$PENDING_DIR"/*; do
    [ -f "$f" ] && cat "$f" >> "$FINAL_DIR/$(basename "$f")" 2>/dev/null || true
  done
  rm -rf "$PENDING_DIR" 2>/dev/null || true
fi
# 4.3 之后所有埋点统一写入 $METRICS_DIR；4.3 之前严禁使用 $METRICS_DIR
METRICS_DIR="$FINAL_DIR"

# ⚠️ 漂移目录自检：检测 STEP 1-3 是否有 AI 违规自造的孤儿目录
# 触发条件：metrics 根目录下存在「不是 .pending、不是当前 CHANGE_NAME、最近 60 分钟内修改过」的子目录
ORPHAN_DIRS=$(find "<base>/.codebuddy/.cache/metrics" -maxdepth 1 -mindepth 1 -type d \
  ! -name "$CHANGE_NAME" ! -name ".pending" -mmin -60 2>/dev/null)
if [ -n "$ORPHAN_DIRS" ]; then
  cat <<EOF
🔴 检测到本次 /feai-start 期间生成的孤儿 metrics 目录（疑似 AI 在 STEP 1-3 违规自造 change-name，或 prd-creator 输出 SLUG 与最终分支名不一致）：
$ORPHAN_DIRS
   预期目录：$FINAL_DIR
   分支名：$(git rev-parse --abbrev-ref HEAD)
   公式产物 CHANGE_NAME：$CHANGE_NAME

⛔️ 强制阻断：命名漂移会导致 /feai-archive 聚合诊断指标时找不到目录，最终上报的 efficiency / flowHealth / ruleEffectiveness 全部为 null。
   AI 禁止做以下事情：
     ❌ 静默忽略本警告继续 STEP 5
     ❌ 询问用户「能否凑活用这个孤儿目录」并自作主张合并
     ❌ 把 \$CHANGE_NAME 改成孤儿目录名以"对齐"
   AI 必须做的事情（必须由用户字面回复触发）：
     [m] 把孤儿目录内容追加合并到 \$FINAL_DIR，再 rm -rf 孤儿目录（推荐，且需用户字面回复 'm' 确认）
     [r] 用户手动重命名分支 + 重命名孤儿目录使两端对齐，然后重新运行 /feai-start
     [a] 放弃本次 /feai-start，用户排查上游 SLUG 漂移根因后重来
EOF
  exit 1
fi
```

---

### [STEP 5/8] 需求规模判定 + Agent 模式选择

> 对应规则 G11 / G17

根据 `prd-creator` 前的初步评估或 `--quick` / `--full` 参数判定：

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

**STEP 5 完成时强制埋点（对应 quick 模式滥用追踪）**：

```bash
# DECLARED：用户输入的模式（quick / standard / full）；SCALE：规模评估（S/M/L）
DECLARED="<quick|standard|full>"
SCALE="<S|M|L>"
# 白名单归一化：防止占位符未替换或填非法值导致脏数据入库（合法但语义错误的污染比非法 JSON 更难发现）
case "$DECLARED" in quick|standard|full) ;; *) DECLARED="unknown" ;; esac
case "$SCALE" in S|M|L) ;; *) SCALE="unknown" ;; esac
cat > "$METRICS_DIR/mode-choice.json" 2>/dev/null <<EOF || true
{"declared":"$DECLARED","scaleEvalAtPlan":"$SCALE"}
EOF
```

**产出物检查点：** ✅ 规模级别已确定；✅ Agent 模式已确定；✅ mode-choice.json 已写入。

---

### [STEP 6/8] 需求澄清（prd-creator）+ 技术设计探索（brainstorming）

> 对应规则 G12（Skill 调用强制规则）
>
> ⚡ **Skill 路由规则（v0.35+）**：
> - **需求澄清**（用户是谁、场景、范围边界、站点范围、TAPD 建单）→ 使用 `prd-creator`
> - **技术设计探索**（架构方案、组件拆分、边界 case、实现策略）→ 使用 `brainstorming`，且只聚焦技术侧，**不重复问产品范围**
> - **快速修复模式**（`--quick`）→ prd-creator 简化为一次性确认，跳过 brainstorming

#### 6.1 需求澄清（prd-creator，强制）

1. 调用 `.agents/skills/product-skills/prd-creator` skill（**强制 use_skill tool call**，不可口头跳过）
   - `mono2/.agents/skills/product-skills` 是主仓目录，直接使用当前分支中的 `prd-creator`；不要在调用前从 `product-ai` 反向覆盖。
2. 按 skill 指导与用户完成 LightVela 产品前置和需求澄清
3. 生成需求确认文档，并明确输出一个英文 `feature slug`（仅 `[a-z0-9-]`）
4. ⏸️ **等待用户确认**，禁止跳过此步骤直接进入 6.2

> 快速修复模式（`--quick`）下，`prd-creator` 简化为一次性确认提问，不生成完整确认文档，直接跳过 6.2 进入 STEP 7。

#### 6.2 技术设计探索（brainstorming，条件触发）

> 仅当需求涉及非平凡技术设计（新架构、组件重构、复杂状态管理、性能优化等）时触发。
> 简单需求（文案修改、样式调整、小 Bug 修复）可跳过此步。
> ⚠️ 产品范围已在 6.1 prd-creator 阶段确认，本步骤**只探索技术实现方案**，不重复问用户场景和范围。

1. 调用 `brainstorming` skill（**强制 use_skill tool call**）
2. 聚焦探索：
   - 技术方案与备选方案（提供 2-3 个选项）
   - 组件结构与状态管理策略
   - 边界情况与错误处理
   - 性能考量
3. 产出技术设计方向，供 STEP 7/8 规划使用

**STEP 6 完成时强制埋点（对应澄清轮次追踪）**：

```bash
# ROUNDS：本次 prd-creator 与用户的需求澄清问答来回轮数（AI 自数）
# HAS_FIGMA：本需求是否涉及 Figma UI 还原（true/false）
ROUNDS=3
HAS_FIGMA=false
# ⚠️ 布尔归一化：用户误填中文/其他字符时强制为 false，避免生成 "hasFigma":是的 这种非法 JSON
case "$HAS_FIGMA" in true|false) ;; *) HAS_FIGMA=false ;; esac
echo '{"rounds":'${ROUNDS:-null}',"hasFigma":'$HAS_FIGMA'}' \
  >> "$METRICS_DIR/clarification.log" 2>/dev/null || true
```
**产出物检查点：** ✅ 需求分析完成，对功能范围、边界、交互达成共识；✅ clarification.log 已写入。

**STEP 6 埋点（v0.31+ 统一规约）**：

```bash
# STEP 6 开始（prd-creator skill 调用前）
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step6","phase":"begin","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true

# STEP 6 结束（用户确认需求分析后）
# ⚠️ 仅在平台 usage 元数据中看到真实 token 时才赋值
TOKEN_IN=        # prd-creator 含完整对话历史，token 通常较大；仅当能从 usage 元数据读到时填
TOKEN_OUT=       # 同上
IDLE=            # 苏格拉底式问答：用户思考 + 回复占大头；仅当能从 timestamp 明确算出时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step6","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

---

---

### [STEP 7/8] Figma 结构分析（条件触发，sub-agent 派发）

> ⚠️ 本步骤通过派发 **figma-analyzer sub-agent** 执行，目的是**隔离 Figma MCP 原始数据，避免污染主上下文**。
> 详见 `.workflow/agents/figma-analyzer.md`。

#### 7.1 触发条件（自动检测）

满足以下任一即进入本步骤：
- 用户消息包含 `figma.com` URL
- `prd-creator` 阶段确认本需求涉及 UI 还原

**不满足 → 跳到 STEP 8**（纯逻辑/重构需求无需 Figma 分析）。

#### 7.2 派发 sub-agent

从用户消息或 `prd-creator` 结论提取：
- `figmaUrl`、`feature`（与分支名后缀一致的英文 slug）、`rootNodeId`、`scope`

通过 `Agent` 工具派发 `figma-analyzer`，prompt 模板：

```
你是 figma-analyzer sub-agent，参考 .workflow/agents/figma-analyzer.md 执行 Figma 结构分析。

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

**STEP 7 埋点（v0.31+ 统一规约，仅在触发条件成立时写入）**：

```bash
# STEP 7 开始（派发 figma-analyzer sub-agent 前）
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step7","phase":"begin","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true

# STEP 7 结束（sub-agent 返回摘要 + 用户确认分批计划后）
# ⚠️ 仅在平台 usage 元数据中看到真实 token 时才赋值
TOKEN_IN=        # Figma MCP 节点数据较大；仅当能从 usage 元数据读到时填
TOKEN_OUT=       # 同上
IDLE=            # 仅当能从 timestamp 明确算出等待时间占比时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step7","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

> ⚠️ STEP 7 跳过（不涉及 Figma）时**不要写埋点**，否则 archive 端会误判为耗时为 0 的有效 stage。

---

---

### [STEP 8/8] 生成 OpenSpec 产物 + 门禁检查

> 对应规则 G3 / G10 / G21

#### 8.1 调用 `writing-plans` skill（强制）

> 🔴 **强制约束（v0.32+ 防 AI 偷懒）**：本步**必须**真实调用 `writing-plans` skill 生成产物，**禁止**为了"看起来执行了"而手写 plan.md 跳过 skill。
>
> AI **必须在 skill 调用前后输出以下两条固定声明**（用户和 archive 阶段都会回查）：
>
> 1. 调用前：`📞 STEP 8.1: 即将调用 writing-plans skill 生成 {S 级 plan.md / M-L 级 proposal+spec+plan}`
> 2. 调用后：`✅ STEP 8.1: writing-plans skill 已返回，产物路径 = {plan.md 等的实际路径}`
>
> 这两条声明**不是日志，是 AI 必须输出给用户看的可见文本**，archive 阶段会通过 timeline.log 的 `skillCalled=true` 字段交叉校验。

**STEP 8 开始埋点（writing-plans skill 调用前）**：

```bash
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step8","phase":"begin","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```


1. 按 STEP 5 判定结果生成产物：
   - **S 级**：仅 `<base>/openspec/plan.md`
   - **M / L 级**：`proposal.md` + `spec.md` + `plan.md`
2. **如果 STEP 7 已生成 `_overview.md`** → writing-plans 必须 Read 该文件，按 section 拆分 plan.md 任务

**STEP 8.1 完成后必填埋点（skillCalled 自报，对应 G23 真实性约束）**：

```bash
# ⚠️ skillCalled 由 AI 自报：true=本轮真实调用了 writing-plans skill；false=跳过/手写
# 🔴 禁止伪报：archive 阶段会用此字段统计"工作流真实执行率"，伪报等同于伪造遵从信号
SKILL_CALLED=true   # AI 必须按事实填写 true / false
SKILL_REASON=       # 若 false，必须填写跳过原因（如 "S 级简单需求手写更快"）
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
jq -nc --arg called "$SKILL_CALLED" --arg reason "${SKILL_REASON:-}" --argjson ts $NOW_MS \
  '{stage:"start.step8.skill",phase:"end",skillCalled:($called=="true"),reason:$reason,ts:$ts}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

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

#### 8.2.5 同步更新 `current_state.md`「进行中需求」段（v0.33+ 强制）

> 💡 **为什么**：参考 skillhub 实证，`current_state.md` 在需求开发期就应该指向"当前进行中的需求"，而不只是归档后才更新。这样：
> - 任意时刻打开 `current_state.md` 能直接看到"项目目前在做什么 / 阶段进行到哪一步"
> - 跨会话恢复上下文时，AI 加载 P0 看到指针就知道"接着干哪个需求"
> - 与 plan.md / proposal.md / spec.md 的"当前需求快照"语义一致，4 个文件协同表达项目状态

**写入约束**：

- ✅ **追加 / 替换**「## 当前进行中」段（位于「上一个需求」之上，「历史归档」之上）
- ✅ 段内字段：需求名 / 启动日期 / TAPD 链接（如有）/ 分支名 / 规模(S/M/L) / 当前阶段
- ❌ **不动**「上一个需求」「历史归档」段（这两段是归档完成时才追加的）
- ❌ 不删除现有 current_state.md 内容（追加 / 替换段落，不重写整个文件）

**目标段格式**：

```markdown
# 当前需求状态

## 当前进行中

- **需求名**：{需求名（与 plan.md 顶部一致）}
- **启动日期**：YYYY-MM-DD
- **TAPD**：{story-128613253 / 文字描述}
- **分支**：`{当前 git 分支}`
- **规模**：{S/M/L}
- **当前阶段**：规划已完成（plan.md 已确认），等待进入执行阶段

> 上一个需求：……（归档时才更新，本步不动）
> 历史归档：……（归档时才追加，本步不动）
```

**写入伪命令（AI 必须真实执行写入，不得跳过）**：

```bash
# ⚠️ 1. 字段全部由当前会话上下文填充，禁止用占位符（如 {需求名}）写入文件
# ⚠️ 2. TAPD 字段：能从 prd-creator 阶段推出 story id 才写，否则填用户输入的文字描述
# ⚠️ 3. 当前阶段：plan.md 用户确认后此处固定填"规划已完成（plan.md 已确认），等待进入执行阶段"
# ⚠️ 4. 必须用 awk / sed / python 做"段落级替换或追加"，禁止 cat > 整文件覆盖
#       否则会丢失「上一个需求」「历史归档」段（这两段是项目级长期记忆）
```

**正面示范代码（AI 必须用此实现，不允许偷懒 `cat >`）**：

```bash
# 上下文变量（AI 从会话填充，禁止占位符）
CSF="<base>/openspec/current_state.md"
FEATURE_TITLE="<本次需求名（与 plan.md H1 标题一致）>"
START_DATE=$(date +%Y-%m-%d)
TAPD_INFO="<story-128613253 / 文字描述>"
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD)
SCALE="<S/M/L>"
PHASE="规划已完成（plan.md 已确认），等待进入执行阶段"

# 用 python 段落级写入（已存在则替换，不存在则在 H1 下追加）
python3 - "$CSF" "$FEATURE_TITLE" "$START_DATE" "$TAPD_INFO" "$CUR_BRANCH" "$SCALE" "$PHASE" <<'PY'
import sys, re
csf, name, date, tapd, branch, scale, phase = sys.argv[1:8]
with open(csf, encoding='utf-8') as f:
    src = f.read()

block = (
    f"## 当前进行中\n\n"
    f"- **需求名**：{name}\n"
    f"- **启动日期**：{date}\n"
    f"- **TAPD**：{tapd}\n"
    f"- **分支**：`{branch}`\n"
    f"- **规模**：{scale}\n"
    f"- **当前阶段**：{phase}\n"
)

if re.search(r'^## 当前进行中\n', src, flags=re.M):
    # 已存在 → 段落级替换（保留上下文中其它段）
    new = re.sub(
        r'## 当前进行中\n.*?(?=\n## |\n> 上一个需求|\n> 历史归档|\Z)',
        block.rstrip() + '\n',
        src,
        count=1,
        flags=re.S,
    )
else:
    # 不存在 → 在 H1 后追加（注意保留 H1 行）
    new = re.sub(
        r'(^# [^\n]+\n)',
        r'\1\n' + block,
        src,
        count=1,
        flags=re.M,
    )

with open(csf, 'w', encoding='utf-8') as f:
    f.write(new)
PY

# 写后自检
grep -q '^## 当前进行中' "$CSF" || { echo "❌ 8.2.5 写入失败"; exit 1; }
grep -q '^> 历史归档' "$CSF" 2>/dev/null \
  || grep -q '^> 上一个需求' "$CSF" 2>/dev/null \
  || true   # 首次运行项目可能两段都没有，不强制
```

**写入策略**：
| 现状 | 操作 |
|------|------|
| 文件不存在「## 当前进行中」段 | 在「# 当前需求状态」标题下方第一行追加该段 |
| 已存在「## 当前进行中」段（异常：上次需求未走完归档就开新需求） | **不覆盖**，提示用户「检测到 current_state.md 有未结束的进行中需求，是否合并 / 强制覆盖」，由用户字面确认 |

**STEP 8.2.5 完成后必填埋点**：

```bash
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step8.currentStateUpdated","phase":"end","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

#### 8.3 grep 硬校验（强制，违反即回退）

```bash
# 1. 检查至少有 1 条任务
grep -c "^\- \[ \]" "<base>/openspec/plan.md"
# 结果为 0 → plan.md 无效，禁止结束本流程，必须修正

# 2. 检查产物索引段（如适用）
grep -c "上下文产物" "<base>/openspec/plan.md"
# 结果为 0 且 STEP 7 有产物 → 必须补充

# 3. 校验 writing-plans skill 调用事实（v0.32+ 强约束）
grep -c '"stage":"start.step8.skill"' "$METRICS_DIR/timeline.log" 2>/dev/null
# 结果为 0 → 说明 8.1 后续埋点漏写或 skill 没真调用，必须补埋点 + 复核 skill 调用
# 结果为 1 但 skillCalled=false 且 reason 为空 → 必须让 AI 补 reason

# 4. 校验 8.2.5 current_state.md 已注入「## 当前进行中」段（v0.33+ 强约束）
grep -c '^## 当前进行中' "<base>/openspec/current_state.md" 2>/dev/null
# 结果为 0 → 说明 8.2.5 被跳过，必须补写后再继续 8.4
grep -c '"stage":"start.step8.currentStateUpdated"' "$METRICS_DIR/timeline.log" 2>/dev/null
# 结果为 0 → 8.2.5 埋点缺失，必须补埋点
```

#### 8.4 门禁检查（gate-planning.md）

对照 `<base>/.workflow/checklists/gate-planning.md` 逐项检查，输出门禁结论：**通过 / 打回 / 有条件通过**。

#### 8.5 等待用户确认 plan.md

⏸️ ⏸️ ⏸️ 用户确认前**禁止进入执行阶段**（违反 G3）。

**用户确认 plan.md 时强制埋点（标记规划阶段结束、执行阶段开始）**：

```bash
# STEP 8 结束 + planConfirmed 双埋点（同一时刻写两条）
# ⚠️ 仅在平台 usage 元数据中看到真实 token 时才赋值
TOKEN_IN=        # 读取平台 usage 元数据中的 input_tokens；读不到留空
TOKEN_OUT=       # 同上
IDLE=            # 仅当能从 timestamp 明确算出时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
# step8 end：用于聚合诊断耗时
echo '{"stage":"start.step8","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
# planConfirmed end：标记规划→执行分水岭（沿用 v0.28+ 既有埋点，archive 端依赖此点）
echo '{"stage":"start.planConfirmed","phase":"end","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

**产出物检查点：** ✅ plan.md 存在且包含至少 1 条 `- [ ]` 任务；✅ 产物索引段已注入（如适用）；✅ current_state.md 已注入「## 当前进行中」段；✅ gate-planning 门禁通过；✅ 用户已确认；✅ planConfirmed 时间戳已记录。

---

## 规划完成输出

```
📌 需求开启清单
├── ✅ 上下文：projectRoot={X}，P0 文件加载完毕
├── ✅ 防遗忘：1.2 plan.md状态={A/B/C}/L3扫到{N}个历史遗留目录/L4 检测{已通过/已忽略}
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
阶段 4C: 主动 CR 检查（仅检查，不 commit）
         cr-check → P0/P1/P2 全部修复
              │
              ▼
阶段 4D: ⭐ /feai-archive ⭐ 首次归档（v0.28.x+ 调整为 commit 之前）
         沉淀 spec / 经验 / 知识库；产物只生成不 commit，由阶段 5 一起原子提交
              │
              ▼
阶段 5:  代码 + 归档产物 原子提交 → 自检 → 创建 MR
         git commit（按 global.md G14 + ai-usage-tracking 注入 FE-AI 标记）
         → requesting-code-review → verification-before-completion → mr-auto-submit
              │
              ▼
阶段 6:  L1 防遗忘兜底（仅当 4D 被跳过时触发）
         若 MR 已创建但归档产物未随代码提交 → 强提醒「再次运行 /feai-archive 增量补归档」
```

> 💡 **为什么 archive 提前到 commit 之前？**
> 归档产物（`openspec/changes/{YYYY-MM-DD}-{change-name}.md`、`knowledge/`）是项目知识资产，必须随代码一起进主干。
> 若先 commit + 提 MR 再归档，归档只能作为追加 commit 出现在 MR 中，污染 MR 历史、且评审者无法把「代码 + 知识沉淀」作为同一个原子单元审核（合并后再补归档还存在被遗忘的风险）。

### 快速修复模式（`--quick`）省略项

- ❌ STEP 1.3 / 1.4（L3 / L4 防遗忘扫描）
- ❌ STEP 6.1（prd-creator）— 改为简短确认；STEP 6.2（brainstorming）— 跳过
- ❌ STEP 7（Figma 分析）
- ❌ 阶段 4B（TAPD 分支关联）
- ❌ 阶段 6（L1 归档强提醒）

---

## 阶段 6：L1 防遗忘兜底（MR 创建成功后，仅当 4D 被跳过时触发）

> v0.28.x+ 已将 archive 前置到阶段 4D（commit 之前）。
> 本阶段降级为**兜底机制**：仅当检测到「MR 已创建但归档产物未随代码进入本次 commit」时才触发，避免用户误跳 4D 后归档断档。

### 触发条件

执行如下检查，**任一**为真则触发卡片：

```bash
# 1. 当前分支最近一次 commit 是否包含归档产物？
#    兼容两种形态：
#      • v0.29+ 扁平单文件：openspec/changes/{YYYY-MM-DD}-{change-name}.md
#      • v0.28-  archive 子目录：openspec/changes/archive/{date}-{name}/
LAST_COMMIT_HAS_ARCHIVE=$(git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null \
  | grep -E '^openspec/changes/(archive/|[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$)|^knowledge/' | head -1)

# 2. 工作区是否存在未提交的归档产物？
UNCOMMITTED_ARCHIVE=$(git status --porcelain 2>/dev/null \
  | grep -E ' (openspec/changes/(archive/|[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md)|knowledge/)' | head -1)

# 触发条件：最近 commit 没有归档产物 AND 工作区也没有归档产物 → 4D 大概率被跳过
if [ -z "$LAST_COMMIT_HAS_ARCHIVE" ] && [ -z "$UNCOMMITTED_ARCHIVE" ]; then
    SHOW_L1_FALLBACK=1
fi
```

### 触发后输出卡片

```
🎉 MR 创建成功！

┌─────────────────────────────────────────────────┐
│  ⚠️ 检测到本次未归档（阶段 4D 被跳过）            │
├─────────────────────────────────────────────────┤
│                                                 │
│  不归档会发生什么？                             │
│    • 项目知识散落在各 MR 里，无法复用           │
│    • 下次 AI 开发时仍"不懂项目"                 │
│    • 团队无法形成知识资产                       │
│                                                 │
│  ✨ 现在补归档（追加 commit 到当前 MR）：         │
│                                                 │
│     /feai-archive                                │
│                                                 │
│  ➤ 是否现在补归档？[Y/n]                        │
└─────────────────────────────────────────────────┘
```

| 用户回复 | AI 行为 |
|---------|---------|
| `Y` / `y` / 直接回车 | 立即执行 `/feai-archive`，归档产物作为追加 commit 推到当前 MR |
| `n` / `N` | 记录跳过，提示"已记录待办，下次 /feai-start 会扫描提醒" |
| 其他 | 视为未明确回复，再次简短询问一次 |

> ⚠️ 与 STEP 1.3 形成闭环：用户此时跳过 → 下次 `/feai-start` 旧账扫描会强制提醒。
>
> 💡 与阶段 4D 的关系：4D 是**默认路径**（推荐，干净 MR）；阶段 6 是**兜底路径**（仅在 4D 被跳过时触发，会产生追加 commit）。

---

## 失败处理

| 失败点 | 处理方式 |
|-------|---------|
| STEP 1 P0 文件加载失败 | 停止，提示用户检查 `<base>/openspec/` 目录 |
| STEP 3 插件缺失且安装失败 | 停止，输出手动安装指南 |
| STEP 4 工作区不干净 | 停止等待用户处理，禁止替用户决定 |
| STEP 6.1 prd-creator skill 未真实调用 | 视为违反 G12，回退重新调用 |
| STEP 6.2 brainstorming skill 未真实调用（非 --quick 模式且需求涉及非平凡技术设计时） | 视为违反 G12，回退重新调用 |
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
| 项目上下文 | `<base>/.workflow/project.yaml`（`context:` 段）+ `<base>/openspec/specs/*.md` | STEP 1 加载 |
| 已有变更 | `<base>/openspec/changes/` | STEP 1.3 / 1.4 扫描 |
| TAPD 需求 | `tapd-requirement-fetch` skill | STEP 2 |
| 插件清单 | `<base>/.workflow/project.yaml` | STEP 3 |
| 当前分支/工作区 | `git status --porcelain` / `git branch --show-current` | STEP 4 |
| 用户名 | `git config user.name` → `whoami` | STEP 4 分支命名 |
| 检查清单 | `<base>/.workflow/checklists/gate-planning.md` | STEP 8 |
