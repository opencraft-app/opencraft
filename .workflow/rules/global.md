# 全局工作流规则

> 适用于所有 Agent 角色（单 Agent 模式的 default agent，多 Agent 模式的所有成员）。
> 本文件是 feai 工作流的"宪法"，定义了所有 AI 协同动作必须遵守的硬性纪律。
>
> 路径约定：
> - 工作流核心配置（本文件、agents/、rules/、checklists/、project.yaml）位于 `项目根/.workflow/`
> - 业务产物（plan.md、specs/、proposal.md、spec.md、changes/）位于 `项目根/openspec/`

---

## G1：禁止盲目编码

在没有读取 `openspec/` 目录下的最新状态前，**绝不能编写或修改任何业务代码**。

## G2：以 OpenSpec 为唯一事实来源

`openspec/plan.md` 是唯一执行依据。如果用户需求不在规范中，必须先要求用户更新规范。

## G3：plan.md 门禁（硬性）

无论需求大小，在编写任何业务代码之前，`openspec/plan.md` 中必须存在有效的任务列表（至少包含一条 `- [ ]` 任务）。如果 plan.md 为空或仅包含占位符，**禁止进入执行阶段**。即使用户说"开始实现"或"直接写代码"，也必须先完成 plan.md 的生成和确认。

## G4：停机询问机制（Stop-and-Ask）

如果测试连续失败 3 次，或者遇到未记录的边界情况，立即停止运行。禁止猜测，直接向用户说明情况并确认。

## G5：先加载上下文，再做任何事

必须遵守 `.workflow/project.yaml` 中的 `context_loading` 协议，在行动前完成全部 P0 文件的加载。P1/P2/P3 按需加载。

## G6：对话全部用中文

所有对话全部用中文。

## G8：分支管理

开始新需求开发时，必须检查当前 Git 分支。如果当前分支是 `master` / `main`，**必须创建并切换到新分支**，禁止在主分支上直接开发。分支命名规则：`feat/{currentuser}-{MMDD}-{需求英文简称}`，其中 `currentuser` 取自 `git config user.name`（兜底 `whoami`），并做 slug 化处理（小写、空格转 `-`、保留 `[a-z0-9-]`）。

**前置约束（强制）：** 创建新分支前必须执行 `git status --porcelain` 检查工作区。如果存在任何未提交内容（已修改 / 已暂存 / 未跟踪），**禁止**自动 stash / 自动 commit / 强制切换分支，必须先向用户列出未提交变更并等待用户明确选择处理方式（commit / stash / 放弃 / 取消流程），用户处理完毕后才能继续。

## G9：配置优先

执行前必须读取 `.workflow/project.yaml`，了解当前工作流配置、Agent 模式、质量要求等。

## G10：阶段门禁不可跳过

每个阶段完成后，必须对照 `.workflow/checklists/gate-*.md` 逐项检查。所有检查项通过后才能进入下一阶段。门禁结论：**通过 / 打回 / 有条件通过**。

## G11：角色不越权（多 Agent 模式）

多 Agent 模式下，各角色只执行自身职责。Leader 严禁并行唤醒多个 agent，必须串行执行：前一个 agent 完成 + 审核通过后才唤醒下一个。

## G12：Skill 调用强制规则

所有明确标注"调用 skill"的地方，都是强制调用，必须真实执行 `use_skill` tool call。禁止：

- ❌ 不实际调用就继续下一步
- ❌ 声称"skill 已加载"但实际未调用
- ❌ 用自己的知识替代 skill 的输出

## G13：回退与恢复

| 场景 | 操作 |
|------|------|
| 单个任务实现失败 | `git stash` 保存现场 → 调用 `systematic-debugging` skill → 修复后 `git stash pop` |
| 整批任务导致回归 | `git checkout -- .` 回退所有未提交改动 → 重新分析 plan |
| 需求方向变更 | 清空 `openspec/` 相关文件 → 重新进入规划阶段 |
| Stop-and-Ask 触发后 | 向用户提供：① 问题根因 ② 2-3 个可行方案 ③ 是否需要调整 plan |

## G14：沟通风格

- 表达务实、简明扼要，直奔主题
- 始终输出正在运行的具体终端命令，保持执行过程透明
- 需要用户决策时，主动提供 2-3 个具备可行性的选项
- 每完成一批任务，主动汇报进度：已完成 X/Y 个任务，下一批计划做什么

## G16：插件依赖检查

