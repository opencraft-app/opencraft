# `/feai-start` — 启动或恢复需求

> 前端 AI 编程工具的短入口命令。它只负责加载最小上下文、判断当前状态、生成规划产物并停在用户确认点；细则和确定性公式交给 `.workflow/rules/` 与 `feai workflow` 脚本。

---

## 命令格式

```bash
/feai-start [--quick | --full] [--yes] <需求描述 | TAPD 链接 | Story ID>
```

| 参数 | 说明 |
|---|---|
| `--quick` | S 级快速修复。保留 git / plan / 最小验证门禁，跳过 Figma、多 Agent、完整 proposal/spec。 |
| `--full` | L 级完整流程。优先启用完整 proposal/spec、关键门禁和多 Agent 建议。 |
| `--yes` | 信任模式。减少低风险确认，但不跳过需求确认、工作区/分支/plan 状态决策点。 |

---

## 空启动

如果用户只输入 `/feai-start`，没有需求描述、单号、目标文件或问题线索：

1. 不读取 P0-Min。
2. 不读取 `openspec/plan.md`、`.workflow/project.yaml` 或 `.workflow/rules/**`。
3. 只询问：本次需求是什么、是否有关联单号、是否已有目标文件/范围。
4. 等用户补充后再进入正式启动。

---

## 正式启动流程

### 阶段 0：版本检查（静默，不阻塞）

```bash
feai workflow version-check --base <base> --json
```

`needsUpgrade=true` 时提示当前版本、最新版本和 `feai update`；询问用户是否先升级。命令失败、npm 不可用或远端查询失败时静默继续，不阻塞需求启动。

以下编号只描述流程结构，不要求运行时逐步输出。连续机械动作聚合执行；仅在耗时进度、阻塞决策和最终结果时沟通。`--quick` 仍执行自己的必选门禁。

### 阶段 1：最小上下文加载

读取 P0-Min：

- `AGENTS.md`
- `.workflow/rules/global.md`
- `.workflow/runtime/current-task.summary.md`（实现阶段恢复；缺失时按 `context-recovery.md` 从模板初始化）

按需读取：

- `.workflow/project.yaml`：需要项目配置、插件、规模策略、capability 时。
- `openspec/plan.md`：规划阶段或 summary 失效时。
- `.workflow/rules/flow-cost.md`、`context-recovery.md`、`agent-dispatch.md`、`workflow-reporting.md`：命中对应场景时。

### 阶段 2：工作区与 plan 状态判定

使用聚合检查，不在主上下文逐条展开 projectRoot、git、plan 和 change-name 公式：

```bash
feai workflow start-inspect --json
```

plan 状态处理：

| 状态 | 含义 | 行为 |
|---|---|---|
| A | 文件不存在、已归档占位语、或空 plan | 可启动新需求；若空 plan 需提示可能被人为清空。 |
| B | 所有任务已完成但未归档 | 输出 `.workflow/cards/feai-start.md` 的 B 卡片并等待用户选择。 |
| C | 存在未完成任务 | 输出 `.workflow/cards/feai-start.md` 的 C 卡片并等待用户选择。 |

未提交改动只提示并停下等待用户处理；禁止自动 stash、自动 commit、自动回退。

### 阶段 3：需求获取

- TAPD 链接 / Story ID：调用 `tapd-requirement-fetch` skill，并按 `ai-usage-tracking` skill 自动补 FE-AI 标签。
- 文字描述：直接进入需求澄清。
- 已有目标文件或报错线索：先做轻量只读定位，避免全仓扫描。

### 阶段 4：需求澄清

默认使用 `brainstorming` skill 明确：

> ⚠️ **产物路径覆盖**：brainstorming skill v6+ 默认保存到 `docs/superpowers/specs/`，feai 工作流必须保存到 `openspec/`（proposal.md / spec.md），不使用 skill 默认路径。

- 目标
- 成功标准
- 范围与非目标
- 约束
- 验证口径
- 英文 kebab-case slug

`--quick` 可简化为一次确认，但仍必须得到上述最小信息。

S 级 plan 只允许 1–3 条任务级 checkbox；RED/GREEN、读取文件、运行测试、提交等执行步骤写在任务正文中，不得各自展开为 checkbox。一个小 bug 不得生成十几到几十条 pending 项。

### 阶段 5：规模与执行模式

按用户参数和实际影响范围判定 S/M/L：

| 规模 | 默认产物 | 默认执行 |
|---|---|---|
| S | `plan.md` | 单 Agent，`/feai-review --quick`，`/feai-archive --light` |
| M | `proposal.md` + `spec.md` + `plan.md` | 单 Agent 或轻量 Leader，最终 review 可 full |
| L | `proposal.md` + `spec.md` + `plan.md` | 建议 Leader 调度，多 Agent 串行交接 |

规模升级条件：高风险、影响文件 > 5、连续失败 >= 2、用户显式要求完整流程。

### 阶段 6：分支与 metrics 归位

先检查工作区干净，再创建或沿用规范分支。分支名格式：

```text
^(feat|fix|feature|hotfix|chore)/[a-z0-9-]+-(?:0[1-9]|1[0-2])[0-3][0-9]-[a-z0-9-]+$
```

