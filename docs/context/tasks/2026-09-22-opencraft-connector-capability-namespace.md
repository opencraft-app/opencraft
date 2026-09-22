## goal

将 Connector 模型工具收敛为唯一 `connectors` Capability Namespace，删除旧的全局 `connectors_*` 工具和 list 兼容入口，恢复 Codex/DSH 的 Thread 创建与能力租约不变量。

## non_goals

- 不在 Codex Adapter 删除 `deferLoading` 或自动补 namespace。
- 不兼容旧全局工具名。
- 不改变 ConnectorRuntime 的选择、授权、handle、审批或执行语义。
- 不提交、推送、上传、公开发布或提交 Apple 公证。根据上一轮“更新 application”授权，验证后更新本机 `/Applications/OpenCraft.app`。

## requirement_refs

- `user-2026-09-22-connector-namespace`：“肯定是所有权/建模错误”、“干净的整改。不需要兼容现有名称”。
- 现场错误：`deferred dynamic tool must include a namespace: connectors_search_tools`。

## context_receipt

- 根/OpenCraft AGENTS 与 Context Router（无匹配 Pack）。
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` 及验证清单。
- `opencraft/docs/platform-architecture.md`、`opencraft/docs/platform-connectors.md`、`opencraft/design/connector-tool-discovery.md`。
- `ref/codex`：deferred tool 放入 namespace；本机 Codex CLI 0.155.1 含硬校验。
- `ref/wb`：MCP 工具保留 MCP/Connector 所有者边界，以 `mcp_get_tool_description`/`mcp_call_tool` meta tool 和 `mcp__server__tool` 物理身份投影；不把产品连接器目录摊平为无所有者全局函数。

## acceptance

- AppServer 声明仅有 `connectors` namespace，内含 `search_tools`、`get_tool`、`call_tool`，三者均保持 `deferLoading`。
- Handler 只路由 `namespace === "connectors"`，旧的 null namespace/全局名不可用。
- DSH capability identity 为 `connectors.search_tools` / `connectors.get_tool` / `connectors.call_tool`，模型层由 DSH Adapter 明确投影为 `connectors__search_tools` / `connectors__get_tool` / `connectors__call_tool`；`call_tool` 保持 150 秒 Host 审批期限。
- 真实 Codex CLI `thread/start` 携带完整 Workbench dynamic tools 可创建 Thread，不再报 namespace 错误。
- Connector search -> detail -> call、scope/revocation 与 DSH registration 回归通过。
- 新的 Developer ID arm64 包安装后，`/Applications/OpenCraft.app` 启动且包内 buildId 对应本轮修复。

## affected_paths

- `opencraft/packages/workbench-runtime/src/connectors/dynamic-tools.ts`
- `opencraft/apps/local-agent-host/src/dsh-capability-broker.ts`
- `opencraft/scripts/smoke-codex-engine.ts`
- Connector/terminal/DSH tests
- `opencraft/docs/platform-connectors.md`
- `opencraft/design/connector-tool-discovery.md`

## handoff

- 完成：Connector 能力只有 `connectors` namespace 一个 owner，内部仅 `search_tools/get_tool/call_tool`；旧全局名和 list 别名已从源码、测试和当前设计删除。
- AppServer/Codex 使用原生 namespace；DSH Adapter 以 `connectors__*` 投影模型工具名，Host broker 仍使用 `connectors.*` 权威 identity。WorkBuddy 参考确认其 MCP 也保留 owner，物理工具使用 `mcp__server__tool` 投影；本轮未复制其运行时。
- 真实 Codex CLI 0.155.1 + production `CodexEngineAdapter` smoke 通过；完整 Workbench dynamic tools 可随 `thread/start` 创建 Thread，本地合成模型请求 1、外部请求 0。
- 真实 DSH smoke 通过 `connectors__search_tools -> connectors__get_tool -> connectors__call_tool`，等待 13 秒一次审批后调用隔离 HTTP，撤销后旧 handle 被拒绝。
- Workbench Runtime/Web/Local Host typecheck、Connector 32 项、所有权聚焦 10 项、DSH 234 项、Chat 回归、边界门禁与 Electron 构建通过。
- Developer ID arm64 包位于 `opencraft/apps/workbench-electron/release/signed-20260922-061654-connector-namespace/`；ZIP SHA-256 `d8f2ae5dcaf5d4812f30a22fcb43835ec38c30f34dabe9f2716c58e6f63f509b`。
- 已安装并启动 `/Applications/OpenCraft.app`，buildId `20260922061557-eda6eb3a9a91`，deep/strict codesign 通过；Gatekeeper 仍是 `Unnotarized Developer ID`，未提交公证。
- 替换前安装版备份 `OpenCraft-before-connector-namespace.zip`，SHA-256 `ea3fa599381eeac7b5f10f9d750b0e73e1912d32d1576ce40ff9572e8bda6017`；原 App 位于 `~/.Trash/OpenCraft-before-connector-namespace-20260922-061654.app`。
- 未提交、推送、上传或公开发布。