工作流启动前（执行任何 skill 调用前），必须检查 `.workflow/project.yaml` 中声明的 `dependencies.plugins` 是否可用。

检查方式：尝试调用 `Skill` 工具加载任一依赖 skill（如 `brainstorming`），如果失败则：

1. 提示用户安装缺失插件
2. 提供安装命令（具体命令以工具/IDE 文档为准）
3. 等待安装完成后再继续工作流

禁止在插件不可用的情况下跳过 skill 调用或用自身知识替代。

## G17：L 级需求 Leader 禁止直写代码

L 级需求中，Leader 的唯一职责是调度和审核。禁止 Leader 直接创建/修改业务代码文件（组件、hooks、页面、样式等）。如果发现自己在写组件/hooks/页面代码，立即停止，改为派发对应角色 Agent。

此规则不可被任何 skill 输出的"直接执行"选项覆盖。

## G18：启动拦截（最高优先级）

无论任何需求、任何场景，在开始执行前**必须**完成以下前置步骤，缺一不可：

1. 读取 `.workflow/project.yaml` → 确认工作流模式和 context_loading 协议
2. 按 `context_loading` 中的 P0 清单加载全部必读文件
3. 读取 `openspec/plan.md` → 确认存在有效的 `- [ ]` 任务
4. 多 Agent 模式下 → 只使用 `.workflow/agents/` 目录中定义的角色（leader/planner/implementer/developer/reviewer），禁止自创角色名称
5. 确认协作顺序 → Leader → Implementer（先 UI）→ Developer（后逻辑）→ Reviewer，严格串行

**以上步骤未全部完成前，禁止：**

- ❌ 编写或修改任何业务代码
- ❌ 创建或派发任何 Agent
- ❌ 跳步进入执行阶段

**不可因"急于产出"、"需求简单"、"用户催促"等理由跳过任何步骤。** 不确定时停下来问用户。

## G19：禁止工具替代工作流

以下 AI 工具/行为**在本项目中禁止使用**，因为它们会绕过项目定义的工作流：

- ❌ **禁止使用 `EnterPlanMode` / `ExitPlanMode` 工具** — 规划产物必须写入 `openspec/` 目录，不得使用 IDE 内置 plan mode 替代
- ❌ **禁止将规划内容写入非工作流路径** — 如 `.codebuddy/plans/`、`docs/plans/` 等不是项目工作流认可的规划产物存储位置
- ❌ **禁止在 `openspec/plan.md` 生成前使用 `Write` / `Edit` 工具创建业务代码文件** — 包括类型定义、API 函数、组件、hooks 等
- ❌ **禁止调用 skill 后不按 skill 指导执行** — 调用 skill 后必须按其输出完成对应产物，不可口头承认后按自己的默认行为执行

违反以上任何一条，等同于违反 G18（启动拦截），必须立即停止并回退。

## G20：强制步骤追踪格式

执行 `/feai-start` / `/start-feature` 或任何跨阶段工作流时，**每一步必须输出步骤编号**，格式：

```
[STEP N/M] 正在执行：{步骤描述}
```

示例：

```
[STEP 1/6] 正在执行：读取 .workflow/project.yaml 确认工作流配置
[STEP 2/6] 正在执行：加载 P0 文件（current_state.md、plan.md）
[STEP 3/6] 正在执行：调用 prd-creator skill 进行需求澄清 + brainstorming skill 进行技术设计探索
```

**未输出步骤编号即执行操作，视为跳步违规。**

## G21：产物路径强制约束

所有工作流阶段的产出物**必须且只能**写入以下路径：

| 阶段 | 产出物 | 路径 |
|------|--------|------|
| 规划 | 需求提案 | `openspec/proposal.md` |
| 规划 | 技术规格 | `openspec/spec.md` |
| 规划 | 执行计划 | `openspec/plan.md` |
| 规划 | 当前状态 | `openspec/current_state.md` |
| 执行 | 变更记录 | `openspec/changes/` |
| 执行 | 历史归档 | `openspec/changes/{YYYY-MM-DD}-{change-name}.md`（扁平单文件） |

**写入到其他路径的规划类文件（如 `docs/plans/`、`.codebuddy/plans/`、项目根目录）不被视为有效产物，不满足门禁检查条件。**

## G22：未归档变更优先（防遗忘硬约束）

当 `<base>/openspec/changes/` 下存在**子目录形态的开发期变更**（仅包含 `{change-name}/` 开发期多文件目录）时，**禁止**进入新需求的规划阶段（已归档的 `{YYYY-MM-DD}-{change-name}.md` 扁平单文件不在拦截范围），包括但不限于：

