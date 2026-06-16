# `/feai-review` — 批次审核门禁

> 前端 AI 编程工具（frontend-ai-dev-tools）的批次审核命令。
> 执行阶段中，每批任务（建议 ≤ 3 个）编码完成后调用，对照 `gate-implementation.md` 逐项检查。
>
> 📄 信任模式、错误恢复等通用规范请参考 `AGENTS.md`。

---

## 命令格式

```
/feai-review [批次号 | --auto]
```

### 参数说明

| 参数 | 说明 | 示例 |
| ---- | ---- | ---- |
| 无参数 | 自动识别 plan.md 中本批已完成但未标记 `[x]` 的任务 | `/feai-review` |
| `<批次号>` | 显式指定批次（用于回溯审核） | `/feai-review 2` |
| `--auto` | 仅运行自动化检查，跳过人工判断项（CI 模式） | `/feai-review --auto` |
| `--final` | 最后一批，强制运行 P0 E2E（如项目支持） | `/feai-review --final` |

### 使用示例

```bash
# 标准批次审核（推荐）
/feai-review

# 最后一批审核（含 P0 E2E）
/feai-review --final

# 仅自动化检查
/feai-review --auto
```

---

## 触发时机

- ✅ 执行阶段中，**每批任务编码完成后**自动触发
- ✅ Reviewer 角色每批必调
- ✅ 用户手动调用进行复检

---

## 强制约束

- ❌ 禁止在审核未通过前将任务标记为 `- [x]`
- ❌ 禁止跳过自动化检查直接给出"通过"结论
- ❌ 禁止用"看起来没问题"等主观判断替代实际命令执行
- ❌ 禁止在连续 3 次失败后继续尝试（必须触发 Stop-and-Ask，对应 G4）
- ✅ 每步必须输出 `[STEP N/5]` 格式的步骤追踪
- ✅ STEP 5 结论产出后必须写入 `gates.log` 埋点（参见下方）

---

## 📊 工作流诊断埋点（v0.28.0+）

> 目的：采集批次审核质量信号，驱动工作流改善。埋点失败静默，永不阻塞审核本身。

```bash
# 从当前分支名提取 change-name（与 feai-start / feai-archive 保持完全一致）
# 支持 feat | fix | feature | hotfix | chore 五种前缀
# 用 .* 贪婪匹配，吃到最后一段 4 位 MMDD —— 兼容用户名含连字符（如 eric-hu / zhang-san-feng）
CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | sed -E 's|^(feat\|fix\|feature\|hotfix\|chore)/.*-[0-9]{4}-||')
# Fallback：剥不出来（分支名不符合规范）→ 回退为整个分支名（/ 替换为 -），保证 CHANGE_NAME 永远非空
if [ "$CHANGE_NAME" = "$(git rev-parse --abbrev-ref HEAD)" ]; then
  CHANGE_NAME=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
fi
METRICS_DIR="<base>/.codebuddy/.cache/metrics/${CHANGE_NAME}"
mkdir -p "$METRICS_DIR" 2>/dev/null || true
```

### STEP 5 必须写入的事件

| 场景 | 写入内容 |
|-----|---------|
| 本批审核通过 | `{"batch":<num>,"attempt":<num>,"result":"pass","failedChecks":[],"durationSec":<num>}` |
| 本批审核有条件通过 | `{"batch":<num>,"attempt":<num>,"result":"conditional","failedChecks":["..."],"rejectReason":"..."}` |
| 本批审核打回 | `{"batch":<num>,"attempt":<num>,"result":"reject","failedChecks":["..."],"rejectReason":"..."}` |
| Stop-and-Ask 触发（3 次连续失败）| `{"batch":<num>,"event":"stop_and_ask","ts":<unix_ms>}` |

> 💡 `attempt` 是本批次第几次运行 `/feai-review`（从 1 开始）。AI 需读取 `gates.log` 统计当前 batch 已出现过几次。

### 必须同时写入 timeline begin/end（对应 G23，配对计算 durationSec）

> 🔴 **结构性约束**：review 阶段必须**同时**写 `phase:"begin"` 与 `phase:"end"` 两条事件，否则 archive STEP 6.5b 的 jq 聚合（`(ends[0].ts - begins[0].ts)/1000`）拿不到 begin 会让 `durationSec` 永远为 `null`。
>
> - **begin 写入时机**：STEP 1 完成「本批任务清单输出」之后、STEP 2 开始之前（即真正进入审核动作之前）
> - **end 写入时机**：STEP 5 输出审核结论 + 写入 `gates.log` 的同一时刻
> - 两条事件必须使用**同一份** `BATCH` / `ATTEMPT` 变量值，确保 stage 名严格匹配

