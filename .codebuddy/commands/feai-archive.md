# `/feai-archive` — 归档沉淀

> 将完成需求沉淀为 OpenSpec / 项目知识；确定性操作由 `feai archive` / `feai report` 承接。

---

## 命令格式

```bash
/feai-archive [变更名] [--light | --standard | --full]
```

| 参数 | 说明 |
|---|---|
| `变更名` | 可选。缺省时从当前分支提取 `change-name`。 |
| `--light` | S 级轻归档：必要记录、任务完成情况、状态清理。 |
| `--standard` | 默认归档：light + 经验沉淀 + 基础诊断。 |
| `--full` | 完整归档：standard + 完整 localUsageAudit 和更细验证摘要。 |

归档强度不降低任务、路径、状态及 metrics 真实性门禁。

S 级默认 `--light`，不因业务 bug 自动升级或新增 `docs/`；仅用户要求或存在稳定复用知识时升级。

---

## 推荐时机

```text
最后一批 /feai-review 通过（plan.md 全 [x]）
        ↓
输出验收摘要，等待用户确认
        ↓
用户明确要求归档后，/feai-archive 生成归档产物和状态清理
        ↓
用户明确要求提交后，代码 + 归档产物原子 commit
        ↓
push + 创建 MR
        ↓
评审改代码后，如知识/规格受影响，再次 /feai-archive 做增量归档
```

归档产物应随代码进入同一个 MR，避免知识沉淀滞后于实现；但归档、commit、push、MR 都必须在用户验收或明确指令之后执行。

---

## 8 步归档流程

以下编号只描述流程结构，不要求运行时逐步输出；机械步骤由脚本聚合，阻塞决策直接使用卡片。

### 阶段 1：前置检查

读取 P0-Min：

- `AGENTS.md`
- `.workflow/rules/global.md`
- `openspec/plan.md`

执行脚本检查：

```bash
feai archive preflight --json
```

按 `context-recovery.md` 判断是否创建 review → archive 独立 session；仅长上下文或需要独立审核时切换。

检查结果必须覆盖：

- 当前 CLI ≥ `0.45.0`，且同一 wrapper 支持 archive/report
- `projectRoot` / `<base>` 解析
- 当前分支与 `change-name`
- plan 任务完成、跳过、待完成数
- `git status --short`
- 是否存在旧版 `current_state.md` 会话态

存在未完成任务时，输出 `.workflow/cards/feai-archive.md` 的未完成任务卡片并等待用户选择。工作区有未提交变更时，提示是否与归档产物一起提交；禁止自动 commit / stash。

漏勾任务经用户确认后逐项执行 `feai workflow plan-task set`，禁止批量替换 checkbox。跳过项记录 reason 且不计为 completed；展示并确认不影响验收后，才可执行 `feai archive preflight --allow-skipped --json`。

### 阶段 2：归档名与模式确认

`change-name` 使用统一脚本公式：

```bash
feai workflow change-name --json
```

归档文件统一为扁平单文件：

```text
openspec/changes/YYYY-MM-DD-<change-name>.md
```

禁止新建 `archive/` 子目录或 `{date}-{name}/` 多文件归档目录。历史老格式只读兼容，不主动迁移。

### 阶段 3：提炼变更内容

根据模式采集：

| 模式 | 采集内容 |
|---|---|
| light | 需求概要、任务完成情况、关键文件、验证摘要、未实现项。 |
| standard | light + 关键实现决策、踩坑、技术选型、可复用经验。 |
| full | standard + localUsageAudit、完整验证证据索引、更多代码统计。 |

信息来源按优先级：

- `openspec/plan.md`、`proposal.md`、`spec.md`
- git diff / commit / 实际验证命令
- `.workflow/runtime/verification-ledger.md`
- 对话中的 TAPD / MR 线索

禁止凭空补写测试结果、token、成本、MR 状态或 TAPD 状态。

### 阶段 4：渲染归档单文件

使用脚本生成或辅助生成归档：

```bash
feai archive render --mode standard --json
# 确认后才使用 --apply 写入
feai archive render --mode standard --apply --json
```

render 直接消费 runtime investigation、deviations 和 ledger，不回读聊天历史。

单文件必须包含 6 段：

1. 需求概要
2. 任务完成情况
3. 关键决策
4. 实施摘要
5. 规范沉淀
6. 回顾与改进

`standard/full` 模式下，关键决策、踩坑、选型、复用经验、后续优化不能留空；确实无内容时写“本次需求未涉及”。

### 阶段 5：业务文档与 Spec 同步