- ❌ `/feai-start` 命令的 STEP 2-8（需求获取、插件检查、分支创建、规模判定、brainstorming、Figma 分析、生成 plan.md）
- ❌ 普通对话中用户直接描述新需求时直接进入规划/编码
- ❌ 任何形式的"先开新需求，归档稍后做"

**唯一豁免方式：**

用户必须明确回复包含字面字符串 `SKIP-ARCHIVE` 的二次确认（不区分大小写），且 AI 必须在确认前向用户**列出全部未归档变更清单**及它们各自的创建天数。仅回复 `s` / `跳过` / `skip` / `稍后再说` 等含糊表述**不构成豁免**。

**正确示例：**

```
AI:  ⚠️ 检测到 2 个未归档变更：
       • feature-batch-import   （创建 12 天前）
       • bugfix-pagination      （创建 3 天前）
     按照 G22，必须先归档才能进入新需求。
     如确需跳过，请回复 SKIP-ARCHIVE 并说明原因。
用户: SKIP-ARCHIVE 这些变更等下个版本再统一归档
AI:  ✅ 已记录跳过原因，进入 STEP 2。
```

**错误示例（违反 G22）：**

```
AI:  检测到未归档变更，是否继续？[y/n]
用户: y
AI:  好的，进入 STEP 2...      ← ❌ 没有 SKIP-ARCHIVE 二次确认
```

违反 G22 视同违反 G18（启动拦截），必须立即回退到归档流程或要求用户补充 SKIP-ARCHIVE 二次确认。

## G23：工作流诊断埋点（v0.28.0+ 强制）

为了让团队能基于真实数据持续改善工作流，所有 `/feai-*` 命令在每个 STEP 边界**必须**向 `.codebuddy/.cache/metrics/<change-name>/` 目录写入埋点日志：

| 时机 | 必须写入 |
|------|---------|
| STEP 开始时 | `timeline.log` 追加 `{stage,phase:"begin",ts}` |
| STEP 结束时 | `timeline.log` 追加 `{stage,phase:"end",ts,tokenIn,tokenOut}`（`userIdleRatio` v0.31 起 deprecated，允许留空；v0.34 下线了原 `outputChars` 输出侧估算路径） |
| `/feai-review` 出结论时 | `gates.log` 追加 `{batch,attempt,result,failedChecks,rejectReason,durationSec}` |
| 用户回复 `SKIP-ARCHIVE` 时 | `explicit-skips.log` 追加 `{rule:"G22",reason,at}` |
| prd-creator 完成时 | `clarification.log` 追加 `{rounds,hasFigma}` |

### AI 自报字段（核心约束）

`tokenIn` / `tokenOut` 这两个字段没有 shell 兑底渠道，只能由 AI 从运行平台的 **usage 元数据**（如 `usage.input_tokens` / `usage.output_tokens`）读取后填入：

- ✅ **只能**：从平台 usage 元数据读取真实数字后填写
- ✅ **必须**：读不到时填 `null`（聚合脚本会跳过）
- ❌ **严禁**：根据「对话长度感觉」「输入文件体量」估算一个看似合理的数字；archive 阶段会被 `dataIntegrity.tokenSource` 标记为 `ai-estimated`、不能跨需求对比
- ❌ **不允许**：填 `0` 凑个数字偺装完成
- ❌ **不允许**：因“埋点麻烦”而整段省略，必须至少写入 `{stage,phase,ts}` 三个 shell 可生成字段

#### v0.34 下线提示：outputChars 输出侧粗估路径已移除

v0.31 引入的 `outputChars` / `tokenOutEstimated` 输出侧粗估路径在 v0.34 干净下线。原因：bash 拿不到 LLM 上一轮可见输出、AI 心算字符数本身于「凭感觉估算」一样不可靠，实际上报值长期为 null。从 v0.34 起 timeline.log 只保留 `tokenIn` / `tokenOut` 两个由平台 usage 元数据上报的字段，`dataIntegrity.tokenSource` 三态为 `unavailable` / `platform-not-supported` / `ai-reported`。

> `userIdleRatio` 在 v0.31 起标记为 **deprecated**：客户端无法可靠区分「等用户」与「跑工具」两段时间，该字段由聚合侧统一抹为 `null`，下个版本从 schema 移除。
### 失败兜底

