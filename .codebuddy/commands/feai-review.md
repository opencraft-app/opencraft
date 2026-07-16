# `/feai-review` — 批次审核门禁

> 执行阶段的批次审核入口。每批任务完成后调用，运行适用检查、对照 implementation gate，只有审核通过后才标记 plan 任务完成。

---

## 命令格式

```bash
/feai-review [批次号 | --quick | --full | --final | --auto]
```

| 参数 | 说明 |
|---|---|
| 无参数 | 自动识别本批待审核任务。 |
| `<批次号>` | 显式指定批次，用于回溯审核。 |
| `--quick` | diff scan + 相关测试 + 可用 lint/typecheck + 关键门禁。 |
| `--full` | 完整 gate + 全量测试/类型/lint + 必要 skill。 |
| `--final` | 最后一批，强制执行可用的 P0 E2E。 |
| `--auto` | 只运行自动化检查，跳过人工判断项。 |

---

## 硬约束

- 禁止在审核未通过前把任务标记为 `- [x]`。
- 禁止跳过自动化检查直接给“通过”。
- 禁止用主观判断替代命令结果。
- 重复同一失败假设且没有新证据、需求边界漂移，或缺少外部事实导致无法继续复现时，触发 Stop-and-Ask；仓库内仍有安全证据可查时继续调查。
- 以下编号只描述流程结构，不要求运行时逐步输出；自动化检查应聚合执行。

---

## 成本分层

默认按 `.workflow/rules/flow-cost.md`：

| 模式 | 默认场景 | 必做 |
|---|---|---|
| quick | S 级、M 级普通批次 | diff scan、相关测试、可用 lint/typecheck、关键门禁 |
| full | L 级关键批、最终批、用户指定 | 完整 gate、全量测试、必要 skill、E2E capability |
| auto | CI / 只需机器检查 | 自动化命令，跳过人工判断项 |

升级到 full：`--final`、影响文件 > 5、连续失败 >= 2、高风险模块、Reviewer 初筛发现 P0/P1 风险。

---

## 5 步流程

### 阶段 1：识别当前批次

1. 用聚合脚本解析 `<base>`、分支、plan 和工作区：

```bash
feai workflow start-inspect --json
```

2. 读取 `<base>/openspec/plan.md`，识别本批已实现但未标记 `[x]` 的任务。
3. 输出本批任务、涉及文件和预期验证范围。
4. 写入 usage-context，统一走脚本单源：

```bash
feai workflow change-name --json
feai workflow usage-context write --change-name <change-name> --project-base <base> --json
```

provider 以 metrics 目录内唯一的 `usage-context.json` 已确认值为准；如本次确认了新 provider，设置 `USAGE_PROVIDER=<provider>` 由脚本补写。CLI 自行计算 canonical metrics 路径；根目录已有同名文件完全忽略，由用户自行清理。脚本会保留已存在的审计窗口，旧上下文缺少 `window.start` 时补齐开始时间。禁止静默依赖 `project.local.json` 猜测 provider。

usage-context 写入失败不阻塞 review，但必须在结论里标注。

从 implementation 切入 review 前，按 `context-recovery.md` 判断是否需要独立审核 session；长实现会话、高风险改动或需要独立审查视角时使用：

```bash
feai workflow handoff write --from implementation --to review --apply --json
feai workflow phase run --phase review --execute --json
```

review session 默认只读，不修改业务代码；返回结果由主流程决定任务是否可标记完成。

### 阶段 2：探测包管理器与脚本

使用一次聚合探测，不分别读取 lockfile、package scripts 和测试文件：

```bash
feai workflow review-inspect --json
```

输出并判断：

- package manager
- unit test
- typecheck
- lint
- P0 E2E

未配置的检查项标记 `不适用`，不得伪造命令。

### 阶段 3：执行自动化检查

按顺序运行适用检查：

1. 相关单元测试；不支持精确范围时降级全量。
2. TypeScript / 类型检查。
3. Lint。
4. P0 E2E：`--final`、最后一批或关键路径改动时执行。

quick 模式的早停纪律：

- 局部、低风险且依赖面未变化时，已有可精确运行的相关测试即可；共享工具、状态/事件链、公共接口、构建配置、关键路径或影响范围不确定时，追加包级、集成或 P0 E2E 验证。
- 相关测试通过后，仓库既有的无关全量失败不做破坏性的 `HEAD~N` checkout、stash 基线回放；可读取现有 CI、验证 ledger 或使用非破坏性命令判断是否为本次回归。
- 检查失败后按新证据做针对性诊断和修复重跑；重复相同假设且没有新证据时停止机械重试并给出结论，不能用固定重试次数截断仍可推进的根因分析。
- 读取、搜索、测试、lint/typecheck 等无依赖的只读动作应在单次工具批次中合并执行；过程状态不要求每个命令单独输出模型消息。

长输出按 `.workflow/rules/terminal-output.md` 摘要，不把完整日志塞进对话。

### 阶段 4：门禁审核

对照 `<base>/.workflow/checklists/gate-implementation.md` 逐项给出：

- `✅` 通过
- `❌` 失败
- `⏭️` 不适用

`--auto` 只能跳过人工判断项，不能跳过自动化命令。

### 阶段 5：输出结论并更新进度

通过时：

- 使用 `feai workflow plan-task set --task <ID> --status done --apply --json`，仅标记本批通过任务。
- 跳过任务必须使用 `--status skipped --reason "<原因>"`；禁止批量替换全部 checkbox。
- 刷新 `.workflow/runtime/current-task.summary.md`：下一批 active slice ≤ 3 任务、branch、planHash、updatedAt、status。
- 追加 `.workflow/runtime/verification-ledger.md`：命令、范围、结果、失败摘要、结论；不复制完整终端输出。
- 若全部任务完成，输出 `templates/workflow/cards/feai-review.md` 的“全部完成”卡片。

失败时：

- 保持 plan 任务未完成。
- 输出失败项、根因、修复建议和下一步。
- 命中 Stop-and-Ask 时调用 `systematic-debugging` skill，等待用户决策。

---

## 输出模板

通过：

```text
✅ 批次审核通过 — 第 {N} 批

自动化检查:
├── 单元测试: ✅ / ❌ / ⏭️
├── 类型检查: ✅ / ❌ / ⏭️
├── Lint: ✅ / ❌ / ⏭️
└── P0 E2E: ✅ / ❌ / ⏭️

门禁: gate-implementation 通过 / 有条件通过
进度: {已完成 X}/{总 Y}
下一批: {任务列表 / 全部完成}
```

失败：

```text
❌ 批次审核未通过 — 第 {N} 批

失败项:
- ...

根因:
...

修复建议:
1. ...
2. ...

任务保持未标记，请修复后重新运行 /feai-review。
```

---

## 与其他命令的关系

```text
/feai-start  → plan.md 通过门禁
      ↓
执行阶段（每批 ≤ 3 任务）
      ↓
/feai-review（每批）
      ↓
全部完成后输出验收摘要，等待用户确认
      ↓
用户明确要求后 /feai-archive / commit / push / MR
```

`/feai-review` 是批次门禁；最终提交前的 CR / MR 检查仍按 `/feai-start` 后续发布流程执行。
