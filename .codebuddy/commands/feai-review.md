# `/feai-review` — 独立审核门禁

> 独立审核入口。M/L 最终调用；批次内流程按 `flow-cost.md`。

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
| full | M/L 最终批、用户指定 | 完整 gate、全量测试、必要 skill、E2E capability |
| auto | CI / 只需机器检查 | 自动化命令，跳过人工判断项 |

升级到 full：`--final`、用户指定，或独立审核发现 P0/P1 风险后重跑。

---

## 5 步流程

### 阶段 1：识别当前批次

1. 用聚合脚本解析 `<base>`、分支、plan 和工作区：

```bash
feai workflow start-inspect --json
```

2. 普通模式识别已实现但未标记的任务；`--final` 审核完整 change 与全部 plan 任务，不要求存在未标记项。
3. 输出本批任务、涉及文件和预期验证范围。
4. 写入 usage-context，统一走脚本单源：

```bash
feai workflow change-name --json
feai workflow usage-context write --project-base <projectRoot> --json
```

`<projectRoot>` 必须是项目根目录绝对路径，不是 Git base 分支名；CLI 会校验其与仓库配置的真实项目根完全一致。

`usage-context write` 缺省即用分支推断的 `change-name`（与 start/归档同源），**禁止手传完整分支名**；`change-name --json` 仅用于核对推断值。

provider 以 metrics 目录内唯一的 `usage-context.json` 已确认值为准；如本次确认了新 provider，设置 `USAGE_PROVIDER=<provider>` 由脚本补写。CLI 自行计算 canonical metrics 路径；根目录已有同名文件完全忽略，由用户自行清理。脚本会保留已存在的审计窗口；旧上下文缺少 `window.start` 时仅允许从 `timeline.log` 恢复，否则保留现场并失败，不会用当前时间覆盖。禁止静默依赖 `project.local.json` 猜测 provider。

usage-context 写入失败不阻塞 review，但必须在结论里标注。

`--final` 必须按 `context-recovery.md` 使用独立只读 review session；其他模式仅在长实现会话或高风险改动时使用：

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

通过时（非 `--final`）：

- 使用 `feai workflow plan-task set --task <ID> --status done --apply --json`，仅标记本批通过任务。
- 跳过任务必须使用 `--status skipped --reason "<原因>"`；禁止批量替换全部 checkbox。
- 刷新 `.workflow/runtime/current-task.summary.md`：下一批 active slice ≤ 3 任务、branch、planHash、updatedAt、status。
- 追加 `.workflow/runtime/verification-ledger.md`：命令、范围、结果、失败摘要、结论；不复制完整终端输出。
- 若全部任务完成，输出 `templates/workflow/cards/feai-review.md` 的“全部完成”卡片。

`--final` 不修改 plan、summary 或 ledger。审核必须返回 `verdict`；runner 将 verdict + branch/planHash/worktree fingerprint 写入 `phase-result.review.json`，仅新鲜 `pass` 可通过 archive preflight。

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

普通模式任务保持未标记；`--final` 不改任务状态。修复后以原模式重新审核。
```

---

## 与其他命令的关系

```text
/feai-start  → plan.md 通过门禁
      ↓
执行阶段（每批 inline quick + batch complete）
      ↓
/feai-review --final（M/L 最终一次；S 按需）
      ↓
全部完成后输出验收摘要，等待用户确认
      ↓
用户明确要求后 /feai-archive / commit / push / MR
```

`/feai-review` 是独立门禁；最终提交前的 CR / MR 检查仍按 `/feai-start` 后续发布流程执行。
