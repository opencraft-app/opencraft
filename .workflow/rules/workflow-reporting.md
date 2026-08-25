# Workflow Reporting Rules（用量审计唯一权威入口）

> `/feai-*` 命令的本地用量审计（localUsageAudit）细则。仅在命令实现、review、archive、排障或工作流优化时读取。

## usage-context 写入

`/feai-start` 和 `/feai-review` 在执行过程中，如运行平台能提供真实 session id，写入 `.codebuddy/.cache/metrics/<change-name>/usage-context.json`，供 `/feai-archive` 做需求级 localUsageAudit。该 metrics 文件是唯一长期读写源；CLI 自行计算 canonical 路径，禁止把项目根目录作为 `--metrics-dir`。`usage-context.window` 是本地审计的稳定窗口来源：首次确认 provider 时写入 `window.start`，归档审计前刷新 `window.end`。已有 context 缺少 start 时仅允许从 `timeline.log` 恢复，否则保留现场并失败，不会用当前时间覆盖。`codebuddycode` 若出现 session id 与窗口不匹配但项目窗口内存在记录，审计可降级为 `projectRoot + window` 统计，并把 confidence 降为 `medium`。

- 分支未确定前，metrics 临时事件和 usage-context 只写 resolver 固定的 `$PENDING_DIR`；不得传入其他 `--metrics-dir`。分支确定后统一调用 `feai workflow metrics merge` 按 JSON 字段归位，再继续写 canonical change 目录，禁止文本 append。
- 项目根目录已有 `usage-context.json` 时完全忽略：不读取、不迁移、不删除、不作为 fallback，由用户自行清理。
- `<change-name>` 提取公式（与 feai-start / feai-review / feai-archive 完全一致，兼容用户名含连字符）：

本地用量审计由 token-usage-auditor 读取本机工具日志，写入 `metadata.localUsageAudit`。每个新需求都要由 AI 根据当前系统上下文重新确定运行工具，但确定 provider 不等于询问用户：CodeBuddy Code CLI / VS Code CodeBuddy 插件 / CodeBuddy Web/IDE 分别直接使用 `codebuddycode` / `codebuddy-vscode` / `codebuddy`；其他已知宿主直接使用对应 provider。仅当系统上下文确实无法判断当前宿主时才询问一次。禁止根据 session 环境变量或 `project.local.json` 的 `aiUsage.provider` 静默选择 provider；后者只作询问建议。用户明确选择暂不统计时才设置 `USAGE_PROVIDER_SKIP=1`。

## 二、初始化片段

```bash
feai workflow metrics merge --project-base <projectRoot> --json
feai workflow usage-context write --provider <provider> --project-base <projectRoot> --json
```

`<projectRoot>` 必须是项目根目录绝对路径，不是 Git base 分支名；CLI 会校验其与仓库配置的真实项目根完全一致。

`metrics merge` 与 `usage-context write` 缺省即用分支推断的 `change-name`（与归档端 `changeNameFromBranch` 同一真值来源），**禁止手传完整分支名**——手传会让写入端目录与归档端推断名分裂，导致 localUsageAudit 读不到窗口。确需覆盖才显式传 `--change-name`；与分支推断不一致时脚本输出 `changeNameWarning` 非阻断告警，归档端仍以分支推断值为准。

## 三、事件目录

provider 未确认属于前置门禁，`/feai-start` 会 `exit 1` 阻断，要求 AI 先完成确认或设置 `USAGE_PROVIDER_SKIP=1`；确认后的文件写入失败才使用 `2>/dev/null || true` 兜底，不阻塞主流程。canonical 或 `.pending` usage-context JSON 非法时必须显式报错并保留文件现场，不得静默覆盖。localUsageAudit 在 `/feai-archive` 阶段调用 token-usage-auditor，审计失败时降级为 `null`。如 `usage-context.window.start` 和 `timeline.log` 都缺失，错误码应明确为 `missing_usage_window`。archive pipeline 的 `ok` 只表示评分 payload/归档流程成功；token 是否真实统计必须读取 `tokenReported` 与 `usageStatus`，其中 `unavailable` 不阻断评分提交，`skipped` 仅表示用户显式选择暂不统计。