```bash
# ─────────── STEP 1 末尾：批次识别完毕，立即写 begin ───────────
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
echo '{"stage":"review.batch'${BATCH:-0}'.attempt'${ATTEMPT:-0}'","phase":"begin","ts":'$NOW_MS'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true

# ─────────── STEP 5 末尾：结论产出，写 end + token 自报 ───────────
# ⚠️ 仅在平台 usage 元数据中看到真实 token 时才赋值，读不到保持未赋值
# 🔴 禁止凭「对话长度感觉」估算 token；违者在 archive 会被 tokenSource=ai-estimated 标记
TOKEN_IN=        # 读取平台 usage 元数据中的 input_tokens；读不到留空
TOKEN_OUT=       # 同上
IDLE=            # 仅当能从 timestamp 明确算出等待时间占比时才填
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
# ⚠️ 变量为空时 ${VAR:-null} 会填 null，避免生成 "tokenIn":, 类非法 JSON
echo '{"stage":"review.batch'${BATCH:-0}'.attempt'${ATTEMPT:-0}'","phase":"end","ts":'$NOW_MS',"tokenIn":'${TOKEN_IN:-null}',"tokenOut":'${TOKEN_OUT:-null}',"userIdleRatio":'${IDLE:-null}'}' \
  >> "$METRICS_DIR/timeline.log" 2>/dev/null || true
```

---

## 执行流程（5 步门禁链）

### [STEP 1/5] 识别当前批次

1. 读取 `<base>/openspec/plan.md`（`<base>` 解析规则见下文路径基准段）
2. 找出本批已完成但**未标记 `[x]`** 的任务（即刚实现完待审核的任务）
3. 输出本批任务清单：

```
📋 本批审核任务（共 N 个）
   • 任务 1: <描述>（涉及文件: src/foo.tsx, src/bar.ts）
   • 任务 2: <描述>（涉及文件: src/baz.tsx）
   • 任务 3: <描述>（涉及文件: src/qux.ts, src/qux.test.ts）
```

4. **立即写入 review.batch{N}.attempt{M} 的 begin 埋点**（参见上文「📊 工作流诊断埋点」段的代码块；缺失会导致 archive 端 `durationSec` 永远为 null）

**产出物检查点：** 已识别本批任务清单，至少 1 个任务待审核；`timeline.log` 末尾已追加一条 `phase:"begin"` 事件。

---

### [STEP 2/5] 包管理器与脚本探测

> 💡 feai 是多项目通用工具，不写死 `pnpm`，必须自动探测。

按以下顺序判断：

```bash
# 1. 优先判断 lockfile（最权威）
if [ -f "<base>/pnpm-lock.yaml" ]; then PM="pnpm"
elif [ -f "<base>/yarn.lock" ]; then PM="yarn"
elif [ -f "<base>/package-lock.json" ]; then PM="npm"
elif [ -f "<base>/bun.lockb" ]; then PM="bun"
else PM="npm"  # 兜底
fi

# 2. 读取 package.json scripts，识别可用命令
node -e "const s = require('<base>/package.json').scripts || {};
  console.log(JSON.stringify({
    test:    s['test:run']  || s['test:unit'] || s['test'] || null,
    type:    s['check']     || s['typecheck'] || s['type-check'] || null,
    lint:    s['lint']      || null,
    e2e_p0:  s['test:p0']   || null,
    e2e:     s['test:e2e']  || null,
  }))"
```

**输出：**
```
🔍 已探测：
   • 包管理器: pnpm
   • 单元测试: pnpm test:run    [可用]
   • 类型检查: pnpm check        [可用]
   • Lint:    pnpm lint         [可用]
   • P0 E2E:  pnpm test:p0      [可用 / 不可用 → 跳过]
```

**产出物检查点：** 已确定要运行的命令清单。**未配置的检查项自动跳过**，并在最终汇总中标注「⏭️ 不适用」。

---

### [STEP 3/5] 自动化检查（按顺序串行）

依次执行下列命令，**任一失败立即停止**并进入 STEP 5 的失败分支。

#### 3.1 单元测试（仅本批涉及的测试文件）

```bash
# 优先精确范围测试，避免全量测试浪费时间
{PM} test:run -- {本批涉及的测试文件路径列表}

# 若上述命令失败或不支持精确范围，降级为全量
{PM} test:run
```

#### 3.2 TypeScript 类型检查

```bash
{PM} check
# 或 {PM} typecheck（按 STEP 2 探测结果）
```

#### 3.3 Lint 检查

```bash
{PM} lint
```

> 仅校验本次改动文件（`git diff --name-only` 过滤 `.ts/.tsx/.js/.jsx`），如 lint 命令支持范围参数则使用，否则全量 lint 后对比 baseline。

