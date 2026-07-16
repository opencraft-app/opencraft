# `/feai-context-doctor` — 上下文预算体检

> 目标：诊断 P0-Min、AGENTS、global、runtime summary、command 入口文档和 plan 的 token 健康状态，避免把 target 目标线误用成硬阻断线。

## 使用

```bash
node <tool-root>/scripts/context-doctor.mjs
node <tool-root>/scripts/context-doctor.mjs --json
node <tool-root>/scripts/context-doctor.mjs --size L
```

## 判定

- `PASS`：在 target 内。
- `NOTICE`：超过 target，但未到 warn；不需要专门压缩。
- `WARN`：超过 warn；建议拆 plan、摘要长段落、减少默认读取。
- `FAIL`：超过 fail；先 compact / summary / plan 拆分，再进入严格流程。

默认阈值来自 `.workflow/project.yaml` 的 `workflow.context_budget`，缺失时使用工具内置默认值。

## 约束

- 只读检查，不写文件。
- `openspec/plan.md` 按 S/M/L 单独预算。
- P0 总量、P0-Min(runtime)、固定入口、command 文档分开检查，避免为了 plan 波动反复压缩 AGENTS 或命令入口。
- `commands/feai-*.md` 按短入口预算检查，防止重新膨胀为实现手册。

## Summary 新鲜度体检（实现阶段）

实现阶段 P0-Min 默认读 `.workflow/runtime/current-task.summary.md`，故一并体检其新鲜度：

- **存在性**：缺失 → 提示按 `context-recovery.md` 从 `current-task.summary.template.md` 初始化。
- **planHash 一致性**：`planHash` 使用当前 `openspec/plan.md` 原始内容的 SHA-256 十六进制值（也接受 `sha256:<hex>` 记录形式）；不一致 → `WARN`，需读完整 plan 校准后刷新（范围裁决以 plan 为准）。
- **branch 一致性**：summary 的 `branch` 与当前 `git rev-parse --abbrev-ref HEAD` 不一致 → `WARN`。
- **预算**：summary 目标 `<= 1500 tokens`；超出 → 提示只保留 active slice + 当前批次 ≤ 3 任务。
- **status**：`active` 但 plan 全部 `[x]`，或 `idle` 但存在未完成任务 → 提示刷新。

> 体检只读、不改文件；发现不一致时给出修复指引，由 `/feai-start` / `/feai-review` 刷新。
