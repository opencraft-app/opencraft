# `/feai-context-doctor` — 上下文预算体检

> 目标：诊断 native 上下文布局的 token 健康状态——AGENTS.md（项目上下文 + 恢复块）、`.workflow/project.yaml`（索引级事实）、`team-conventions.md`（团队约定）、active change 的 `brief.md` / `report.md`（任务级过程稿）与 command 入口文档，避免把 target 目标线误用成硬阻断线。

## 使用

```bash
node <tool-root>/scripts/context-doctor.mjs
node <tool-root>/scripts/context-doctor.mjs --json
node <tool-root>/scripts/context-doctor.mjs --root <项目根>
```

## 判定

- `PASS`：在 target 内。
- `NOTICE`：超过 target，但未到 warn；不需要专门压缩。
- `WARN`：超过 warn；建议精简长段落、减少默认读取。
- `FAIL`：超过 fail；先压缩 / 拆分再继续。

默认阈值来自 `.workflow/project.yaml` 的 `workflow.context_budget`（键：`agents_md` / `project_yaml` / `team_conventions` / `brief_md` / `report_md` / `command_doc`），缺失时使用工具内置默认值。

## 约束

- 只读检查，不写文件。
- AGENTS.md（固定入口）、project.yaml（索引级事实）、team-conventions.md（按需加载的团队约定）、change 过程稿、command 文档分开检查，避免为过程稿波动反复压缩固定入口。
- `commands/feai-*.md` 按短入口预算检查，防止重新膨胀为实现手册。

## Active change 健康度

- `.workflow/native/current.json` 损坏或指向不存在的 change 目录 → `WARN`；运行 `feai native status --json` 让引擎自愈/核对状态。
- active change 缺 `brief.md` → `WARN`（shape 阶段契约文件缺失）。
- `state.yaml` 已进入 `verify` / `archive` 但缺 `report.md` → `WARN`（验证证据缺失，verify pass 前必须补齐）。
- 无 active change 时上述检查跳过（`PASS`）。

> 体检只读、不改文件；`.workflow/native/` 下的状态一律通过 `feai native <cmd>` 修复，禁止手写。
