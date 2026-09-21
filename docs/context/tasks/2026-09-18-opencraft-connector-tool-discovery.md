## goal
按 Codex/AppServer 的 deferred capability 模型实现引擎中立的 Connector Capability Runtime，使大规模连接器工具目录可有界搜索、按需加载精确 schema、签发短期 handle 并通过各 Engine Adapter 投影。

## non_goals
不调用真实腾讯文档工具、不读取本机连接器凭据、不采用 Octop 产品白名单、不把 DSH 建模为产品级特例、不修改 AppServer 生成标准来伪造 `thread/resume.dynamicTools`。

## requirement_refs
用户现场报告 `connectors_list_tools` 因腾讯文档 224 个工具超过响应上限；要求对照 ref/workbuddy、ref/codex、ref/octop 与当前实现给章程。

## context_receipt
根/OpenCraft AGENTS；OpenCraft maintenance 与 research Skill；platform architecture；当前 connector dynamic-tools/runtime/managed provider/connector-host MCP；相关协议测试；ref/workbuddy DeferToolLoading/ToolSearch/search_integration_tool；ref/codex DynamicToolSpec.deferLoading、tool_search feature 和 dynamic tool thread-start；ref/octop catalog/builder/manager/cache/tests。

## evidence
- 当前 `connectors_list_tools` 无输入参数，调用 `runtime.discover()` 全量生成 schema/handle，JSON 超过 262144 字符整批失败；MCP inventory 接受最多 256 工具。
- WorkBuddy `DeferToolLoading` 默认 true，声明通过 ToolSearch 按需激活；恢复代码可证明能力开关/呈现，不能证明完整后端排序细节。
- Codex generated DynamicToolFunctionSpec 包含 deferLoading；存在 `tool_search_always_defer_mcp_tools` 并在线程 dynamic tool 目录中标记延迟工具。
- Octop 腾讯文档 catalog 明确 allowlist 10 项；custom MCP 按 turn 加载，user/server/spec fingerprint 缓存后 append；没有把全量工具清单作为模型工具结果返回。该事实只解释其未触发错误，不进入 OpenCraft 目标方案。首次读取输出截断在第 8 项，已回读完整 tuple 并纠正。
- 已新增 ConnectorCapabilityRuntime；224 个大 schema 可完整分页，搜索页小于 64 KiB且不含 schema/handle，精确 detail 后调用成功。
- selection generation、inventory/schema、授权/连接变化会使 cursor、toolRef 或 handle 失效；超大 schema 在签发 handle 前拒绝。
- 真实隔离 DSH/AppServer smoke 完成 search → detail → call → 13 秒写审批 → HTTP；disconnect 后旧 handle 未到达服务。
- `npm run gate` 通过，包括全 workspace typecheck、平台边界、Connector/AppServer/DSH/Chat/Workbench 测试和 Web/Expo 构建。
- macOS arm64 Developer ID 包已从当前 dirty 源码重建：buildId `20260918080102-ce37d8741788`，输出 `apps/workbench-electron/release/signed-20260918-080053-connectors-runtime/`。App 深度/严格签名、DMG 签名/镜像、ZIP 完整性与隔离启动通过；包内 Renderer 包含 Connector Capability Runtime。未配置公证，Gatekeeper 明确为 `Unnotarized Developer ID`。
- 2026-09-19 用户再次看到旧的 `Connector output exceeded the supported response limit.`。只读核对证明 `/Applications/OpenCraft.app` 仍是 build `20260918063832-3b5a40663c3c`，包内确有旧错误字符串且没有 `connectors_search_tools`；最新签名包 build `20260919133456-ece25895141d` 包含新搜索工具且不存在旧字符串。根因是安装版未替换，不是新 Runtime 回归。未获安装授权，因此没有覆盖 `/Applications`。
- 用户随后授权安装。旧 `/Applications/OpenCraft.app` 已移动到 `apps/workbench-electron/release/install-backups/OpenCraft-20260918063832-3b5a40663c3c.app`，新 build `20260919133456-ece25895141d` 已复制到 `/Applications` 并通过深度/严格签名验证。真实用户会话重新启用腾讯文档后，`connectors_list_tools` 首次及后续 cursor 分页均成功，未再出现响应超限；模型连续调用 22 页后由验收者主动停止，未调用写工具或浏览器。
- 执行面继续失败的根因随后定位为 inventory digest 顺序敏感：连续两次腾讯文档 inventory 都是同一 224 项、字段无变化，但 server 返回顺序不同，digest 从 `622c…` 变为 `546a…`，`ConnectorMcp.call` 在真正远端调用前返回内部 `conflict`。已在 Host 边界按工具名排序并 canonicalize JSON object keys，保留真正 schema 变化的 conflict；反转工具顺序/字段键顺序的真实 MCP SDK 回归通过。
- 完整 gate 通过，Developer ID build `20260919153307-e2a9b6e63dc7` 已安装到 `/Applications`。真实用户实例先成功调用 `check_skill_update {}`，再成功调用 `manage.folder_list {folder_id:"",start:0}` 并返回 `finish=true`、8 项根目录记录；未调用写工具。上一安装 build `20260919133456-ece25895141d` 已备份。

## acceptance
- Capability view/search/detail/handle 只有一套领域语义；ConnectorRuntime 继续唯一持有连接、授权、选择与实际调用。
- AppServer Adapter 使用标准 `thread/start.dynamicTools` 与 `deferLoading`；其他 Engine 通过显式能力协商投影，不在产品层按引擎名字分支。
- `connectors_list_tools` 兼容入口有界且可续读；224 个大 schema 不再整批失败，精确工具可取 schema 并调用。
- cursor/handle 在选择、授权、连接或 inventory 变化后可靠失效；写审批和取消语义保持。
- 聚焦测试、两端 typecheck、协议/边界检查和隔离真实运行时 smoke 通过；不接触真实第三方账号。

## stage / handoff
实现、验证、签名包与 `/Applications` 安装更新完成；未提交、未发布。真实腾讯文档连接仅验证目录分页，未调用文档读写工具。正式章程：opencraft/design/connector-tool-discovery.md。目标只综合 WorkBuddy ToolSearch 与 Codex deferred capability；Octop 白名单明确列为拒绝方案。
