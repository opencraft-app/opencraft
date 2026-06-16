# `/feai-archive` — 归档沉淀

> 前端 AI 编程工具（frontend-ai-dev-tools）的归档沉淀命令。
> 一步完成 OpenSpec 的 propose → apply → archive 全流程，将开发成果沉淀为项目知识库。

## ✅ 何时执行？（v0.28.x+ 新时序）

归档分为两个阶段，**首次归档的硬时机是 git commit 之前**：

```
最后一批 /feai-review 通过（plan.md 全 [x]）
              │
              ▼
  ⭐ 首次归档：/feai-archive  ← 仅生成产物，不 commit
              │
              ▼
   git commit（代码 + 归档产物 原子提交）
              │
              ▼
   git push + 创建 MR
              │
              ▼
   评审若导致代码再改？
       ├─ 否 → 合并 MR ✅
       └─ 是 → ⭐ 增量归档：再次 /feai-archive
                       └─ 追加 commit 到同一个 MR
```

> 💡 **为什么必须在 commit 之前？**
> 归档产物（`openspec/changes/{date}-{name}.md`、`knowledge/`）是项目知识资产，必须随代码一起进主干。
> 若先 commit + 提 MR 再补归档，归档产物只能作为追加 commit 出现，污染 MR 历史，评审者也无法把"代码 + spec"作为一个原子单元审核。

> 💡 **归档不是一次性的**：MR 评审导致代码再改后可**再次运行** `/feai-archive`，会增量更新归档产物并追加 commit 到当前 MR。即使代码经历多轮迭代，最终合并时 spec 与代码始终保持一致。

---

## 强制约束（最高优先级）

- ❌ 禁止在所有任务标记为 `[x]` 之前归档（违反"知识沉淀真实性"原则）
- ❌ 禁止跳过「经验沉淀」段（关键实现决策、踩坑记录、技术选型理由必须落盘）
- ❌ 禁止跳过「业务文档同步」（项目有 `docs/` 目录则强制同步）
- ❌ 禁止跳过「工作区清理」（4 个状态文件未重置为占位语会污染下一次需求；current_state.md 未追加历史会丢失项目长期记忆）
- ❌ 禁止将归档产物写入 `openspec/changes/` 之外的路径（违反 G21）；且归档**必须为单 .md 文件**（命名 `{YYYY-MM-DD}-{change-name}.md`），禁止再创建 `archive/` 子目录或 `{date}-{name}/` 子目录式归档
- ❌ 禁止跳过「归档评分上报」（团队需要靠真实评分数据持续优化工具；评分本身不会打断流程，<3 分时才需要补充反馈文本）
- ❌ 禁止凭对话上下文「想象」上报 payload 字段位置或字段名 —— 上报前**必须**重新打开本文件 STEP 6.6 节，使用 jq 模板渲染 payload，禁止手写 JSON
- ❌ 禁止仅凭 HTTP 200 判定上报成功 —— 必须执行回执校验（STEP 6.8）
- ❌ **禁止修改、推理或替换上报地址 / apiKey** —— `REPORT_ENDPOINT` 与 `REPORT_API_KEY` 是本文件定义的**硬编码常量**，严禁：
  - ❌ 从 `project.local.json` / 环境变量 / 别的配置文件读取 endpoint、覆盖常量
  - ❌ 凭“这个地址看起来不像正式环境”「这个口令看起来是测试 key」为由自行替换为 https / 别的域名 / 别的路径
  - ❌ 在 curl 命令中不使用 `$REPORT_ENDPOINT` 变量而手写 URL
- ❌ 禁止把 archive 目录名（如 `2026-06-12-xxx-yyy`）当作 `CHANGE_NAME` 用于 metrics 路径。`CHANGE_NAME`（短名）与 `DATED_NAME`（archive 目录名）是**两个独立概念**，绝不能混用。`CHANGE_NAME` 必须使用本文件「命名规约」节的统一公式从分支名解析，否则 `efficiency` / `flowHealth` / `ruleEffectiveness` 三个诊断字段全部降级为 `null`
- ❌ 禁止跳过 STEP 6.5b（工作流诊断指标聚合）—— 必须执行，跳过即三个诊断字段全 `null`
- ❌ 当 `metrics/$CHANGE_NAME/` 不存在时，禁止把根目录下其他子目录改名为 `$CHANGE_NAME`、或改写 `$CHANGE_NAME` 让它指向其他孤儿目录来「凑数」。唯一合规行为：三个诊断字段降级为 `null`，并在 payload 中通过 `dataIntegrity` 字段如实上报"metrics 目录缺失 + 现存的疑似漂移目录列表"，便于后台识别命名漂移导致的数据缺失（用户层面如确认要复用某个漂移目录，需手动重命名后再重跑 `/feai-archive`，不在 AI 自动决策范围内）
- ❌ 当 `timeline.log` / `gates.log` / `mode-choice.json` 等原始埋点文件不存在时，禁止 AI 凭印象/对话上下文「重建」`efficiency.stages`、`flowHealth.gateRejects`、`ruleEffectiveness.modeChoice` 等字段内容。任何无原始日志支撑的数据都属于编造，必须让对应字段降级为 `null` 或空数组。允许的唯一例外是 6.5b 中明确从 git 反查的 `recovery.*` 字段（gitStashCount / checkoutCount / revertCount / branchResetCount），因为这些可从 git reflog 真实回溯。
- ❌ **token 字段（`tokenIn` / `tokenOut`）不得估算**。在 feai-start / feai-review 写入 timeline.log 时，**仅当 AI 能从运行平台的 usage 元数据**（如 Claude Code 响应的 `usage.input_tokens` / `usage.output_tokens`）**中读到真实数值时才填**；任何凭"对话长度感觉""文件体量"等的估算都属伪造，**必须填 `null`**。本字段诚实留空（`null`）远比"看起来合理的估算值"更有价值——后台据此可由 `dataIntegrity.tokenSource` 自动判定数据可信度（unavailable / platform-not-supported / ai-reported），估算填进来的脏数据会污染跨需求横向对比基准。
- ⚠️ **v0.34 下线提示：v0.31 引入的 `outputChars` / `tokenOutEstimated` 输出侧粗估路径已干净下线**。原因：bash 拿不到 LLM 上一轮可见输出、让 AI 心算字符数于「凭感觉估算」一样不可靠，该路径上报值长期为 null。从本版本起，timeline.log 仅保留可由平台 usage 元数据真实采集的 `tokenIn` / `tokenOut`，聚合 schema 同步移除 `outputChars` / `tokenOutEstimated` / `totalOutputChars` / `totalTokenOutEstimated` 与 `tokenSource: "ai-estimated-output-only"` 状态。
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
| 字段不存在 / `""` / `"."` | `openspec/changes/{YYYY-MM-DD}-{change-name}.md` |
| `"frontend"` 等子目录 | `<projectRoot>/openspec/changes/{YYYY-MM-DD}-{change-name}.md` |

下文中 `<base>` 均指代解析后的实际路径基准。

---

## 命名规约（写入端 / 读取端必须严格一致）

> 🔴 **背景**：埋点目录由 `feai-start` / `feai-review` 写入（用「短名」），由本文件 STEP 6.5b 读取。两端使用的 `CHANGE_NAME` 公式必须**完全一致**，否则读取端找不到目录，三个诊断字段全部为 `null`。

### CHANGE_NAME（短名，用于 metrics 路径）

统一公式（feai-start L335 / feai-review L65 / 本文件 STEP 6 全部使用此公式）：

```bash
# 用 .* 贪婪匹配，吃到最后一段 4 位 MMDD —— 兼容用户名含连字符（如 eric-hu / zhang-san-feng）
CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | sed -E 's|^(feat\|fix\|feature\|hotfix\|chore)/.*-[0-9]{4}-||')
# Fallback：剥不出来（分支名不符合规范）→ 回退为整个分支名（/ 替换为 -），保证 CHANGE_NAME 永远非空
if [ "$CHANGE_NAME" = "$(git rev-parse --abbrev-ref HEAD)" ]; then
  CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
fi
```

示例：
- 分支 `feat/erichu-0612-csc-newuser-tab` → `CHANGE_NAME=csc-newuser-tab`
- 分支 `feat/eric-hu-0612-csc-newuser-tab` → `CHANGE_NAME=csc-newuser-tab`（用户名含连字符也正确）

### DATED_NAME（归档单文件名前缀，可带业务后缀）

仅用于 `openspec/changes/{DATED_NAME}.md` 单文件命名，**绝不能反向污染 `CHANGE_NAME`**：

```bash
DATED_NAME="$(date +%Y-%m-%d)-${CHANGE_NAME}${BIZ_SUFFIX:+-$BIZ_SUFFIX}"
# 示例：2026-06-12-csc-newuser-tab-restriction
# → 最终归档落地：openspec/changes/2026-06-12-csc-newuser-tab-restriction.md
```

### 一致性自检（强烈建议在 STEP 6 开头执行）

