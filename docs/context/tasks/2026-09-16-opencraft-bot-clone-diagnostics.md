## goal

让 OpenCraft Bot 克隆失败保留可安全展示的上游诊断信息，不丢失未知写入结果的防重试保护。

## non_goals

- 不修改 Hermes Profile 创建语义、生产实例或网关部署。
- 不把聊天视图组件当作 Bot 克隆命令的所有者。

## requirement_refs

- 用户报告克隆后立即出现“操作结果尚未确认”，刷新后没有新 Bot；指向 b7de worktree。

## interface_refs

- `HermesInstanceBotManagement.write` 调用实例 Bot HTTP API；`LightVelaApiError` 提供 HTTP status 与 code。
- 未确认写入不自动重发；错误诊断不得包含上游原始 message。

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md` 的 Bot/Profile 管理约束。
- `relevant_evolution`: `ctl/pkg/instance/bots.go` 通过 `hermes profile create --clone-from` 创建克隆。

## acceptance

- 500 响应的状态及稳定 code 可见，原始错误消息不可见；同一 clientRequestId 不产生重复 POST。
- 网络中断仍提示结果未知；Bot 管理测试、类型和 lint 门禁通过。

## affected_paths

- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-bot-management.ts`
- `opencraft/tests/hermes-bot-management.test.ts`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- Context router 无匹配的 must_read Pack；阅读了 OpenCraft maintenance Skill、正式 Agent/runtime 设计及对应源码/测试。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 项目维护入口 | 验证路由 |
| `docs/engineering/domains/agent-gateway-runtime.md` | Bot 管理真源 | 保持未知写入保护 |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/instance-bot-management.ts` | 克隆写入 owner | 诊断信息边界 |
| `ctl/pkg/instance/bots.go` | 上游克隆实现 | 核对命令路径 |

## evidence

- 用户确认快速报错且刷新无 Bot；隔离新预览随后显示 `HTTP 500 · INSTANCE_BOT_PROFILE_FAILED`，证明请求已到达实例 Bot 的 CTL 路径，但不能单凭该码区分创建命令失败与后续 Profile 列表读取失败。
- 隔离预览从当前源码构建，旧完整提示不存在于新 JS；原先运行的 `dist-electron` 仍包含旧提示。临时 Electron 预览首次因漏带 tray 图标启动失败，补齐后通过独立 profile 加载 Bot 管理页，未覆盖原预览。
- 实例只读 GET 显示国际站、Running；本机 `kubectl` 仅有 `orbstack` context，不能读取目标 CTL 的生产日志。结合刷新列表可读且无新 Bot，失败更可能在复合创建命令及其回滚中；这是推断而非 stderr 证据。
- `go test ./pkg/instance -run "TestBuildHermesProfileCreateCommand|TestHermesProfileConfigUnsetOnlyIgnoresMissingKey" -count=1` 通过。
- `npm run test:bot-management`：19/19 通过；`@opencraft/plugin-lightvela-hermes` 类型检查与 `check:boundaries` 通过。
- 全仓 `npm run typecheck` 失败于现存 `group-conversations.ts:500,522` 的 Expo `unref` 类型错误；本轮未改该文件。

## risks

- 上游 5xx 可能发生在部分副作用之后；继续要求刷新核对而不提供自动重试。
- 真实服务端的具体失败原因仍需一次带稳定 code/request_id 的现场证据。

## validation

- `npm run test:bot-management`
- OpenCraft TypeScript/lint 门禁与 context change-impact 检查。

## decisions

- 仅展示 HTTP 状态及严格格式化的 code，不展示原始 message；先改善可观测性，不臆测服务端根因。

## scan_scope

- Bot management UI、Hermes bridge、CTL instance Bot 命令及对应测试。

## handoff

- 本地诊断改动已在独立 `/tmp/opencraft-bot-clone-preview.JhkIIU` 渲染器产物及临时 Electron profile 验证；未覆盖用户旧窗口、未发布。现场已得到 500 与稳定 code，下一步需要该实例的只读命令/CTL 日志明确失败阶段；不得盲目重发创建。
- 无目标实例的命令 stderr 时，不把版本差异、`--clone-from`、通道清理或元数据写入中的任一项宣称为已确认根因。
- `validate_change_impact.py --staged` 运行通过但当前无 staged 文件，不能将其视作本轮变更的覆盖证明；本轮已同步正式设计文档。
