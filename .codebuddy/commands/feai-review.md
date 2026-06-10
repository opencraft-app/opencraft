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

**产出物检查点：** 已识别本批任务清单，至少 1 个任务待审核。

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

对照 `<base>/.codebuddy/.workflow/checklists/gate-implementation.md`（v0.16.0+ 路径，旧版兼容 `templates/workflow/checklists/gate-implementation.md`）逐项检查：

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
➤ 下一批: {提取 plan.md 中下一批任务清单 / 全部完成，建议执行 /feai-archive}
```

并执行：
1. 编辑 plan.md，将本批任务标记为 `[x]`
2. 提取下一批任务（如有）

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

**产出物检查点：** 结论已输出，plan.md 已按结论更新或保持原状。

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
| 时机 | 提交前一次性检查 | 每批结束都跑 |
| 自动化 | 主要依赖 `cr-check` skill | 包管理器探测 + 实跑命令 + 7 项门禁 |
| 输出 | P0/P1/P2 问题列表 | 通过/打回 + plan.md 进度更新 |

**两者互补**：`/feai-review` 是**批次门禁**（早发现），`cr-check` 是**提交前总检**（最后一道闸）。

---

## 数据来源

| 数据 | 来源 | 用途 |
| ---- | ---- | ---- |
| 本批任务清单 | `<base>/openspec/plan.md` 未标 `[x]` 的任务 | STEP 1 识别 |
| 包管理器 | lockfile 探测 + `package.json.packageManager` | STEP 2 |
| 测试/类型/Lint 命令 | `<base>/package.json` scripts | STEP 2 / 3 |
| 改动文件清单 | `git diff --name-only` | 测试范围裁剪 |
| 检查清单 | `.codebuddy/.workflow/checklists/gate-implementation.md` | STEP 4 |