```bash
METRICS_ROOT="$BASE_DIR/.codebuddy/.cache/metrics"
if [ -d "$METRICS_ROOT" ] && [ ! -d "$METRICS_ROOT/$CHANGE_NAME" ]; then
  echo "⚠️ CHANGE_NAME='$CHANGE_NAME' 与 metrics 目录不匹配"
  echo "   现存子目录：$(ls "$METRICS_ROOT" 2>/dev/null | tr '\n' ' ')"
  echo "   → 三个诊断指标可能全部降级为 null"
fi
```

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

#### 1.4 4 个状态文件一致性自检（v0.33+ 强制）

> 💡 **为什么**：v0.33 起，`/feai-start` STEP 8.2.5 会在 `current_state.md` 注入「## 当前进行中」段，这是当前需求的"身份证"。归档前必须核对身份证与 plan.md 表达的需求名是否一致——不一致说明 AI 把别人的归档单贴在了你身上（极端反例：用户本来在做需求 A，中途切到需求 B 但忘了重启 /feai-start，导致 plan.md 是 B、current_state 还显示 A）。

> 🔧 **解析口径（与 `/feai-start` STEP 8.2 写入模板对齐）**：
> - plan.md H1 真实写入格式是 `# 需求名: {标题}`（带前缀 + 半角冒号 + 空格），所以"需求名"提取必须**优先**走 `# 需求名:` 前缀剥离，否则会把整行 `需求名: 批量导入功能` 当作标题，与 current_state.md 里的 `批量导入功能` 永远比对不等，造成 100% 误报。
> - current_state.md 里 `- **需求名**：{X}` 用的是**全角冒号 U+FF1A**（`/feai-start` 8.2.5 python 写入），脚本必须用全角冒号匹配。
> - 两端字符串都要去掉首尾 `**` 加粗符 + 两端空白，再做字面比对。

```bash
CSF="<base>/openspec/current_state.md"
PLAN="<base>/openspec/plan.md"

# 检查 1：current_state.md 必须存在「## 当前进行中」段（说明走过 /feai-start 8.2.5）
if ! grep -q '^## 当前进行中' "$CSF" 2>/dev/null; then
  cat <<'EOF'
⚠️ current_state.md 缺少「## 当前进行中」段（v0.33+ 必需）。
   可能原因：
     1. 本次需求是用 v0.33 之前的版本启动的（兼容路径，可继续）
     2. /feai-start STEP 8.2.5 被跳过（违规路径，归档时 STEP 7.1.1 的删除步骤会自动跳过，不影响主流程）
   请用户字面回复以下两种方式之一才能继续：
     [c] 兼容继续（标记 LEGACY_START=1，归档摘要中追加"⚠️ 状态文件来自旧版"）
     [a] 中止归档，先用 v0.33+ 重新跑一次 /feai-start 同步状态文件
EOF
  # ⛔️ AI 行为约束：在用户字面回复 [c] 或 [a] 之前，禁止默认选择，禁止跳到 STEP 2
  # 收到 [c] → 设置 LEGACY_START=1，跳过下面的检查 2，直接进入产出物检查点
  # 收到 [a] → 终止 /feai-archive，提示用户处理
fi

# 检查 2：进行中段的"需求名"应该与 plan.md 顶部 H1 的需求名一致
if grep -q '^## 当前进行中' "$CSF" 2>/dev/null; then
  # 提取 plan.md 标题：限定文件前 5 行，避免抓到子模块 H1
  # 先抓"# 需求名: X"模式 → 没命中再回退到裸 H1
  PLAN_RAW=$(awk 'NR<=5 && /^# /{sub(/^# /,""); print; exit}' "$PLAN")
  case "$PLAN_RAW" in
    "需求名: "*|"需求名:"*|"需求名："*)
      # 剥离前缀（兼容半角/全角冒号、有无空格）
      PLAN_TITLE=$(printf '%s' "$PLAN_RAW" | sed -E 's/^需求名[:：][[:space:]]*//')
      ;;
    *)
      PLAN_TITLE="$PLAN_RAW"
      ;;
  esac

  # 提取 current_state.md 进行中段的"需求名"字段（全角冒号）
  STATE_NAME=$(awk '/^## 当前进行中/{flag=1; next} flag && /^- \*\*需求名\*\*：/{
    sub(/^- \*\*需求名\*\*：/,""); print; exit
  }' "$CSF")

  # 双端归一化：去 `**` 加粗 + 去两端空白
  norm() { printf '%s' "$1" | sed -E 's/^[*[:space:]]+//;s/[*[:space:]]+$//'; }
  PLAN_TITLE_TRIM=$(norm "$PLAN_TITLE")
  STATE_NAME_TRIM=$(norm "$STATE_NAME")

  if [ -n "$STATE_NAME_TRIM" ] && [ -n "$PLAN_TITLE_TRIM" ] \
     && [ "$STATE_NAME_TRIM" != "$PLAN_TITLE_TRIM" ]; then
    cat <<EOF
🔴 状态分裂：plan.md 与 current_state.md 表达的需求名不一致：
   plan.md  H1 解析后：$PLAN_TITLE_TRIM
   current_state 进行中：$STATE_NAME_TRIM

   ⛔️ 强制阻断：直接归档会污染 current_state.md「上一个需求」指针。
   常见原因：
     • 用户改了 plan.md 顶部的需求名忘记同步 current_state.md
     • markdown 语法差异（如 H1 用了 \`**加粗**\` 但进行中段没用）→ 直接选 [k] 即可
   请用户字面回复以下三种方式之一才能继续：
     [k]  以 plan.md 为准（推荐）
     [s]  以 current_state 为准（极少见）
     [a]  中止归档，用户人工对齐两端需求名后重跑
EOF
    # ⛔️ AI 行为约束：在用户字面回复 [k]/[s]/[a] 之前，禁止默认选择，禁止跳到 STEP 2
    # 收到 [k] → 用 PLAN_TITLE_TRIM 作为最终需求名，进入 STEP 2
    # 收到 [s] → 用 STATE_NAME_TRIM 作为最终需求名，进入 STEP 2
    # 收到 [a] → 终止 /feai-archive
  fi
fi
```

**字段缺失容错**：

- `STATE_NAME` 抓不到（旧版 current_state.md 没有「需求名」字段）→ 跳过检查 2，仅给出 LEGACY 提示
- `PLAN_TITLE` 为空（plan.md 没有 H1）→ 已在 STEP 1.1 之外的 grep 校验中暴露，此处不重复阻断
- 两端任一为空 → 不触发不一致告警（避免空字符串 vs 任何字符串的伪阳性）

**产出物检查点：** ✅ 任务完成度已确认；✅ git 状态已确认；✅ current_state.md 与 plan.md 需求名一致（或已用户字面确认 LEGACY/对齐方案）。

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

### [STEP 5/8] 归档变更（Archive，扁平单文件）

> 🎯 **设计意图（参考 skillhub `.openspec/changes/`）**：
> 一次需求 = 一份 `.md` 单文件，扁平铺在 `openspec/changes/` 根下，按日期前缀天然有序。
> **不再使用 `archive/` 子目录**，**不再保留 `proposal.md / spec.md / tasks.md / design.md` 多文件分散结构**。
> 25KB 单文件足够装下 L 级需求（skillhub 实测 contest-v2-refactor 18KB / enterprise-personal-center 25KB）。

#### 5.1 渲染归档单文件

按下表把开发期 `<base>/openspec/changes/<change-name>/` 内多文件**合并渲染**为一份扁平 `.md`：

| 来源 | 单文件章节 |
|-----|-----------|
| `proposal.md` 一级标题 | 文件首行 `# 变更记录：{REQ_TITLE}` |
| `proposal.md` 元信息（日期/分支/规模/MR/TAPD） | 顶部引用块 `> ...` |
| `proposal.md`「需求概要 / 动机背景」 | 一、需求概要 |
| `tasks.md` 完整任务列表 | 二、任务完成情况（保留 `- [x] / - [ ]` 原貌） |
| `proposal.md`「关键实现决策 + 技术选型理由」（STEP 3 五段经验） | 三、关键决策 |
| 本次代码统计 + 关键 commits + 验证结果 | 四、实施摘要 |
| `specs/{module}.md` Delta（如有） | 五、规范沉淀（无则写「本次无规范沉淀」） |
| `proposal.md`「踩坑记录 + 可复用经验 + 未实现/后续优化」 | 六、回顾与改进 |

#### 5.2 单文件模板（参考 skillhub 简化版）