所有埋点命令必须以 `2>/dev/null || true` 结尾，**埋点失败绝不阻塞主流程**：

```bash
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"start.step1","phase":"begin","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

> ⚠️ **不要使用 `date +%s%3N` 获取毫秒时间戳**
>
> macOS 自带的 BSD `date` **不支持 `%3N`**，会把 `N` 当字面量原样输出，导致日志变成：
> ```json
> {"stage":"start.step1","phase":"begin","ts":17811772463N}   // ❌ 非法 JSON
> ```
> 上报后端 JSON 解析直接失败，整段埋点数据丢失。
>
> **正确写法**（推荐 python3，全平台一致）：
> ```bash
> NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
> ```
> - 优先 `python3`：macOS / Linux 默认都有，输出标准 13 位毫秒时间戳
> - 兜底 `date +%s000`：秒级精度 + 补 3 个 0，毫秒精度损失但**绝不会出现 N 字面量**，确保 JSON 合法

### 埋点 JSON 鲁棒性铁律（v0.28.x+ 强制）

埋点数据的核心目标是「能被后端 JSON 解析」。任何让 JSON 变成非法的写法都会导致整段数据丢失。请严格遵守：

#### 铁律 1：数字字段为空时必须填 `null`，不能留空

```bash
# ❌ 错误：TOKEN_IN 未赋值时输出 "tokenIn":, → 非法 JSON
echo '{"tokenIn":'$TOKEN_IN'}'

# ✅ 正确：${VAR:-null} 在变量为空时填字面量 null
echo '{"tokenIn":'${TOKEN_IN:-null}'}'
```

> 适用范围：所有数字字段（`tokenIn` / `tokenOut` / `rounds` / `batch` / `attempt` / `durationSec` 等）。`userIdleRatio` 已 deprecated，如仍写入需同样遵守 `${VAR:-null}` 兌底。

#### 铁律 2：字符串字段含特殊字符时必须用 `jq -nc --arg` 渲染

```bash
# ❌ 错误：用户填的中文双引号会破坏 JSON 结构
REJECT_REASON='lint 失败："xxx" 报错'
echo '{"reason":"'$REJECT_REASON'"}'   # → 输出 "reason":"lint 失败:"xxx" 报错" 非法

# ✅ 正确：jq 自动转义所有特殊字符（双引号、反斜杠、换行、Unicode）
jq -nc --arg reason "$REJECT_REASON" '{reason:$reason}'
```

> 适用范围：所有可能含中文/双引号/换行/Unicode 的字符串字段（`reason` / `rejectReason` / `description` / `message` 等）。`feai-review.md` 的 `gates.log` 主体已遵循此约定。

#### 铁律 3：布尔字段必须先归一化为 `true`/`false`

```bash
# ❌ 错误：用户误填中文，输出 "hasFigma":是的 → 非法 JSON
HAS_FIGMA="是的"
echo '{"hasFigma":'$HAS_FIGMA'}'

# ✅ 正确：case 兜底强制规范化
HAS_FIGMA=${HAS_FIGMA:-false}
case "$HAS_FIGMA" in true|false) ;; *) HAS_FIGMA=false ;; esac
echo '{"hasFigma":'$HAS_FIGMA'}'
```

> 适用范围：所有 `xxxEnabled` / `hasXxx` / `isXxx` 等布尔字段。

#### 铁律 4：jq 是软依赖，聚合段允许失败但单点埋点不依赖 jq

- `feai-archive.md` 的聚合段（STEP 6.5b）依赖 `jq`，jq 不可用时聚合输出 `null`，**整段不阻塞归档**
- `/feai-start` 和 `/feai-review` 的**单点埋点**用 `echo` 拼即可，不引入 jq 依赖；只有聚合段才用 jq
- 例外：`feai-review.md` 的 `gates.log` 主体写入用 `jq -nc` 是因为 `failedChecks`/`rejectReason` 含数组和任意字符串，echo 拼无法保证合法性 → 此处 jq 不可用时 `2>/dev/null || true` 静默丢失，下次 review 重写即可

### 隐私保障

- `.codebuddy/.cache/metrics/` 必须出现在项目 `.gitignore`，禁止入库
- 上报到团队 ReportHub 时，metrics 字段是 `metadata` 内的可选子段，可通过 `reporting.enabled=false` 一键关闭

违反 G23（如完全不写埋点、伪造 token 数字）不阻塞工作流，但 reviewer 在 CR 阶段发现可要求修正后再合并。