- 如 `<base>/docs/` 存在，评估是否需要同步业务文档；不需要时在归档摘要说明原因。
- 如存在 Delta Specs，询问是否同步到 `openspec/specs/**`。
- 如新增/删除重要模块、依赖、公共 API 或稳定架构边界，必须更新 `openspec/current_state.md` 项目地图或 `openspec/config.yaml`；未命中这些条件时保持 `current_state.md` 不变。

`current_state.md` 只保留低频项目地图；禁止写入当前会话阶段、临时进度、上一个需求摘要或历史归档清单。需求历史以 `openspec/changes/*.md` 为准。也就是说，archive 阶段会检查 `current_state.md`，但只有稳定项目地图发生变化时才更新它。

### 阶段 6：评分与上报

评分采集：

- 询问 1-5 分。
- `<3` 分时采集 ≤500 字反馈。

payload、用量审计、诊断降级、自检和异步上报必须由单一 pipeline 完成，不允许拆成多轮试探，不允许手写 JSON 或自行拼 jq 模板：

```bash
feai report archive-pipeline --project <base> --change-name <change-name> --score <score> [--feedback "<feedback>"] --submit --json
```

仅当 pipeline 返回的 `audit.reason` / `validation.errors` 无法解释时，才单独运行 `feai report doctor --verbose`。`localUsageAudit=null` 是已定义降级结果，不触发重复修复 usage-context 或重复审计。

审计、doctor、payload 仅读 canonical change 目录；忽略根目录同名 JSON，不迁移或兜底。

上报 endpoint / apiKey 是脚本常量，AI 不得从配置、环境变量或记忆中推理替换。上报失败或禁用不阻断归档主流程，只在最终摘要记录。

评分、provider、审计窗口、降级和上传字段白名单的细则统一见 `.workflow/rules/workflow-reporting.md`；command 正文不重复维护。

### 阶段 7：状态清理

归档完成后，重置状态文件：

```bash
feai archive reset-state --change-name <change-name> --title "<需求名>" --json
# 确认后才使用 --apply 写入
feai archive reset-state --change-name <change-name> --title "<需求名>" --apply --json
```

必须达成：

- `openspec/plan.md`、`proposal.md`、`spec.md` 重置为带“上一需求归档于 YYYY-MM-DD：需求名”指纹的占位语。
- `.workflow/runtime/current-task.summary.md` 回到 idle 模板，或在模板缺失时删除。
- `current_state.md` 如存在旧版“当前进行中”“历史归档”“上一个需求”会话/历史段，删除或迁移到本次归档单文件；仅在项目地图确有变化时做段落级最小更新。

禁止删除 `openspec/specs/**`、`openspec/config.yaml` 或历史归档文件。

### 阶段 8：门禁与输出

对照 `.workflow/checklists/gate-archive.md` 输出结论：通过 / 打回 / 有条件通过。

最终摘要格式：

```text
## ✅ 归档完成

变更名: <change-name>
归档位置: <base>/openspec/changes/YYYY-MM-DD-<change-name>.md

归档清单:
├── 任务完成: X/Y
├── 经验沉淀: 已完成 / 本次未涉及
├── 文档同步: 已更新 / 无需更新 / 项目无 docs/
├── Delta Spec: 已同步 / 跳过 / 无
├── 状态清理: plan/proposal/spec/runtime 已重置，current_state 项目地图已检查
├── localUsageAudit: totalTokens=... / null
├── 评分上报: 已发出 / 已禁用 / 跳过
└── 门禁: gate-archive 通过 / 打回 / 有条件通过
```

---

## 失败处理

| 失败点 | 处理 |
|---|---|
| plan 不存在或无任务 | 停下，请先运行 `/feai-start` 或恢复 plan。 |
| 未完成任务 | 输出卡片，等待继续归档、暂停、或标记完成的明确选择。 |
| `change-name` 非 kebab-case | 停下，要求修正分支或显式传入合法变更名。 |
| 归档单文件未生成 | 禁止状态清理，回到归档阶段 4。 |
| payload 自检失败 | 跳过上报，保留 payload 文件和错误原因，继续归档。 |
| 状态清理失败 | 打回，禁止宣称归档完成。 |
| archive gate 打回 | 修正对应产物或说明有条件通过的剩余风险。 |

---

## 何时必须归档

| 变更类型 | 建议 |
|---|---|
| 新功能 / 新模块 | 必须归档 |
| 重构 / 行为优化 | 必须归档 |
| Bug 修复 | 推荐归档，尤其涉及业务规则变化时 |
| 文档 / 配置调整 | 可选 |
| 紧急 hotfix | 可先上线，稳定后补归档 |

归档不是流水账；它是下次 AI 开发能复用的项目记忆。