```markdown
# 变更记录：{REQ_TITLE}

> **日期：** {YYYY-MM-DD}
> **分支：** `{BRANCH}`
> **规模：** {SCALE}（{WORKFLOW_MODE}）
> **TAPD：** {TAPD_URL}（识别不到留空字符串）
> **MR：** {MR_URL}（识别不到留空字符串）
> **HEAD commit：** `{HEAD_SHA}`

---

## 一、需求概要
{需求动机/背景，截断 500 字}

## 二、任务完成情况
{TASKS_DONE}/{TASKS_TOTAL} 个任务完成。

{原 tasks.md 完整任务清单，保留 - [x] / - [ ] 原貌}

## 三、关键决策
{从 STEP 3「关键实现决策」+「技术选型理由」整合}

## 四、实施摘要
- 文件改动：{FILES_CHANGED} 个，+{LINES_ADDED}/-{LINES_DELETED}
- 关键 commits：{HEAD_SHA 起 5 条 commit subject}
- 验证结果：{plan.md 完成度 + gate-archive 通过情况}

## 五、规范沉淀
{Delta Specs 摘录；无则写「本次无规范沉淀」}

## 六、回顾与改进
### 踩坑记录
{从 STEP 3「踩坑记录」迁移}
### 可复用经验
{从 STEP 3「可复用经验」迁移}
### 未实现 / 后续优化
{从 STEP 3「未实现 / 后续优化」迁移}
```

#### 5.3 落盘并清理开发期目录

```bash
# ⚠️ 在 STEP 5 之前 CHANGE_NAME 可能尚未赋值（命名规约节是参考章节，并非执行步骤）
#    这里强制再解析一次，与「命名规约」节、STEP 6.1 公式保持完全一致
#    用 .* 贪婪匹配，吃到最后一段 4 位 MMDD —— 兼容用户名含连字符（如 eric-hu / zhang-san-feng）
CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | sed -E 's|^(feat\|fix\|feature\|hotfix\|chore)/.*-[0-9]{4}-||')
if [ "$CHANGE_NAME" = "$(git rev-parse --abbrev-ref HEAD)" ]; then
  CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
fi

# ⚠️ 安全兜底（必须在 rm -rf 之前生效，任一不通过都 exit 1，禁止只 echo 警告）
#    - 空值：防止生成「2026-06-12-.md」悬空文件、且 rm -rf <base>/openspec/changes/ 误删整个 changes 目录
#    - 非 kebab-case：防止 `../`、`*`、空格、`;`、中文等特殊字符进入 rm -rf 路径触发越权 / 通配符注入
if [ -z "$CHANGE_NAME" ]; then
  echo "❌ CHANGE_NAME 为空，无法生成归档单文件路径。请检查命名规约节的解析公式或分支名规范。"
  exit 1
fi
if ! echo "$CHANGE_NAME" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "❌ CHANGE_NAME='$CHANGE_NAME' 含非 kebab-case 字符，禁止用于文件路径（防止 rm -rf 越权 / 通配符展开）。"
  echo "   请将分支名整改为 feat|fix|feature|hotfix|chore/{user}-{MMDD}-{kebab-case-slug} 后重跑。"
  exit 1
fi

DATED_NAME="$(date +%Y-%m-%d)-${CHANGE_NAME}"
ARCHIVE_FILE="<base>/openspec/changes/${DATED_NAME}.md"

# 1. 写入合并渲染后的单文件（内容在 5.1/5.2 已生成）
# cat > "$ARCHIVE_FILE" <<'EOF' ... EOF

# 2. 删除开发期多文件目录（已合并完成，原文件不再保留）
#    经过上方 kebab-case 强校验后，CHANGE_NAME 已不可能含通配符/路径穿越字符
rm -rf "<base>/openspec/changes/${CHANGE_NAME}"

# 3. ⚠️ 不再创建 archive/ 子目录、不再使用 mv 目录方式
```

> 💡 **历史归档的兼容**：以前用过 `changes/archive/{date}-{name}/` 的项目，**保留原样**不强制迁移。新归档一律走单文件形态，两种结构可共存。
>
> 📜 **归档历史回填**：如果项目里既有 `changes/archive/...` 老格式又开始用新单文件格式，`current_state.md` 的「历史归档」段（STEP 7）只追加新格式条目，老条目保留不动。

#### 5.4 更新 `.openspec.yaml` 状态

将本次变更状态置为 `done`。

**产出物检查点：** ✅ 归档单文件 `changes/{DATED_NAME}.md` 已生成；✅ 开发期目录 `changes/<change-name>/` 已删除；✅ 状态已更新。

---

### [STEP 6/8] 归档评分 + 上报（团队飞轮）

> 这一步用于收集真实使用数据，驱动工具持续优化。**不打扰用户**：高分一秒钟跳过，低分才需要补充一句反馈。

#### 6.1 上报地址与凭证（硬编码常量，禁止修改）

> 🔴 **重要**：以下两个常量是 ReportHub 服务端的**唯一合法入口**，不读任何配置文件、不读环境变量、不推理。AI 只需原样拷贝使用，绝对不能以任何理由修改这两行。

```bash
# ⚠️ 上报 URL——常量，禁止修改、禁止从配置读取、禁止推理另一个 URL
REPORT_ENDPOINT="http://21.214.142.151/api/v1/report"
# ⚠️ 团队公共 apiKey——常量，禁止修改、禁止“看起来像测试 key”就替换
REPORT_API_KEY="rh_ad2e2a0b1b992255e6ed43ae42b6aefdaa5e2bde7f34e1bc"
```

仅允许以下**一个**字段从 `<base>/.codebuddy/project.local.json` 读取，用于授权项目关闭上报：

```bash
LOCAL_CONFIG="$BASE_DIR/.codebuddy/project.local.json"
# 唯一可被项目覆盖的字段：是否启用上报（默认 true）
REPORT_ENABLED=$(jq -r '.reporting.enabled // true' "$LOCAL_CONFIG" 2>/dev/null || echo "true")

# 如 enabled=false，直接跳过整个 STEP 6、67 节
if [ "$REPORT_ENABLED" != "true" ]; then
  echo "[STEP 6/8] 项目已关闭上报（reporting.enabled=false），跳过"
  exit 0
fi

# 工具版本号（用于 metadata.version，分析 AI 工具版本影响）
FEAI_VERSION=$(jq -r '.version // "unknown"' "$BASE_DIR/.codebuddy/.feai-installed" 2>/dev/null || echo "unknown")
```

> 💡 为什么不提供 endpoint / apiKey 的覆盖能力？期货上，服务端是团队统一的接收点，覆盖只会导致数据锁进个人那里。如需临时关闭上报，设置 `"reporting": { "enabled": false }` 即可。

# 当前需求名 —— 必须使用「命名规约」节的统一公式（与 feai-start / feai-review 保持完全一致）
# ❌ 禁止把 archive 目录名（如 2026-06-12-xxx-yyy）当作 CHANGE_NAME
# 用 .* 贪婪匹配，吃到最后一段 4 位 MMDD —— 兼容用户名含连字符（如 eric-hu / zhang-san-feng）
CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | sed -E 's|^(feat\|fix\|feature\|hotfix\|chore)/.*-[0-9]{4}-||')
if [ "$CHANGE_NAME" = "$(git rev-parse --abbrev-ref HEAD)" ]; then
  CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
fi
echo "[STEP 6/8] CHANGE_NAME=$CHANGE_NAME（用于 metrics 路径）"

# 解析 BASE_DIR（替代文档中的 <base> 占位符）—— 必须用 if/else 写，避免 || && 短路陷阱
GIT_ROOT="$(git rev-parse --show-toplevel)"
PROJECT_ROOT_RAW=$(jq -r '.projectRoot // ""' "$GIT_ROOT/.codebuddy/project.local.json" 2>/dev/null)
if [ -z "$PROJECT_ROOT_RAW" ] || [ "$PROJECT_ROOT_RAW" = "." ]; then
  BASE_DIR="$GIT_ROOT"
else
  BASE_DIR="$GIT_ROOT/$PROJECT_ROOT_RAW"
fi
echo "[STEP 6/8] BASE_DIR=$BASE_DIR"
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
| `requirement.title` | ① 已渲染好的归档单文件 `<base>/openspec/changes/{DATED_NAME}.md` 一级标题；② 归档前 `<base>/openspec/changes/<change-name>/proposal.md` 一级标题；③ 归档前 `<base>/openspec/proposal.md`；④ 对话上下文中的 TAPD story title | 留空字符串 |
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

DATED_NAME="$(date +%Y-%m-%d)-${CHANGE_NAME}"
ARCHIVE_FILE="<base>/openspec/changes/${DATED_NAME}.md"

# 需求统计：从已渲染好的归档单文件「二、任务完成情况」段落统计 - [x] / - [ ]
# 容错：单文件不存在时（极端异常），回退到开发期目录 tasks.md（已 rm 则降级为 0）
if [ -f "$ARCHIVE_FILE" ]; then
  TASKS_TOTAL=$(grep -c "^\- \[" "$ARCHIVE_FILE" 2>/dev/null || echo 0)
  TASKS_DONE=$(grep -c  "^\- \[x\]" "$ARCHIVE_FILE" 2>/dev/null || echo 0)
else
  TASKS_TOTAL=$(grep -c "^\- \["   "<base>/openspec/changes/${CHANGE_NAME}/tasks.md" 2>/dev/null || echo 0)
  TASKS_DONE=$(grep -c  "^\- \[x\]" "<base>/openspec/changes/${CHANGE_NAME}/tasks.md" 2>/dev/null || echo 0)
fi

