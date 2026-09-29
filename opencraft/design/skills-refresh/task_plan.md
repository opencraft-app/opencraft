# Skills 目录刷新：第一纵向实现

## goal
已有会话能在执行边界发现安装后的 Skill；DSH 是首个适配，不是公共模型。

## non_goals
- 用户已取消正文版本更新和 Hermes 自动热刷新；不修改 Hermes 或 ref，不继续阶段 B/D/E。
- 仍不自动做托管 update、OAuth、版本快照、提交/推送或覆盖用户安装；ref 保持只读。

## requirement_refs / requirement_excerpt
- 用户：“DSH 只是其中一个引擎”“似乎可以开始落地了”。
- 目标与验收：`../../docs/session-capability-refresh.md` 第 7.1 节。

## interface_refs / data_structure_refs
- AppServer `skills/list` / `skills/changed` 与既有安装作用域不变。
- DSH 私有 Provider/invalidate/pre-step 留在 local-agent-host；Hermes 保留 Profile action 协议。

## history_context
- current_design_refs：`../../docs/session-capability-refresh.md`、`../../docs/platform-architecture.md`。
- relevant_evolution：R2 明确贡献、刷新边界和分级保证；第二引擎边界先复核再实现。
- superseded_refs：不采用通用 DSH scope、万能能力管理器。

## phases
- [x] 对照 DSH 与 Hermes 的现有契约、作用域与刷新入口。
- [x] 真实 DSH 合成模型回归：创建会话、安装、下一步骤读取。
- [x] Provider composition、直接失效、外部编辑对账和 UI 通知。
- [x] 聚焦测试、类型/边界、运行时 smoke、文档门禁与最终走查。

## affected_paths
- `apps/local-agent-host/src/` 中 Skills 装配、Host mutation 与私有连接。
- `tests/`、`scripts/` 的聚焦回归；正式设计和任务文件。

## acceptance / validation
- 先失败后通过的真实 DSH 模型请求证据；不使用真实凭据或付费模型。
- 同名覆盖、隔离 cwd、失效失败、冷恢复、UI 通知与处置测试。
- local-agent-host typecheck、DSH 聚焦测试、check:boundaries、文档门禁。

## required_context / context_receipt
- 已读根规则、`opencraft/AGENTS.md`、OpenCraft maintenance Skill 及 verification。
- Router must_read：agent-gateway-runtime、site-environment-routing、upstream-subtrees、services/opencraft；首次泛化查询误命中 services/ctl，已读并以路径路由纠正。
- 平台架构、刷新 R2 文档；DSH/Hermes protocol 与 native registry/provider 源码。
- 使用 trace 与 planning-with-files，实施状态保留在本目录。

## decisions
- 先证明作用域与刷新缺口，原生已覆盖的逻辑不复制。
- 不以修改公共协议适配 DSH，不将原生加载回执搬到 Host。

## risks
- 已有 dirty Host/恢复修复必须保留；参考源码只读。
- Provider 层级优先于 rank，不能把 global 注册误当同层覆盖。

## evidence / scan_scope / scan_output
- 精确搜索 Host Skills 入口、Hermes Profile handler、原生 filesystem/scope 注册；结论见 findings.md。
- 查询曾遇不存在的构建脚本及 zsh 空 glob；后续使用 rg --files 定位，不重试猜测路径。

## handoff / checkpoint
- stage：首个纵向切片完成，源码与隔离 Engine 证据已交接。
- verified：224 项 DSH 回归；23 项 Hermes/Workbench/刷新聚焦回归；Local Host 类型、平台边界；真实 DSH 模块闭包与模型请求 smoke。
- unverified：扫描故障/压缩/漏通知/大目录压力专项；外部市场点击下载及人工键盘未在本次合成验收中覆盖。不把已取消功能列为待验收。
- next_action：本轮收尾已完成，等待用户后续指令；不自动提交/推送/发布。

## 已取消范围：Hermes 热刷新与正文版本更新

- 用户曾要求包含两项；核对参考后已明确取消，两项均不再实施。
- 当前只读核验：`ref/hermes-agent/tui_gateway/methods_tools.py` 的 `skills.reload` 使用 `_rpc` 而非 `_scoped_rpc`，调用 `agent.skill_commands.reload_skills()` 后仅返回 added/removed/output；未对目标 Session 发布上下文更新。
- `agent/skill_commands.py` 的 diff 只比较名称集合；`cli_info_mixin.py` 的 pending note 是 CLI 下一消息机制，不能据此推定 TUI Gateway RPC 等价支持。
- 保留上述调查作为决定依据，不等待其他仓库、不拼接隐藏消息、不实施正文失效账本。

## 收尾切片

- [x] 外部 DSH 安装后继续聊天的真实 Host 协议负例先失败、修复后通过。
- [x] refresh port 显式可选；unsupported 不创建 pending，暂时失败保留重试。
- [x] 文档移除取消功能的实施承诺。
- [x] 隔离模型、Skills 根与 user-data-dir 的真实 Electron 验收（AppHost 安装 + 界面续聊，CDP 焦点模拟）。
