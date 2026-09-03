# 产物与状态文件

所有文件位于 `<项目根>/.workflow/native/`。**state.yaml、current.json、.lock 由引擎独占，禁止手写/手改**；brief.md / report.md / plan.md 由你（agent）撰写。

## Git 共享边界

- **应提交**：`changes/<name>/brief.md`、可选 `plan.md`、`report.md`，以及 `archive/<name>/` 内同类文档。这些是团队可审阅、可跨工作树恢复的需求与交付证据。
- **不提交**：`current.json`、各 change 的 `state.yaml` / `audit.log` / `.lock` / `runtime/`。它们是机器本地的指针、并发控制与执行状态。
- 在新工作树或新机器上，`status` 若发现已提交的 `brief.md` 而没有本地 active 指针，会返回候选列表；显式运行 `feai native resume --name <name> --json`。缺少本地 `state.yaml` 时，引擎会从 `brief.md` 重建到 shape，并要求重新确认契约，不会猜测此前推进位置。

## 目录结构

```
.workflow/native/
├── current.json              # active 指针：{"change": "<name>"}
├── changes/
│   └── <name>/               # active change 目录
│       ├── state.yaml        # 引擎状态（两层 schema，见下）
│       ├── brief.md          # shape 阶段你写：需求契约（批准基准）
│       ├── report.md         # verify 阶段你写：验证报告
│       ├── plan.md           # 可选：任务拆分与工作笔记
│       ├── audit.log         # 引擎追加的审计日志（JSON Lines）
│       └── .lock             # 命令执行期间的锁（引擎自动创建/释放）
└── archive/
    └── <name>/               # archive 后整个 change 目录搬到此处
```

- `current.json`：指针损坏（change 名非法，如路径逃逸）或指向无 state.yaml 的目录时，`status` 自愈删除；若目录仍有 `brief.md`，会作为可 `resume` 的共享候选显示。
- `audit.log`：每行一条 JSON，条目类型为 `transition` / `repair` / `archive`，均带 `at` 时间戳；仅 `transition` 条目带 `fingerprint`（`repair` 条目为 `verdict`+`signature`，`archive` 条目为 `change`，均无指纹）；允许滞后，写失败不影响主流程。
- `.lock`：内容为 `{token, pid, hostname, startedAt, command}`。同主机 + 进程已死 + 锁龄超 10 分钟视为残留，由后续命令自动回收；不可解析的锁（如崩溃留下的 0 字节文件）按 mtime 判龄。

## state.yaml 字段（schema: feai.native.v1）

顶层：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | string | 固定 `feai.native.v1`；不兼容 → 65（fail-closed） |
| `revision` | int | 从 1 起，每次写入 +1；配合 `--expect-revision` 做乐观并发 |
| `current_step` | string | 当前阶段 id（shape / build / verify / archive） |
| `steps` | map | 各阶段状态，见下层表 |
| `failure` | map | 失败追踪：`last_signature` / `consecutive_same` / `total` / `overrides_used` |
| `last_transition` | map\|null | 最近推进：`fingerprint` / `from` / `to` / `at` / `result`（完整重放载荷，幂等用） |
| `data` | map | 引擎杂项：`current_contract_hash` / `approved_contract_hash`（brief 内容指纹与批准指纹） |

`steps.<id>` 层：

| 字段 | 说明 |
|---|---|
| `status` | `pending` / `in_progress` / `done` |
| `outcome` | 有分支的步（verify / archive）推进出时的 outcome（`pass` / `fail` / `done`）。仅推进时传入 `--outcome` 才写入，故无分支的步（shape / build）推进出后也无此字段 |
| `attempts` | 经推进进入该步的次数（首个阶段的初始激活不计，回退再进入时累计） |

## brief.md 最小内容

- **需求**：背景、目标、成功标准
- **方案**：怎么做、范围与非目标、约束
- **关键上下文发现**：现场调查结论（相关代码位置、既有实现、风险）
- **验证口径**：怎么验证算通过

**批准后不要再改**：引擎按内容 hash 比对，漂移即触发重新批准（`approval-required`）。

## report.md 最小内容

- **执行的验证命令**：测试/构建/lint/手工步骤，逐条列出
- **结果**：每条命令的实际结果与总结论（通过/不通过）
- **遗留风险**：未覆盖项、已知限制

证据必须真实：命令要实际运行过，结果不许编造。