> `(?:0[1-9]|1[0-2])[0-3][0-9]` 是 **MMDD 日期**（如 `0714`），不是序号。禁止生成 `feat/task-0001-xxx` 这种序号分支。

`change-name`、pending metrics 合并和 usage-context 写入由脚本处理：

```bash
feai workflow change-name --json
feai workflow metrics merge --base <base> --change-name <change-name> --json
feai workflow usage-context write --provider <provider> --change-name <change-name> --project-base <base> --json
```

| 当前宿主 | provider |
|---|---|
| CodeBuddy Code CLI | `codebuddycode` |
| VS Code CodeBuddy 插件 | `codebuddy-vscode` |
| CodeBuddy Web/IDE | `codebuddy` |
| Codex / Claude Code 内部版 / Gemini / OpenCode | `codex` / `claudecode-internal` / `gemini` / `opencode` |

每个需求都要为新的 change 重新确定 provider，但“CodeBuddy 存在三个 provider”不是询问理由。系统上下文已明确宿主时直接传 `--provider`，禁止再次弹选择框；确实无法判断时才询问一次。用户未明确选择暂不统计时，禁止设置 `USAGE_PROVIDER_SKIP=1`。项目默认和 session 环境变量不参与 provider 自动选择。

未确认或写入非法 provider 时脚本会 `exit 1` 阻断。CLI 会自行计算 `.codebuddy/.cache/metrics/<change-name>/usage-context.json`，禁止把项目根目录作为 `--metrics-dir`。首次写入会初始化 `usage-context.window.start`，供归档阶段在没有 `timeline.log` 时仍能审计当前需求窗口。

命名漂移只做非阻断提示；业务正确性以 plan、代码和门禁为准。

### 阶段 7：条件能力分析

- Figma URL 或 UI 还原需求：派发 `figma-analyzer` sub-agent，主上下文只接收摘要和产物路径。
- 只读调查 / 追问反证：按 `.workflow/rules/agent-dispatch.md` 生成 Investigation Brief，提供候选范围和成本检查点；证据不足时允许扩展。
- 多 Agent 写入前：读取 `.workflow/rules/team-state.md`，声明文件归属和共享状态单写者。

`--quick` 默认不进入 Figma、多 Agent 和完整调查，除非用户明确要求或风险升级。

### 阶段 8：生成 OpenSpec 并等待确认

调用 `writing-plans` skill：

> ⚠️ **产物路径覆盖**：writing-plans skill v6+ 默认保存到 `docs/superpowers/plans/`，feai 工作流必须保存到 `openspec/`，不使用 skill 默认路径。

- S：生成 `openspec/plan.md`
- M/L：生成 `openspec/proposal.md`、`openspec/spec.md`、`openspec/plan.md`

生成后检查 `grep -c "^- \\[ \\]" <base>/openspec/plan.md`，确保至少 1 条未完成任务。

如涉及 Figma，plan 顶部必须包含上下文产物索引。对照 `.workflow/checklists/gate-planning.md` 输出门禁结论，然后等待用户确认；确认前禁止进入编码。

确认后刷新 `.workflow/runtime/current-task.summary.md`，只写 active slice（当前批次 ≤ 3 个任务）、planHash、branch 和下一步。

用户确认 plan 后按 `context-recovery.md` 判断是否交接；长上下文或适合独立交接时使用 CodeBuddy 新 session，S 级短任务可留在当前会话。

---

## 规划完成输出

```text
📌 需求开启清单
├── 上下文：P0-Min 已加载，按需规则已读取
├── 状态：plan={A/B/C}，git status 已检查
├── 需求：{TAPD / 文字描述}
├── 分支：{branch}
├── 规模：{S/M/L}
├── 模式：{单 Agent / Leader 调度}
├── OpenSpec：{产物列表}
└── 门禁：gate-planning {通过/打回/有条件通过}，等待用户确认
```

---

## 执行后续

用户确认 plan 后：

1. TDD / executing-plans 分批实现，每批 ≤ 3 个任务；CodeBuddy 阶段 runner 只执行 implementation，不自行进入 review。
2. 实际方案偏离 plan 时，用 `feai workflow deviation add ... --apply --json` 记录 task/from/to/reason，不从聊天历史猜测。
3. 每批完成后运行 `/feai-review`，通过后逐项标记任务并刷新 runtime summary。
4. 最后一批 review 通过后输出验收摘要，等待用户确认验收；确认前禁止自动 commit、push、MR/CR 或最终归档。
5. 用户明确要求归档后运行 `/feai-archive`，归档产物与代码保持同一交付批次。
6. 用户明确要求提交、push、MR、CR 后，再按 `AGENTS.md`、`.workflow/rules/global.md` 和团队 skills 执行。

---

## 失败处理

| 失败点 | 处理 |
|---|---|
| P0-Min 缺失 | 提示运行 `feai install/update` 或按模板补齐。 |
| plan 状态 B/C | 输出卡片并等待用户选择。 |
| 工作区不干净 | 停下，请用户提交、stash、放弃或取消。 |
| 分支不规范 | 提示重命名或切回主分支重建；禁止静默 fallback。 |
| skill 缺失 | 只在本次需要该 skill 时安装或提示手动处理。 |
| plan 无任务 | 回到需求澄清或 writing-plans 修正。 |
| 门禁打回 | 回到对应步骤修正。 |