#### 3.4 P0 E2E 冒烟测试（条件触发）

仅在以下任一条件成立时执行：
- 命令带 `--final` 参数
- plan.md 中标注本批为最后一批
- 本批改动涉及关键路径（路由、入口、核心 API）

```bash
{PM} test:p0
```

**产出物检查点：** 所有适用的检查项已运行，结果已记录。

---

### [STEP 4/5] 门禁逐项审核

对照 `<base>/.workflow/checklists/gate-implementation.md` 逐项检查：

| # | 检查项 | 方式 | 通过条件 |
|---|--------|------|---------|
| 1 | 单元测试通过 | 自动 | STEP 3.1 退出码 = 0 |
| 2 | 无新增 lint 错误 | 自动 | STEP 3.3 退出码 = 0 |
| 3 | 无 TypeScript 类型错误 | 自动 | STEP 3.2 退出码 = 0 |
| 4 | 未破坏现有交互 | 人工 | reviewer 确认（`--auto` 模式跳过） |
| 5 | 新增组件有错误边界 | 代码审查 | reviewer 抽查 |
| 6 | TDD 合规 | 确认 skill 调用 | `test-driven-development` 已调用 |
| 7 | P0 E2E 通过（最后一批必须） | 自动 | STEP 3.4 退出码 = 0 |

每项输出 `✅ / ❌ / ⏭️ 不适用` 三态。

**产出物检查点：** 7 项门禁结论已逐项给出。

---

### [STEP 5/5] 结论输出 + 进度更新

#### 通过分支

```
✅ 批次审核通过 — 第 {N} 批（{任务列表}）

自动化检查
├── 单元测试: ✅ {X} 个用例通过（{Y} ms）
├── 类型检查: ✅ 通过
├── Lint:    ✅ 无新增错误
└── P0 E2E:  ✅ 通过 / ⏭️ 不适用

门禁审核
├── 1. 单元测试通过       ✅
├── 2. 无新增 lint 错误   ✅
├── 3. 无类型错误         ✅
├── 4. 未破坏现有交互     ✅
├── 5. 新增组件有错误边界 ✅
├── 6. TDD 合规           ✅
└── 7. P0 E2E（最后批）   ✅ / ⏭️ 不适用

➤ 已在 plan.md 中将本批任务标记为 [x]
➤ 进度: {已完成 X} / {总 Y} 个任务
➤ 下一批: {提取 plan.md 中下一批任务清单 / 全部完成 → 见下方强提醒}
```

并执行：
1. 编辑 plan.md，将本批任务标记为 `[x]`
2. 提取下一批任务（如有）

#### 全部任务完成时的强提醒（v0.28.x+）

> 当本批审核通过后检测到 `plan.md` 中**所有任务**都已 `[x]`（不仅是本批），**必须**在结论之后追加输出以下卡片。
> 非阻断式：仅醒目提示正确时序，用户自行决定下一步，不强制等待 Y/n（避免高频 review 流程被阻塞）。

```
🎉 全部任务通过审核！下一步推荐时序（强烈建议先归档再提 MR）：

┌─────────────────────────────────────────────────────────────┐
│  📐 正确发布顺序                                             │
├─────────────────────────────────────────────────────────────┤
│  1. /feai-archive                                            │
│     └─ 沉淀 spec / 经验 / 知识库（不 commit，只产出文件）    │
│                                                              │
│  2. git commit + git push                                    │
│     └─ 代码 + 归档产物 一起原子提交，进同一个 MR             │
│                                                              │
│  3. 创建 MR / 等待评审                                       │
│                                                              │
│  4. 评审反馈若导致代码再改                                    │
│     └─ 再次 /feai-archive 增量更新归档，追加 commit 到同 MR  │
└─────────────────────────────────────────────────────────────┘

⚠️ 为什么先 archive 再 commit？
  • 归档产物（openspec/changes/{date}-{name}.md、knowledge/）是项目知识资产，
    必须随代码一起进主干，否则 MR 合并后知识就丢了
  • 如果先 commit + 提 MR 再归档，归档产物只能追加 commit，
    评审者会看到"无关的产物提交"，污染 MR 历史
```

**产出物检查点：** 全部完成场景下，强提醒卡片已输出；用户后续是否立即归档不阻塞 review 命令本身。

#### 打回分支

```
❌ 批次审核未通过 — 第 {N} 批

失败项
├── ❌ Lint 检查: src/foo.tsx:12 — 未使用的变量 `unused`
└── ❌ 类型检查: src/bar.ts:34 — Type 'string' is not assignable to 'number'

根因
{ 简述根因 }

修复建议
1. {建议 1}
2. {建议 2}

➤ 任务保持未标记状态，请修复后重新运行 /feai-review
```

