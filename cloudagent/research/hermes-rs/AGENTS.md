# AGENTS.md

## Hermes-RS 项目 Context

- 当前 release line：`0.1.3`
- Runtime config 以 TOML 为先，并通过 `crates/hermes-core/src/config.rs` 共享
- 富 CLI/TUI 使用 `ratatui`，位于 `crates/hermes-cli/src/tui/`
- Autonomous coding mode 位于 `crates/hermes-cli/src/autonomous.rs`，通过 `hermes autonomous` 或 `hermes run --autonomous` 启动
- 仓库根 `TODO.md` 是 autonomous mode 的任务台账；autonomous 行为改变时保持 `Implemented`、`Pending` 准确
- Autonomous runtime 写入仓库本地 `autonomous-status.toml` 状态，并跨重启重新加载重复失败暂停状态；变更 autonomous 行为时保持该 workflow 有文档记录
- Workspace 视图包含 `Conversation`、`Reasoning`、`Activity` 及管理 `MCP`、`Skills`、`Behavior` 的面板
- config field 变更时，在同一变更更新仓库根 `hermes.example.toml`
- 用户可见行为变更时更新 `README.md`、`CHANGELOG.md`；UI 有实质改变时更新 `assets/` screenshot
- 从 `CHANGELOG.md` 创建 tag release：push `vX.Y.Z`，随后 GitHub Actions 构建 artifact，并从匹配 changelog section 发布 GitHub Release
- 建议验证命令：
  - `cargo fmt --all`
  - `cargo check --workspace`
  - `cargo test --workspace`
  - `cargo clippy --workspace --all-targets --all-features -- -D warnings`

## CloudAgent Runtime 边界规则

- CI trigger note 2026-07-04：tool-call argument validation 进入 master 后重建 runtime artifact。
- `crates/hermes-sidecar/src/main.rs` 是 entrypoint 与 daemon coordinator。不得在此加入新的 session、protocol、stage-files、runtime-host 或 client 行为；应放入 `client.rs`、`http.rs`、`session_api.rs`、`event_projection.rs`、`stage_files.rs` 或 `config_bootstrap.rs` 等语义 module。
- `crates/hermes-core/src/runtime/mod.rs` 是 runtime facade。actor、inbox、pump、cancellation、persistence、executor 细节应放在专用 `runtime/*` module，只 re-export 有意公开的 API。
- `crates/hermes-core/src/tools/mod.rs` 是 tool facade。schema/context/provider/router/registry/lifecycle/gate 关注点必须分至专用 `tools/*` module。
- Runtime 拥有 scheduling、transcript、run ledger、tool delegation 和 runtime-host lifecycle 事实。ACP/OpenAI/MyChat 与 gateway 代码必须保持 adapter 或 read projection。
- Rust module 目标低于 500 LoC。高频触及文件超过约 800 LoC 时，除非有文档化理由，否则在新语义 module 添加行为。
- Public runtime API 应从 facade module 显式 re-export；除非真实 cross-crate contract 要求，否则 implementation module 保持 private 或 `pub(crate)`。

以下行为指引用于减少常见 LLM 编码错误；按需与项目专属指令合并。

**权衡：**这些指引偏向谨慎而非速度；简单任务可自行判断。

## 1. 编码前先思考

**不臆测，不隐藏困惑，明确权衡。**

实现前：
- 明确陈述假设；不确定就提问。
- 有多个解释时列出它们，不要静默选择。
- 有更简单方案时说明；必要时提出异议。
- 有不清楚之处就停止，指出困惑点并提问。

## 2. 简单优先

**用解决问题的最少代码，不做推测性工作。**

- 不做请求之外的 feature。
- 不为一次性代码抽象。
- 不加入未请求的“flexibility”或“configurability”。
- 不处理不可能发生的错误场景。
- 写了 200 行但 50 行可完成时，重写。

问自己：“资深工程师会说这过度复杂吗？”若是，简化。

## 3. 外科式变更

**只触及必要内容，只清理自己造成的问题。**

编辑既有代码时：
- 不“改进”相邻代码、注释或格式。
- 不重构未损坏内容。
- 即使自己会有不同做法，也匹配既有风格。
- 发现无关 dead code 时说明，不要删除。

自身变更产生 orphan 时：
- 移除因自身变更变为未使用的 import/variable/function。
- 未被要求时不移除原有 dead code。

检验标准：每一处变更都能直接追溯到用户请求。

## 4. 目标驱动执行

**定义成功标准，循环至验证完成。**

将任务转为可验证目标：
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

强成功标准允许独立迭代；弱标准（“让它工作”）需要不断澄清。

---

**这些指引生效的表现：**diff 中不必要变更更少、因过度复杂的重写更少，且澄清问题出现在实现前而不是出错后。