# 代码统计（与 baseBranch 比对）
# ⚠️ 排除归档/工具产物路径，避免 i18n 重命名等小需求的 linesAdded 被规范文档/CHANGELOG 注水
#   - openspec/         → 归档/proposal/tasks/spec 等流程产物
#   - CHANGELOG.md      → 工具版本日志（非业务变更）
#   - .codebuddy/       → 工具自身配置缓存
#   - package-lock.json / pnpm-lock.yaml / yarn.lock → 锁文件波动量大且非业务
EXCLUDE_PATHS=(
  ':(exclude,top)openspec/**'
  ':(exclude,top)CHANGELOG.md'
  ':(exclude,top).codebuddy/**'
  ':(exclude,top)package-lock.json'
  ':(exclude,top)pnpm-lock.yaml'
  ':(exclude,top)yarn.lock'
)
FILES_CHANGED=$(git diff --name-only "$BASE_BRANCH"...HEAD -- "${EXCLUDE_PATHS[@]}" | wc -l | tr -d ' ')
LINES_STAT=$(git diff --shortstat "$BASE_BRANCH"...HEAD -- "${EXCLUDE_PATHS[@]}")
LINES_ADDED=$(echo "$LINES_STAT" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
LINES_DELETED=$(echo "$LINES_STAT" | grep -oE '[0-9]+ deletion'  | grep -oE '[0-9]+' || echo 0)
# 同时计算「含产物」的总行数，用于 dataIntegrity 诊断（让后台知道排除了多少噪声）
LINES_STAT_RAW=$(git diff --shortstat "$BASE_BRANCH"...HEAD)
LINES_ADDED_RAW=$(echo "$LINES_STAT_RAW" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)
LINES_DELETED_RAW=$(echo "$LINES_STAT_RAW" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' || echo 0)
```

#### 6.5b ⚠️ 工作流诊断指标聚合（必须执行；跳过 = 三字段全 null）

> 目的：从 `.codebuddy/.cache/metrics/${CHANGE_NAME}/` 各埋点日志聚合出 L1/L2/L3 三层诊断指标，作为 `metadata` 的 3 个 optional 字段上报。
>
> ❗ **聚合失败必须降级为 `null`，绝不能阻塞主流程**——指标是辅助数据，不能因此让评分上报失败。
>
> ⚠️ **常见踩坑（v0.28 实测）**：本节依赖 `CHANGE_NAME` 与 feai-start / feai-review 写入端**完全一致**。如果你把 archive 目录名（含日期、含业务后缀）当作 `CHANGE_NAME`，下面的 `if [ -d "$METRICS_DIR" ]` 永远 false，整段聚合被静默跳过，三个字段全部为 `null`。

```bash
echo "[STEP 6.5b/8] 开始聚合工作流诊断指标..."
METRICS_DIR="$BASE_DIR/.codebuddy/.cache/metrics/${CHANGE_NAME}"
AGG_OUT_DIR="$METRICS_DIR/aggregated"
mkdir -p "$AGG_OUT_DIR" 2>/dev/null || true

EFF_FILE="$AGG_OUT_DIR/efficiency.json"
FH_FILE="$AGG_OUT_DIR/flowHealth.json"
RE_FILE="$AGG_OUT_DIR/ruleEffectiveness.json"
DI_FILE="$AGG_OUT_DIR/dataIntegrity.json"

# 默认值：metrics 目录不存在或聚合失败时上报为 null
echo 'null' > "$EFF_FILE"
echo 'null' > "$FH_FILE"
echo 'null' > "$RE_FILE"

# dataIntegrity 默认值：metrics 目录正常存在
DRIFT_DIRS=$(find "$BASE_DIR/.codebuddy/.cache/metrics" -maxdepth 1 -mindepth 1 -type d \
  ! -name "$(basename "$METRICS_DIR")" ! -name ".pending" 2>/dev/null \
  | xargs -I{} basename {} 2>/dev/null | jq -R . | jq -sc . 2>/dev/null || echo '[]')
# 细粒度文件存在性诊断（区分「目录在但日志缺」和「目录都没」两种 0 数据形态）
TL_FOUND=$([ -f "$METRICS_DIR/timeline.log" ] && echo true || echo false)
GT_FOUND=$([ -f "$METRICS_DIR/gates.log" ] && echo true || echo false)
MC_FOUND=$([ -f "$METRICS_DIR/mode-choice.json" ] && echo true || echo false)
CL_FOUND=$([ -f "$METRICS_DIR/clarification.log" ] && echo true || echo false)
# 行数计算的产物排除诊断（让后台知道排除了多少噪声、是否影响 tokenPerLineChangedPlanReview）
LINES_EXCLUDED=$((LINES_ADDED_RAW + LINES_DELETED_RAW - LINES_ADDED - LINES_DELETED))

# tokenSource 反推：从 timeline.log 中 phase=end 的事件统计 token 字段非 null 的占比
# - "unavailable"               : timeline.log 不存在 或 存在但无任何 phase=end 事件（只跑了一半）
# - "platform-not-supported"    : timeline.log 存在且有 phase=end，但所有 end 事件 tokenIn 均为 null（运行平台未提供 usage）
# - "ai-reported"               : tokenIn/tokenOut 字段有值，由 AI 在埋点时填入；后台需人工抽样确认是否真来自 usage 元数据
#                                 （客户端无法区分真 usage 还是 AI 估算，故统一用中性词 ai-reported）
# v0.34 起：原「ai-estimated-output-only」状态及 outputChars 估算路径已下线
TOKEN_SOURCE='"unavailable"'
TOKEN_FILLED_RATIO=null
if [ "$TL_FOUND" = true ]; then
  TOKEN_STATS=$(jq -s '
    [.[] | select(.phase=="end")] as $ends
    | { total: ($ends | length),
        filled: ([$ends[] | select(.tokenIn != null)] | length) }
  ' "$METRICS_DIR/timeline.log" 2>/dev/null || echo '{"total":0,"filled":0}')
  END_TOTAL=$(echo "$TOKEN_STATS" | jq -r '.total // 0')
  END_FILLED=$(echo "$TOKEN_STATS" | jq -r '.filled // 0')
  if [ "$END_TOTAL" -gt 0 ]; then
    TOKEN_FILLED_RATIO=$(jq -nc --argjson t "$END_TOTAL" --argjson f "$END_FILLED" \
      '($f / $t * 100 | floor) / 100')
    if [ "$END_FILLED" = "0" ]; then
      TOKEN_SOURCE='"platform-not-supported"'
    else
      TOKEN_SOURCE='"ai-reported"'
    fi
  fi
fi
if [ -d "$METRICS_DIR" ]; then
  jq -nc \
    --arg cn "$CHANGE_NAME" \
    --argjson drift "$DRIFT_DIRS" \
    --argjson tl "$TL_FOUND" --argjson gt "$GT_FOUND" \
    --argjson mc "$MC_FOUND" --argjson cl "$CL_FOUND" \
    --argjson exc "$LINES_EXCLUDED" \
    --argjson tsrc "$TOKEN_SOURCE" \
    --argjson tratio "$TOKEN_FILLED_RATIO" \
    '{metricsDirFound: true, changeName: $cn, suspectedDriftDirs: $drift,
      timelineLogFound: $tl, gatesLogFound: $gt, modeChoiceFound: $mc, clarificationLogFound: $cl,
      linesExcludedFromArtifacts: $exc,
      tokenSource: $tsrc, tokenFilledRatio: $tratio,
      executionStageMissing: true}' > "$DI_FILE"
  # executionStageMissing=true 说明：v0.31 起，/feai-start 与 /feai-review 之间的「开发执行段」尚未埋点，
  # 因此 efficiency.totalDurationSec / totalToken* 仅覆盖规划+审核段，后台禁止据此推断整体 AI 投产比。
  # 目录在但日志缺 → 当场告警，避免后续 efficiency 静默为 null
  if [ "$TL_FOUND" = false ] || [ "$GT_FOUND" = false ]; then
    echo "⚠️ [STEP 6.5b] metrics 目录存在但关键日志缺失：timeline.log=$TL_FOUND gates.log=$GT_FOUND"
    echo "   可能原因：feai-start / feai-review 的埋点 bash 段未真正执行（AI 只读不跑）"
    echo "   → efficiency / flowHealth 中依赖该日志的字段将为 null（属真实情况，禁止编造）"
  fi
  # token 数据来源告警
  if [ "$TOKEN_SOURCE" = '"platform-not-supported"' ]; then
    echo "ℹ️  [STEP 6.5b] 当前运行平台未提供 usage 元数据"
    echo "   → efficiency.totalTokenIn / totalTokenOut / tokenPerLineChangedPlanReview 将上报为 null（这是诚实的）"
  elif [ "$TOKEN_SOURCE" = '"ai-reported"' ]; then
    echo "ℹ️  [STEP 6.5b] token 字段由 AI 自报（非平台 usage 直采）"
    echo "   → dataIntegrity.tokenSource=ai-reported，后台需结合人工抽样判定可信度"
  fi
else
  # 目录不存在 → 上报详细命名漂移诊断（如实记录现状，不自动重映射）
  jq -nc \
    --arg cn "$CHANGE_NAME" \
    --arg branch "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)" \
    --argjson drift "$DRIFT_DIRS" \
    --argjson exc "$LINES_EXCLUDED" \
    '{metricsDirFound: false, changeName: $cn, branchName: $branch, suspectedDriftDirs: $drift,
      timelineLogFound: false, gatesLogFound: false, modeChoiceFound: false, clarificationLogFound: false,
      linesExcludedFromArtifacts: $exc,
      tokenSource: "unavailable", tokenFilledRatio: null,
      executionStageMissing: true,
      reason: "metrics directory missing — likely SLUG drift between feai-start and current branch name, OR feai-start was not run at all"}' > "$DI_FILE"
  echo "⚠️ [STEP 6.5b] 埋点目录不存在: $METRICS_DIR"
  echo "   可能原因：CHANGE_NAME='$CHANGE_NAME' 与 feai-start / feai-review 写入端命名不一致（SLUG 漂移）"
  echo "            或本次需求未执行 /feai-start（直接从分支开干 → 无任何埋点）"
  echo "   metrics 现存子目录：$(echo "$DRIFT_DIRS" | jq -r 'join(", ")' 2>/dev/null || echo '（无）')"
  echo "   → 三个诊断指标将全部降级为 null"
  echo "   → payload.metadata.dataIntegrity 将如实上报漂移信息，便于后台识别命名漂移"
fi

if [ -d "$METRICS_DIR" ]; then
  ##### L1 efficiency：阶段耗时 + token 消耗 #####
  # ⚠️ 口径声明（v0.31+）：
  # - 本段仅聚合 feai-start.* 与 feai-review.* 的埋点 stage（共 ≤8 个 start step + N 个 review batch.attempt）。
  # - **/feai-start 结束 → /feai-review 开始之间的「开发执行段」目前没有埋点**，
  #   该段耗时与 token 消耗均不计入 totalDurationSec / totalToken*。
  # - 因此 totalDurationSec 反映的是「规划+审核」的耗时，**绝不能解读为整个需求的开发耗时**。
  # - 后台用 dataIntegrity.executionStageMissing 标记此口径缺口，禁止跨阶段对比时混用。
  # - userIdleRatio 字段：v0.31 起 **deprecated**（采集端无法可靠区分「等用户」/「跑工具」），
  #   聚合侧固定输出 null，**禁止下游消费方依赖该字段**；下个版本将从 schema 移除。
  if [ -f "$METRICS_DIR/timeline.log" ]; then
    jq -s '
      # 输入：每行一个埋点对象，按 stage 分组配对 begin/end
      group_by(.stage) |
      map({
        name: .[0].stage,
        begins: map(select(.phase=="begin")),
        ends:   map(select(.phase=="end"))
      } | select(.begins|length>0) | select(.ends|length>0) | {
        name: .name,
        durationSec: ((.ends[0].ts - .begins[0].ts) / 1000 | floor),
        tokenIn:  (.ends[0].tokenIn // null),
        tokenOut: (.ends[0].tokenOut // null),
        userIdleRatio: null
      }) as $stages |
      {
        stages: $stages,
        totalDurationSec: ([$stages[].durationSec] | add // 0),
        totalTokenIn:  ([$stages[].tokenIn  | select(.!=null)] | add // null),
        totalTokenOut: ([$stages[].tokenOut | select(.!=null)] | add // null),
        tokenPerLineChangedPlanReview: null
      }
    ' "$METRICS_DIR/timeline.log" 2>/dev/null > "$EFF_FILE.tmp" && mv "$EFF_FILE.tmp" "$EFF_FILE" || echo 'null' > "$EFF_FILE"

    # 计算 tokenPerLineChangedPlanReview（行变更总数 / token 总和）
    # ⚠️ 命名说明：分子（token）只覆盖规划+审核段，分母（lines）是整个分支 diff，
    # 两者时间窗口不一致。后台请将该值视作「规划+审核段相对于产出代码量的 token 比值」，
    # **不是**整个需求的真实 AI 投产比；后者需等开发执行段埋点补齐后再产出。
    # v0.34+：只在真实 usage 有值时才计算；原 0.31 「估算输出×2」代理已随 outputChars 下线一道移除。
    LINES_TOTAL=$((LINES_ADDED + LINES_DELETED))
    if [ "$LINES_TOTAL" -gt 0 ]; then
      jq --argjson lines "$LINES_TOTAL" '
        if (.totalTokenIn != null and .totalTokenOut != null)
        then .tokenPerLineChangedPlanReview = (((.totalTokenIn + .totalTokenOut) / $lines) | floor)
        else . end
      ' "$EFF_FILE" > "$EFF_FILE.tmp" 2>/dev/null && mv "$EFF_FILE.tmp" "$EFF_FILE" || true
    fi
  fi

  ##### L2 flowHealth：澄清轮次 / 门禁打回 / 返工 / Stop-and-Ask #####
  CLARIF=$(jq -s '[.[].rounds] | add // 0' "$METRICS_DIR/clarification.log" 2>/dev/null || echo 0)

  if [ -f "$METRICS_DIR/gates.log" ]; then
    GATES_JSON=$(jq -sc 'map(select(.result != null))' "$METRICS_DIR/gates.log" 2>/dev/null || echo '[]')
    SAA=$(jq -s '[.[] | select(.event=="stop_and_ask")] | length' "$METRICS_DIR/gates.log" 2>/dev/null || echo 0)
  else
    GATES_JSON='[]'
    SAA=0
  fi

  # git 反查返工类操作（限定本分支范围 / 本分支创建以来）
  # 获取本分支从 master 分出点作为起始点，避免拿到全局 reflog 干扰
  BRANCH_BASE=$(git merge-base HEAD master 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo "")
  if [ -n "$BRANCH_BASE" ]; then
    BRANCH_START_TS=$(git log -1 --format=%cI "$BRANCH_BASE" 2>/dev/null || echo "")
  fi
  # Fallback：merge-base 找不到（孤儿分支 / shallow clone）→ 用本分支首个 commit 时间
  if [ -z "${BRANCH_START_TS:-}" ]; then
    BRANCH_START_TS=$(git log --reverse --format=%cI HEAD 2>/dev/null | head -1)
  fi
  # 兜底兜底：连本分支首个 commit 都拿不到 → 用 30 天前作为时间窗
  : "${BRANCH_START_TS:=$(date -u -v-30d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '1970-01-01T00:00:00Z')}"

  # stash 计数：只看本分支创建以后的 stash 事件（避免拿到全局 stash 池）
  STASH_CNT=$(git reflog show stash --since="$BRANCH_START_TS" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  CHECKOUT_CNT=$(git reflog --since="$BRANCH_START_TS" 2>/dev/null | grep -cE 'checkout: moving from .* to .*' || echo 0)
  REVERT_CNT=$(git log --since="$BRANCH_START_TS" --grep='^Revert' --oneline 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  RESET_CNT=$(git reflog --since="$BRANCH_START_TS" 2>/dev/null | grep -cE 'reset: moving to' || echo 0)

  jq -n \
    --argjson clarif "$CLARIF" \
    --argjson gates "$GATES_JSON" \
    --argjson saa "$SAA" \
    --argjson stash "$STASH_CNT" \
    --argjson chk "$CHECKOUT_CNT" \
    --argjson rev "$REVERT_CNT" \
    --argjson rst "$RESET_CNT" \
    '{
      clarificationRounds: $clarif,
      gateRejects: ($gates | map(select(.result != "pass"))),
      rejectRate: ( if ($gates|length) > 0
                    then (([$gates[] | select(.result!="pass")] | length) / ($gates|length))
                    else 0 end ),
      repeatFailureCount: (
        # 设计本意：同一 batch 被打回 ≥2 次的 batch 个数，反映需求或技术选型反复返工
        # 旧实现（map(select(length > 1)) -> map(.failedChecks length) -> map(select(>1))）双层过滤逻辑错误，几乎永远为 0
        $gates
        | map(select(.result != "pass"))           # 只看打回事件
        | group_by(.batch)                          # 按批次分组
        | map(select(length >= 2))                  # 同 batch 打回 ≥2 次的才计
        | length
      ),
      # userInterrupts：v0.31+ 占位字段，无采集机制，AI 禁止填入估算值；后续版本将从 schema 移除
      userInterrupts: null,
      stopAndAskCount: $saa,
      recovery: {
        gitStashCount: $stash,
        checkoutCount: $chk,
        revertCount: $rev,
        branchResetCount: $rst
      }
    }' > "$FH_FILE" 2>/dev/null || echo 'null' > "$FH_FILE"

  ##### L3 ruleEffectiveness：显式跳过 / 隐式违规 / 模式错配 / 橡皮图章 #####
  SKIPS_JSON='[]'
  [ -f "$METRICS_DIR/explicit-skips.log" ] && \
    SKIPS_JSON=$(jq -sc '.' "$METRICS_DIR/explicit-skips.log" 2>/dev/null || echo '[]')

  # 隐式违规反推（最关键的两条：G3 / G8）
  IMPLICIT='[]'
  PLAN_FIRST_OK_SHA=$(git log --format=%H -- "<base>/openspec/plan.md" 2>/dev/null | tail -1)
  CODE_FIRST_SHA=$(git log --format=%H --diff-filter=A -- "<base>/src" 2>/dev/null | tail -1)
  if [ -n "$PLAN_FIRST_OK_SHA" ] && [ -n "$CODE_FIRST_SHA" ]; then
    PLAN_TS=$(git show -s --format=%ct "$PLAN_FIRST_OK_SHA" 2>/dev/null || echo 0)
    CODE_TS=$(git show -s --format=%ct "$CODE_FIRST_SHA" 2>/dev/null || echo 0)
    if [ "$CODE_TS" -gt 0 ] && [ "$PLAN_TS" -gt 0 ] && [ "$CODE_TS" -lt "$PLAN_TS" ]; then
      IMPLICIT=$(jq -nc --arg sha "$CODE_FIRST_SHA" --arg plan "$PLAN_FIRST_OK_SHA" \
        '[{rule:"G3",evidence:("\u4e1a\u52a1\u4ee3\u7801 commit "+$sha+" \u65e9\u4e8e plan.md commit "+$plan)}]')
    fi
  fi

  # 橡皮图章：gates.log 中 durationSec < 5 的次数
  RUBBER=$(jq -s '[.[] | select(.durationSec != null and .durationSec < 5)] | length' "$METRICS_DIR/gates.log" 2>/dev/null || echo 0)

  # 模式错配
  if [ -f "$METRICS_DIR/mode-choice.json" ]; then
    MODE_JSON=$(jq -c --argjson files "$FILES_CHANGED" '
      . + { actualFilesChanged: $files,
            mismatch: (
              (.declared == "quick" and $files > 2) or
              (.declared == "standard" and $files > 5)
            )
          }
    ' "$METRICS_DIR/mode-choice.json" 2>/dev/null || echo 'null')
  else
    MODE_JSON='null'
  fi

  jq -n \
    --argjson skips "$SKIPS_JSON" \
    --argjson impl "$IMPLICIT" \
    --argjson rubber "$RUBBER" \
    --argjson mode "$MODE_JSON" \
    '{
      explicitSkips: $skips,
      implicitViolations: $impl,
      rubberStampGates: $rubber,
      modeChoice: $mode
    }' > "$RE_FILE" 2>/dev/null || echo 'null' > "$RE_FILE"
fi

# 给 6.6 用的 3 个变量（保证一定是合法 JSON）
EFFICIENCY_JSON=$(cat "$EFF_FILE" 2>/dev/null || echo 'null')
FLOWHEALTH_JSON=$(cat "$FH_FILE" 2>/dev/null || echo 'null')
RULEEFF_JSON=$(cat "$RE_FILE" 2>/dev/null || echo 'null')
DI_JSON=$(cat "$DI_FILE" 2>/dev/null || echo 'null')

# 任一变量不是合法 JSON 就降级为 null（防御性兜底）
echo "$EFFICIENCY_JSON" | jq empty 2>/dev/null || EFFICIENCY_JSON='null'
echo "$FLOWHEALTH_JSON" | jq empty 2>/dev/null || FLOWHEALTH_JSON='null'
echo "$RULEEFF_JSON"    | jq empty 2>/dev/null || RULEEFF_JSON='null'
echo "$DI_JSON"         | jq empty 2>/dev/null || DI_JSON='null'

# 收尾：明确告知三个字段最终是 null 还是有数据，便于排查
echo "[STEP 6.5b/8] 聚合完成：efficiency=$([ "$EFFICIENCY_JSON" = 'null' ] && echo null || echo OK) flowHealth=$([ "$FLOWHEALTH_JSON" = 'null' ] && echo null || echo OK) ruleEffectiveness=$([ "$RULEEFF_JSON" = 'null' ] && echo null || echo OK) dataIntegrity=$([ "$DI_JSON" = 'null' ] && echo null || echo OK)"
```

#### 6.6 ⚠️ 必须使用 jq 模板渲染 payload（禁止手写 JSON）

> ⚠️ **执行本节前请回头确认**：你已读过本文件顶部「强制约束（最高优先级）」中关于 payload 渲染的硬约束（原文：`❌ 禁止凭对话上下文「想象」上报 payload 字段位置或字段名 —— 上报前必须重新打开本文件 STEP 6.6 节，使用 jq 模板渲染 payload，禁止手写 JSON`）。
> 若上下文已被摘要，**必须重新打开 [commands/feai-archive.md](commands/feai-archive.md) 第 37-47 行**核对强制约束原文，禁止凭印象续写。

> **严格契约**：服务端只解构 5 个顶层字段：`source` / `event` / `userId` / `metadata` / `timestamp`。
> 业务字段全部必须放在 `metadata` 内，否则**全部丢弃为 null**。
> **禁止手写 JSON 字符串**，必须用以下 jq 模板渲染：

##### 6.6.0 前置变量自检（macOS bash 3.2 兼容，静默兜底不中断主流程）

> 设计意图：6.6 的 jq 模板用到 33 个 shell 变量，散落在 STEP 6.4 / 6.5 多处赋值。
> AI 上下文若被摘要，可能跳过赋值步骤直接渲染 payload，导致 `--arg userId ""` 等空值打到服务端。
> 本自检在渲染前强制核对一次，**遵循 STEP 6.9 契约：评分上报失败不打断归档主流程**。

```bash
# ====== 必填变量（缺则跳过整个 STEP 6 上报，归档主流程继续）======
MUST_HAVE_VARS="USER_NAME FEAI_VERSION SCORE PROJECT_NAME REPO_URL BRANCH CHANGE_NAME REQ_TITLE TASKS_TOTAL TASKS_DONE DATED_NAME"
MISSING_MUST=""
for v in $MUST_HAVE_VARS; do
  # 用 eval 替代 ${!v}，兼容 macOS 默认 bash 3.2
  val=$(eval "printf '%s' \"\${$v}\"")
  [ -z "$val" ] && MISSING_MUST="$MISSING_MUST $v"
done

if [ -n "$MISSING_MUST" ]; then
  echo "⚠️ 上报前置变量缺失（必填）：$MISSING_MUST"
  echo "   → 跳过 STEP 6（评分上报），归档主流程继续"
  SKIP_REPORT=1
fi

# ====== 可空变量（缺则填默认值，继续上报）======
# 这些字段允许为空（如 TAPD 未启用时 TAPD_ID/TAPD_URL 为空、SCORE>=3 时 FEEDBACK 为空）
[ -z "$USER_EMAIL"        ] && USER_EMAIL="unknown@unknown"
[ -z "$PROJECT_CODE"      ] && PROJECT_CODE="unknown"
[ -z "$GIT_PROJECT_ID"    ] && GIT_PROJECT_ID=""
[ -z "$BASE_BRANCH"       ] && BASE_BRANCH="master"
[ -z "$REQ_DESC"          ] && REQ_DESC=""
[ -z "$SCALE"             ] && SCALE="unknown"
[ -z "$FILES_CHANGED"     ] && FILES_CHANGED=0
[ -z "$LINES_ADDED"       ] && LINES_ADDED=0
[ -z "$LINES_DELETED"     ] && LINES_DELETED=0
[ -z "$TAPD_ENABLED"      ] && TAPD_ENABLED=false
[ -z "$TAPD_TYPE"         ] && TAPD_TYPE=""
[ -z "$TAPD_ID"           ] && TAPD_ID=""
[ -z "$TAPD_URL"          ] && TAPD_URL=""
[ -z "$TAPD_WORKSPACE_ID" ] && TAPD_WORKSPACE_ID=""
[ -z "$MR_URL"            ] && MR_URL=""
[ -z "$MR_IID"            ] && MR_IID=""
[ -z "$MR_STATE"          ] && MR_STATE="unknown"
[ -z "$WORKFLOW_MODE"     ] && WORKFLOW_MODE="normal"
[ -z "$FEEDBACK"          ] && FEEDBACK=""
# 三个聚合 JSON 已在 6.5 末尾做过 jq empty 兜底，此处不再重复
```

> 💡 **执行守则**：
> - 必填变量缺失 → `SKIP_REPORT=1`，6.6 后续 jq 渲染、6.7 自检、6.8 上报全部跳过，**归档主流程继续推进**
> - 可空变量缺失 → 填默认值后继续渲染，服务端可正常解构
> - 本自检**禁止 `exit 1`**，违反 STEP 6.9 契约（评分上报不打断归档）

##### 6.6.1 jq 模板渲染（仅当 SKIP_REPORT 未置位时执行）

```bash
if [ "${SKIP_REPORT:-0}" = "1" ]; then
  echo "⚠️ 根据 6.6.0 自检，跳过 jq 渲染与后续 6.7/6.8"
else

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
  --arg archivePath "openspec/changes/${DATED_NAME}.md" \
  --argjson efficiency "$EFFICIENCY_JSON" \
  --argjson flowHealth "$FLOWHEALTH_JSON" \
  --argjson ruleEff "$RULEEFF_JSON" \
  --argjson dataIntegrity "$DI_JSON" \
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
      workflow: { mode: $wfMode, archivePath: $archivePath },
      efficiency: $efficiency,
      flowHealth: $flowHealth,
      ruleEffectiveness: $ruleEff,
      dataIntegrity: $dataIntegrity
    },
    timestamp: (now * 1000 | floor)
  }' > "$PAYLOAD_FILE"

fi  # ← 与 6.6.1 顶部 if [ "${SKIP_REPORT:-0}" = "1" ]; then…else 配对
```

> 💡 `efficiency` / `flowHealth` / `ruleEffectiveness` 三个字段为 v0.28.0 新增的诊断指标。聚合失败时整体降级为 `null`，**不会破坏现有 metadata 自检**（自检仅校验 metadata 是非空 object，对内部字段不限定）。

##### 6.6.2 反例对照（执行后服务端必返回 400 / 数据丢失）

> 设计意图：LLM 阅读模式存在「看到正例容易心想我懂了」的弱点。本节用 4 个真实失败案例反向锚定，触发「这样写会被打脸」的警觉。

**反例 1：业务字段裸露在顶层**

```json
{ "tool": "feai", "version": "0.28.1", "rating": 4, "metrics": {...} }
```

↑ 顶层全是业务字段，未包入 `metadata`。
服务端解构后只会读到 `tool/version/rating/metrics` → **全部丢弃为 null**，落库一条空记录。
对应 6.7 自检 2 报错：`payload 顶层多余字段：tool,version,rating,metrics`。

**反例 2：metadata 是空对象**

```json
{ "source": "feai-tools", "event": "archive_rating", "userId": "alice", "metadata": {}, "timestamp": 1733971200000 }
```

↑ 顶层结构正确，但 `metadata` 内无任何业务字段。
对应 6.7 自检 3 报错：`metadata 不是非空对象`。

**反例 3：metadata 是字符串而非对象**

```json
{ "source": "feai-tools", "event": "archive_rating", "userId": "alice",
  "metadata": "{\"score\":4,\"version\":\"0.28.1\"}", "timestamp": 1733971200000 }
```

↑ AI 误把 metadata 整体当 JSON 字符串拼进去（手写 JSON 时极易犯错）。
服务端解构后 `typeof metadata === 'string'` → 整段丢弃为 null。
对应 6.7 自检 3 报错：`metadata 不是非空对象`。

**反例 4：score 是字符串而非数字**

```json
{ "source": "feai-tools", "event": "archive_rating", "userId": "alice",
  "metadata": { "score": "4", "version": "0.28.1" }, "timestamp": 1733971200000 }
```

↑ 用 `--arg score "$SCORE"`（字符串）而不是 `--argjson score "$SCORE"`（数字）。
对应 6.7 自检 4 报错：`score 非法："4"`（regex `^[1-5]$` 不匹配引号）。

> 💡 **核心防御**：以上 4 类错误**全部**在 6.7 的 5 项自检里能被拦截，**前提是你必须真的按 6.6 的 jq 模板渲染**而不是手写 JSON。
> 一旦 AI 跳过 jq 模板凭印象拼字符串，6.7 自检也会被一起跳过 —— 这就是为什么本节顶部的反向锚点要求**回头确认**强制约束原文。

#### 6.7 上报前自检（5 项缺一不可，任一失败必须短路）

> 前置条件：`SKIP_REPORT` 未置位。若 6.6.0 检出必填变量缺失，`SKIP_REPORT=1`，本节**整段跳过**。

```bash
if [ "${SKIP_REPORT:-0}" = "1" ]; then
  echo "⚠️ 根据 6.6.0 自检，跳过 6.7/6.8，进入 6.9 兜底"
else

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

# 软提示（不影响 SAVE_FAILED）：三个诊断字段全 null 大概率是 6.5b 没真正跑或命名漂移
ALL_NULL=$(jq -r '(.metadata.efficiency == null) and (.metadata.flowHealth == null) and (.metadata.ruleEffectiveness == null)' "$PAYLOAD_FILE" 2>/dev/null)
if [ "$ALL_NULL" = "true" ]; then
  echo "⚠️ efficiency / flowHealth / ruleEffectiveness 三字段全部为 null"
  DI_FOUND=$(jq -r '.metadata.dataIntegrity.metricsDirFound // empty' "$PAYLOAD_FILE" 2>/dev/null)
  DI_DRIFT=$(jq -r '.metadata.dataIntegrity.suspectedDriftDirs // [] | join(", ")' "$PAYLOAD_FILE" 2>/dev/null)
  DI_REASON=$(jq -r '.metadata.dataIntegrity.reason // empty' "$PAYLOAD_FILE" 2>/dev/null)
  if [ "$DI_FOUND" = "false" ]; then
    echo "   根因（已写入 payload.metadata.dataIntegrity）：$DI_REASON"
    echo "   当前 CHANGE_NAME='$CHANGE_NAME'，疑似漂移目录：${DI_DRIFT:-（无）}"
    echo "   → dataIntegrity 字段已如实上报，便于后台识别命名漂移"
    echo "   → 如需补救数据：用户手动把漂移目录改名为 \$CHANGE_NAME 后重跑 /feai-archive"
  else
    # 目录存在但日志缺失 → 区分具体哪条日志缺，便于定位是 start/review 哪个环节没跑埋点
    DI_TL=$(jq -r '.metadata.dataIntegrity.timelineLogFound // false' "$PAYLOAD_FILE" 2>/dev/null)
    DI_GT=$(jq -r '.metadata.dataIntegrity.gatesLogFound // false' "$PAYLOAD_FILE" 2>/dev/null)
    DI_MC=$(jq -r '.metadata.dataIntegrity.modeChoiceFound // false' "$PAYLOAD_FILE" 2>/dev/null)
    echo "   metrics 目录存在但聚合产物全空，细粒度诊断："
    echo "     timeline.log=$DI_TL  gates.log=$DI_GT  mode-choice.json=$DI_MC"
    if [ "$DI_TL" = "false" ]; then
      echo "   → timeline.log 缺失：feai-start STEP 1/4/6/7/8 的 begin/end 埋点 bash 段未执行（AI 只读不跑）"
    fi
    if [ "$DI_GT" = "false" ]; then
      echo "   → gates.log 缺失：feai-review 的门禁判定埋点未执行"
    fi
    echo "   → 三个字段保持 null，禁止 AI 凭印象重建数据"
  fi
  echo "   → 不阻断上报"
fi

# ⚠️ 关键：任一自检失败 → 必须短路，禁止把脏 payload 打到服务端
if [ "$SAVE_FAILED" = "1" ]; then
  echo "❌ 自检未通过，跳过上报。payload 已留档：$PAYLOAD_FILE"
  echo "   → 直接进入 STEP 7（按 6.9 兜底处理）"
  # AI 必须在此处终止 STEP 6，不得执行 6.8
fi

fi  # ← 与 6.7 顶部 if [ "${SKIP_REPORT:-0}" = "1" ]; then…else 配对
```

#### 6.8 执行上报 + 回执校验（强制，仅在 6.7 全部通过后执行）

> 前置条件：`SKIP_REPORT` 未置位 **且** `SAVE_FAILED=0`。若任一不满足，本节**整段跳过**。

```bash
if [ "${SKIP_REPORT:-0}" = "1" ] || [ "${SAVE_FAILED:-0}" = "1" ]; then
  echo "⚠️ 跳过 6.8（上报），进入 6.9 兜底"
else

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

fi  # ← 与 6.8 顶部 if [ SKIP_REPORT … ]; then…else 配对
```

#### 6.9 失败兜底

上报失败或被跳过（包括：6.6.0 变量缺失 `SKIP_REPORT=1`、6.7 自检未通过 `SAVE_FAILED=1`、6.8 网络异常 / 超时 / 业务码非 0）：
- ❌ **不打断**归档主流程（核心契约，与顶部强制约束「评分本身不会打断流程」一致）
- ✅ STEP 8 摘要静默标注「⚠️ 评分上报失败（已忽略）」，并记录具体原因（变量缺失 / 自检不过 / 上报失败）
- ✅ 失败 payload 已落盘 `<base>/.codebuddy/.cache/report-*.json`（若 6.6.1 jq 渲染已执行），下次 `/feai-archive` 启动时检测并提示补传
- ✅ 若 `SKIP_REPORT=1`（6.6.0 拦截，jq 渲染未执行），则无 payload 文件落盘，提示用户「本次未采集评分上报，下次归档可重试」

**产出物检查点：**
✅ 评分已采集；
✅ <3 分时反馈已采集；
✅ 6.6.0 前置变量自检已执行（必填齐全 → 继续渲染；缺失 → SKIP_REPORT=1 跳过 6.6.1/6.7/6.8）；
✅ 若已渲染：payload 由 jq 模板渲染（非手写）、5 项自检全部通过、回执校验已执行；
✅ 若被跳过或失败：STEP 8 摘要已记录原因，归档主流程未受影响。

---

### [STEP 7/8] 工作区清理（防污染）

> 这是 skillhub 防止"残留污染下次需求"的关键步骤。

清空以下文件，使工作区进入"可接受新需求"状态。**4 个状态文件统一保留并改写为占位语**（参考 skillhub `.openspec/` 状态机制）：

| 文件 | 处理方式 |
|------|---------|
| `<base>/openspec/plan.md` | 重置为占位语（见 7.0），并附「上一需求归档于 X：Y」指纹 |
| `<base>/openspec/proposal.md` | 重置为占位语（见 7.0），并附「上一需求归档于 X：Y」指纹 |
| `<base>/openspec/spec.md` | 重置为占位语（见 7.0），并附「上一需求归档于 X：Y」指纹 |
| `<base>/openspec/current_state.md` | ① 删除「## 当前进行中」段（由 `/feai-start` STEP 8.2.5 写入）；② 更新「上一个需求」指针为本次归档；③ 在「历史归档」段追加一行 `- YYYY-MM-DD：{需求名}（{完成数}/{总数} 任务）` |

#### 7.0 plan / proposal / spec 重置写入命令（强制）

> 💡 **为什么要展开**：v0.32 之前这里写「同上占位语」，但占位语的"指纹"（上一需求归档于 X：Y）是必须由本次归档动态注入的，AI 容易误以为只要保留模板原文即可，导致归档后这 3 个文件失去"上次做了啥"的上下文（与 skillhub 实证不符）。本节给出明确写入命令以杜绝歧义。

**写入模板**：

```markdown
# 当前{执行计划|需求提案|技术规格}

> 工作区已清理（上一需求归档于 YYYY-MM-DD：{需求名}）。
>
> - 详细变更记录：`openspec/changes/YYYY-MM-DD-<change-name>.md`
> - 源分支：`{当前 git 分支}`
>
> 请通过 `/feai-start` 启动新流程。
```

**写入伪命令**：

```bash
# ⚠️ 1. {需求名} 与 7.1 current_state.md「上一个需求」段保持完全一致字符串（同一来源）
# ⚠️ 2. YYYY-MM-DD 取归档当天本地日期（date +%Y-%m-%d），与归档单文件名前缀一致
# ⚠️ 3. <change-name> 来自 STEP 4.3 公式产物，禁止重新构造
# ⚠️ 4. 必须用 cat > 全量覆盖（这 3 个文件不需要保留任何历史，每次归档都重置为最新指纹）
#       但 current_state.md 严禁 cat > 覆盖（见 7.1）
ARCHIVED_DATE=$(date +%Y-%m-%d)
SOURCE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
DATED_NAME="${ARCHIVED_DATE}-${CHANGE_NAME}"
FEATURE_TITLE="<本次需求名（与归档单文件 H1 标题保持一致）>"

for f in plan:执行计划 proposal:需求提案 spec:技术规格; do
  fname="${f%%:*}"
  ftitle="${f##*:}"
  cat > "<base>/openspec/${fname}.md" <<EOF
# 当前${ftitle}

> 工作区已清理（上一需求归档于 ${ARCHIVED_DATE}：${FEATURE_TITLE}）。
>
> - 详细变更记录：\`openspec/changes/${DATED_NAME}.md\`
> - 源分支：\`${SOURCE_BRANCH}\`
>
> 请通过 \`/feai-start\` 启动新流程。
EOF
done
```

**写后自检**：

```bash
# 3 个文件都必须命中"上一需求归档于"关键字，否则视为重置失败
for f in plan proposal spec; do
  grep -q "上一需求归档于" "<base>/openspec/${f}.md" || {
    echo "❌ <base>/openspec/${f}.md 重置失败（未注入指纹），归档不能继续"
    exit 1
  }
done
```

#### 7.1 current_state.md 追加格式（强约束）

执行后，`current_state.md` 顶部应呈现如下结构：

```markdown
# 当前需求状态

> 当前没有进行中的需求。
>
> 上一个需求：「{需求名}」已于 YYYY-MM-DD 归档（X/Y 任务完成）。
> - 详细变更记录：`openspec/changes/YYYY-MM-DD-<change-name>.md`
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

#### 7.1.1 移除「## 当前进行中」段（与 /feai-start STEP 8.2.5 形成闭环）

> 💡 **为什么单独处理**：`/feai-start` STEP 8.2.5 会在需求规划完成时往 current_state.md 注入「## 当前进行中」段；归档时必须主动移除这段，否则会出现"需求都归档了但 current_state 还显示进行中"的状态分裂。

**写入伪命令**：

```bash
# ⚠️ 1. 严禁 cat > 整文件覆盖（会丢失「上一个需求」「历史归档」）
# ⚠️ 2. 必须用段落级精确删除：从「## 当前进行中」开始，到下一个「## 」或「> 上一个需求」前一行结束
# ⚠️ 3. 删除完成后必须自检：grep -q '^## 当前进行中' 应该返回非零（不存在）
CSF="<base>/openspec/current_state.md"
if grep -q '^## 当前进行中' "$CSF"; then
  python3 - "$CSF" <<'PY'
import sys, re
p = sys.argv[1]
with open(p, encoding='utf-8') as f:
    src = f.read()
# 删除「## 当前进行中」起，到下一个 H2（## ）或顶层引用块（> 上一个需求 / 历史归档）前
new = re.sub(
    r'\n## 当前进行中\n.*?(?=\n## |\n> 上一个需求|\n> 历史归档|\Z)',
    '\n',
    src,
    count=1,
    flags=re.S,
)
with open(p, 'w', encoding='utf-8') as f:
    f.write(new)
PY
fi

# 自检：删除后必须不再出现该段
grep -q '^## 当前进行中' "<base>/openspec/current_state.md" \
  && { echo "❌ 「## 当前进行中」段未成功移除，归档不能继续"; exit 1; } \
  || true
```

---

### [STEP 8/8] 门禁检查 + 归档输出

#### 8.1 对照 gate-archive.md 逐项检查

对照 `<base>/.workflow/checklists/gate-archive.md` 逐项检查（如清单文件存在）。

#### 8.2 输出归档摘要

```
## ✅ 归档完成

**变更名:** <change-name>
**归档位置:** <base>/openspec/changes/YYYY-MM-DD-<change-name>.md（扁平单文件）

### 归档清单
├── ✅ 任务完成：X/Y 个任务
├── ✅ 制品：合并渲染为 6 段单文件（需求概要/任务/决策/实施/规范/回顾）
├── ✅ 经验沉淀：5 段（关键决策/踩坑/选型/复用/TODO）已并入「三、关键决策」+「六、回顾与改进」
├── ✅ 业务文档：<base>/docs/{module}.md 已更新 / ⏭️ 项目无 docs/
├── ✅ 架构文档：<base>/openspec/config.yaml [已更新 / 无需更新]
├── ✅ Delta Spec 同步：[已同步 / 跳过 / 无 Delta Specs]
├── ✅ 工作区清理：plan.md / proposal.md / spec.md 已重置为带指纹占位语；current_state.md「## 当前进行中」段已移除
├── ✅ 长期记忆：current_state.md 已追加本次归档历史
├── ✅ 评分上报：score=N，[已上报 / 已禁用 / ⚠️ 上报失败已忽略]
└── ✅ 门禁：gate-archive ✅ 通过

💡 本次变更已沉淀到项目知识库，下次 /feai-start 时 AI 将自动加载相关上下文。
```

#### 8.3 TAPD 流程（条件触发，对应 G15）

当 `<base>/.workflow/project.yaml` 中 `integrations.tapd.enabled: true` 时：
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
| 检查清单 | `<base>/.workflow/checklists/gate-archive.md` | STEP 8 |

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

- `/feai-start` **阶段 4D**（推荐路径）：最后一批 review 通过后**主动**进入归档，commit 之前完成（v0.28.x+ 新增）
- `/feai-start` **STEP 1.2** 是未归档检测的金标准——通过 `plan.md` 三信号公式（归档占位语 / 任务总数 / 未完成数）识别 S/M/L 全规模的未归档需求，发现后强制引导归档
- `/feai-start` **STEP 1.3** 作为辅助层扫描 `<base>/openspec/changes/` 下的历史遗留目录（M/L 级开发期产物 / 旧版残骸），与 1.2 联动给出更精准的归档提示
- `/feai-start` **STEP 1.4** 会检测归档过时（reviewer 改代码后 spec 没同步，L4 防遗忘机制）
- `/feai-start` **阶段 6**（兜底路径）：仅当 4D 被跳过时触发——MR 创建成功后检测到归档产物未随代码进 commit，会询问是否补归档（追加 commit 到当前 MR）
- 普通对话中，提到"MR 创建成功 / MR 提了 / 开了 MR / 推上去了"等关键词时，AI 会主动提示运行 `/feai-archive`（趁 MR 未合并，归档 commit 可追加到同一个 MR）
