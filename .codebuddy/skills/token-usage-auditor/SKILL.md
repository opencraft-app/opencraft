---
name: token-usage-auditor
description: "FE-AI 内置的轻量本地用量审计。仅用于归档流程（feai native archive，用户确认归档后）生成 metadata.localUsageAudit，按 usage-context.provider 统计当前需求窗口内当前 agent 工具的 token、缓存命中率、积分和费用。不要把它当作完整多工具 HTML 报告 CLI；完整报告请使用 token-usage-auditor 独立仓库。"
---

# FE-AI Local Usage Auditor

这个 skill 是 FE-AI 分发包里的轻量版 token auditor，只服务归档流程
（`feai native archive`，用户确认归档后执行）的 `metadata.localUsageAudit`。
它不会生成 HTML 报告，也不会做全工具对比。

## 入口

优先使用 FE-AI 专用入口：

```bash
python3 <skill-dir>/scripts/feai-local-usage-audit \
  --feai-project "$BASE_DIR" \
  --feai-change "$CHANGE_NAME"
```

不支持 `all --since 7d`、`--html`、`--timeline`、`--by-session` 等完整 auditor 参数。
排障时可通过 FE-AI CLI 使用 `feai report doctor --project "$BASE_DIR" --change-name "$CHANGE_NAME" --json`，
它复用同一套 provider reader，默认只输出可转发的精简摘要，不写入 `localUsageAudit.json`。
需要本机深度排障时追加 `--verbose`，此时会输出 session/window/notes 等完整诊断字段。
归档流程发现审计缺失、失败、为 0 或 fallback 时会自动在本地缓存目录写入完整
`localUsageDoctor.json`；评分上报只携带其中的安全摘要字段。

## 统计口径

输入来源：

- `<project>/.codebuddy/.cache/metrics/<change-name>/timeline.log`：推导需求窗口。
- `<project>/.codebuddy/.cache/metrics/<change-name>/usage-context.json`：读取
  `provider/projectRoot/sessionIds/window`，其中 `provider` 用于自动区分当前 agent 工具。
- 手动执行时显式传入的 `--from-time` / `--to-time`：作为精确审计窗口。
- 本机当前 provider 的 usage 日志：读取实际 token、缓存、积分字段。

provider 必须来自命令行参数或 `usage-context.provider`，不做默认猜测。FE-AI
工作流应在 `/feai-start` 阶段由 AI 判断当前运行工具；无法确认时通过对话让用户选择，并把结果写入
`usage-context.provider`。如果历史需求或旧流程漏写/写入非法 provider，归档流程应二次确认并写回
`usage-context.provider` 后再审计；`.codebuddy/project.local.json` 的 `aiUsage.provider` 只作为询问时的默认建议。当前
slim 版支持：

- `codex`
- `codebuddy`
- `codebuddycode`
- `codebuddy-vscode`
- `claudecode-internal`
- `gemini`
- `opencode`

它不会扫描 `all`，也不会混入其他工具。未来接入新 agent 工具时，先在完整
`token-usage-auditor` 主仓库实现并验证，再移植对应的轻量 reader，并用 parity
脚本确认 slim 与完整 FE-AI 模式一致。

如果 provider 仍未确认，归档流程应先阻断并让用户确认；用户明确选择暂不统计时，
`metadata.localUsageAudit` 才保持 `null`，避免把未知工具误算成 `codebuddycode`。

session id 可由运行平台注入，也可由开发者显式设置 `FEAI_USAGE_SESSION_ID`；存在
session id 时优先按 session 过滤，缺失时仅按 provider + FE-AI window（以及少数
provider 的 projectRoot）聚合。`codebuddycode` 支持项目级日志收窄；如果已记录的
session id 在当前窗口内没有命中，但同一 `projectRoot + window` 下存在其他记录，审计会降级为
项目窗口统计、清空输出中的 `sessionIds`、将 confidence 降为 `medium`，并在 notes 中记录
session fallback。手动通过 CLI `--session-id` 显式指定的 session 仍保持严格过滤，不触发 fallback。
这类 fallback 会触发自动 doctor；上报摘要只包含 `diagnosis/auditStatus/provider/projectScoped/confidence/evidence`
计数字段，不包含 sessionId、窗口时间、本地路径、notes 或 suggestions。

> **注意**：slim 版只读当前 provider 对应的本地 usage 日志（JSONL / JSON / SQLite），
> 不读 trace 文件（如 `~/.codebuddy/traces/` 下的 `trace_*.json`）。这是正确行为——
> trace 文件与更细粒度 usage 记录通常是同一批 API 调用的聚合视图，同时读取两者会导致重复计算。

`localUsageAudit` 是本地工具日志审计结果，不是 `timeline.log` 的
`tokenIn/tokenOut` 阶段埋点。不要把它混入
`metadata.efficiency.totalTokenIn/totalTokenOut`。

## 输出

输出是可直接塞进上报 payload 的 JSON：

```json
{
  "schemaVersion": 1,
  "source": "token-usage-auditor",
  "scope": "feai-requirement",
  "confidence": "medium",
  "provider": "codebuddycode",
  "totals": {
    "inputTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "outputTokens": 0,
    "totalTokens": 0,
    "cacheHitRatePercent": null,
    "credit": null,
    "cnyCost": null
  }
}
```

confidence 口径：

- `high`：有 `provider + projectRoot + sessionIds + feai window`
- `medium`：有 `provider + projectRoot + feai window`，且当前 provider 支持项目级日志收窄（目前为 `codebuddycode`）
- `low`：只有 provider / 时间窗等弱约束

注意：`codebuddy`、`codex`、`codebuddy-vscode`、`claudecode-internal`、`gemini`、
`opencode` 的本机日志目前不能仅凭 `projectRoot` 做可靠收窄；缺少 `sessionIds`
时必须按 `low` 处理。

## 更新机制

用户项目通过 `feai update` 获取本 skill 的更新。维护者更新流程是：

`token-usage-auditor` 主仓库更新 FE-AI 口径 → 移植到
`feai_local_usage.py` → 运行 `scripts/check-token-auditor-slim-parity.sh` →
发布 FE-AI → 用户 `feai update`。

## 隐私边界

轻量版只输出聚合 token、缓存、积分、时间窗、provider、`projectScoped` 布尔值和
session id，不输出本机 `projectRoot` 绝对路径、prompt、response、文件内容或工具调用参数。