**产出物检查点：** 结论已输出，plan.md 已按结论更新或保持原状；gates.log 已记录本轮结果。

#### 强制埋点示例（在输出结论后立即执行）

```bash
# 以下变量由 AI 根据本轮结果填入
BATCH=2                          # plan.md 中的批次号
ATTEMPT=1                        # 本批第几次运行 /feai-review（1 起）
RESULT="pass"                    # pass / conditional / reject
FAILED_JSON='[]'                 # 失败检查项 JSON 数组，例：["unit-test","lint"]
REJECT_REASON=""                 # 打回/有条件通过时填，一句话说清根因
DURATION=$ELAPSED                # 本次 review 总耗时（秒，可从 STEP 开始时间戳计算，不可得填 0）

jq -nc \
  --argjson batch "$BATCH" \
  --argjson attempt "$ATTEMPT" \
  --arg result "$RESULT" \
  --argjson failed "$FAILED_JSON" \
  --arg reason "$REJECT_REASON" \
  --argjson dur "$DURATION" \
  '{batch:$batch,attempt:$attempt,result:$result,failedChecks:$failed,rejectReason:$reason,durationSec:$dur,at:(now*1000|floor)}' \
  >> "$METRICS_DIR/gates.log" 2>/dev/null || true
```

> ⚠️ Stop-and-Ask 触发同场景补充写入：
>
> ```bash
> NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))' 2>/dev/null || date +%s000)
> echo '{"batch":'${BATCH:-0}',"event":"stop_and_ask","ts":'$NOW_MS'}' \
>   >> "$METRICS_DIR/gates.log" 2>/dev/null || true
> ```

---

## 路径基准（v0.6.0+ 多目录支持）

执行前**必须**读取 `.codebuddy/project.local.json` 中的 `projectRoot` 字段：

| `projectRoot` 值 | 实际路径 |
|-----------------|---------|
| 字段不存在 / `""` / `"."` | `openspec/plan.md`、`package.json` 等位于仓库根目录 |
| `"frontend"` 等子目录 | `<projectRoot>/openspec/plan.md`、`<projectRoot>/package.json` |

下文中 `<base>` 均指代解析后的实际路径基准。

---

## 连续失败处理（Stop-and-Ask）

> 对应全局规则 G4：测试连续失败 3 次 → 立即停机询问。

- 同一批次连续 **3 次** `/feai-review` 未通过
- 立即触发 **Stop-and-Ask**：
  1. 调用 `systematic-debugging` skill 进行根因分析
  2. 向用户报告：
     - 问题根因
     - 2-3 个可行的修复方案（含取舍）
     - 是否需要回退到 plan 阶段调整任务
  3. 等待用户决策，**禁止 AI 自行决定**

---

## 与其他命令的关系

```
/feai-start  ──▶  plan.md 通过门禁
                          │
                          ▼
                  执行阶段（每批 ≤ 3 任务）
                          │
                          ▼
                ⭐ /feai-review ⭐  ←─ 每批必调
                          │
                ┌─────────┴─────────┐
                │                   │
            ✅ 通过              ❌ 打回
                │                   │
        进入下一批 / 全部完成    修复后重新审核
                │
                ▼
          /feai-archive 归档沉淀
```

---

## 与 `/feai-start` 阶段 4C 的区别

| 维度 | `/feai-start` 阶段 4C `cr-check` | `/feai-review` |
|-----|--------------------------------|---------------|
| 范围 | 全部本次改动文件 | 本批刚完成的任务 |
| 时机 | 归档+提交前一次性总检（4C → 4D archive → 5 commit） | 每批结束都跑 |
| 自动化 | 主要依赖 `cr-check` skill | 包管理器探测 + 实跑命令 + 7 项门禁 |
| 输出 | P0/P1/P2 问题列表 | 通过/打回 + plan.md 进度更新 |

**两者互补**：`/feai-review` 是**批次门禁**（早发现，每批跑），`cr-check` 是**归档+提交前总检**（最后一道闸，跑一次）。

---

## 数据来源

| 数据 | 来源 | 用途 |
| ---- | ---- | ---- |
| 本批任务清单 | `<base>/openspec/plan.md` 未标 `[x]` 的任务 | STEP 1 识别 |
| 包管理器 | lockfile 探测 + `package.json.packageManager` | STEP 2 |
| 测试/类型/Lint 命令 | `<base>/package.json` scripts | STEP 2 / 3 |
| 改动文件清单 | `git diff --name-only` | 测试范围裁剪 |
| 检查清单 | `<base>/.workflow/checklists/gate-implementation.md` | STEP 4 |
