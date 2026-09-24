## goal

国际站 WhatsApp 通道同一实例只让一个 Bot 连接，并在其他 Bot 上解释占用和提供管理入口。

## non_goals

- 跨实例或跨用户的 WhatsApp 号码唯一性。
- Hermes 按聊天对象路由到多个 Profile。
- 国际站多 Bot 开放与发布。

## requirement_refs / requirement_excerpt

- 本对话：用户同意先做连接前说明和同实例占用态，边界是“同一实例”。

## interface_refs / data_structure_refs

- `ctl/pkg/instance/bots.go` 的实例级通道绑定记录与 `/v1/instances/:id/bots/:botId/channel-bindings/:channel`。
- `ctl/pkg/transport/instance.go` 的 `InstanceBotResponse`，前端 `Bot` 与 `CtlInstanceBotPayload`。
- 保持微信行为不变；WhatsApp 仅用实例级通道键，不记录号码。

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`; `docs/engineering/domains/site-environment-routing.md`; `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`: 微信已有实例级唯一通道占用态；国际站多 Bot 创建入口当前隐藏。
- `superseded_refs`: 无。

## acceptance

- WhatsApp 卡片始终给出同实例限制说明；非持有 Bot 显示持有 Bot 名称和管理入口，无法扫码。
- 持有 Bot 可重连；断开后新 Bot 可连接；同实例并发 claim 只有一个持有者。
- 运行 ctl 与前端聚焦测试、服务门禁、i18n、change-impact 检查。

## affected_paths

- `ctl/pkg/instance/`, `ctl/pkg/transport/`。
- `frontend/src/domain/`, `frontend/src/repositories/`, `frontend/src/contexts/`, `frontend/src/pages/marketing/`, `frontend/src/content/docs/`, `frontend/src/i18n/`。
- `docs/engineering/domains/`。

## required_context

- `agent-gateway-runtime`, `frontend-product-surface`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@1bbb1a12a` | 通道执行边界 | 确认 ctl 编排归属 |
| `docs/context/project/services/frontend.md@1bbb1a12a` | 前端双站边界 | 明确 UI 与后端各自责任 |
| `frontend/AGENTS.md@1bbb1a12a` | 前端门禁 | 验证与类型约束 |
| `ctl/AGENTS.md@1bbb1a12a` | CTL 门禁 | 验证实例级绑定服务 |
| `docs/context/project/services/ctl.md@1bbb1a12a` | CTL 服务边界 | 检查实例命令邻居 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1bbb1a12a` | 前端邻接 | 检查 i18n 与测试邻居 |
| `docs/engineering/domains/agent-gateway-runtime.md@1bbb1a12a` | 正式设计 | 同步通道绑定规则 |
| `docs/engineering/domains/site-environment-routing.md@1bbb1a12a` | 正式设计 | 同步国际站 UI 规则 |

## evidence

- 路由命令命中上述两个 Pack。工作区源于 `origin/master` `1bbb1a12a`。
- Hermes Agent 0.21.3 对应 tag `v2026.9.14` 的 WhatsApp 文档说明旧会话位于默认 Profile 的 `platforms/whatsapp/session`；首次访问占用记录时识别旧会话，断开后不重复识别。
- `CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestChannelBindingScript|TestWhatsAppBindingAdoptsLegacy|TestDeleteInstanceBot|TestListInstanceBots' -count=1` 通过。
- 前端占用卡片与 repository 聚焦测试共 78 项通过；`pnpm check` 通过，TypeScript 171 条既有基线、0 条新增。文档 en-us、zh-sg、zh-hant、id-id 产物已核对。
- `pnpm build:global` 通过，静态页面、国际站路由与 SEO 检查完成；`validate_change_impact.py --repo . --staged` 和 `validate_documentation.py --repo . --format json` 通过。

## risks

- 只保证同一实例一个 WhatsApp Bot，不保证号码跨实例唯一；UI 文案须准确。
- 旧连接没有绑定记录时，需要避免误报已占用。
- 本机 `localhost` 无法解析，Vitest 验证使用临时配置把测试服务器指向 `127.0.0.1`，交接前删除临时文件。
- 全量前端测试出现多组无关失败，其中设置页测试加载第三方 `@tencent/agentchat-claw-panel` 的 CSS 时触发 Node `ERR_UNKNOWN_FILE_EXTENSION`；全量运行在持续失败后中止。CTL 全量测试受本机 CGO linker、SQLite 需 CGO 与缺少 rootless Docker 影响，聚焦包和 API 包的测试已通过。

## validation

- `go test ./pkg/instance ./main/api`（从 `ctl/`）。
- 前端聚焦测试、lint、typecheck、i18n 检查、`validate_change_impact.py --repo . --staged`。

## decisions

- 复用实例级微信绑定机制增加 WhatsApp 通道键，避免仅前端状态导致并发绕过；不做号码级绑定。Owner: 本任务用户确认范围。

## scan_scope

- `ctl/pkg/instance/bots.go`, `frontend/src/pages/marketing/agent-settings-page.tsx`, `frontend/src/pages/marketing/agent-channel-panel.tsx` 及相邻测试。

## scan_output

- 有界 `rg` 与源码读取结果见本任务对话，不内联全文。

## handoff

- 实现和可用验证完成；用户已明确授权提交 MR。FEAI 已到待归档阶段，本次不归档；不合并或发布。

## checkpoint

### stage

实现与可用的服务门禁已完成；验证限制已记录，交接。

### verified

- CTL 聚焦测试、前端 78 项聚焦测试、`pnpm check` 已通过。
- 国际站 WhatsApp 文档的四种实际路由产物含同实例限制说明。
- `pnpm build:global`、change-impact 与文档完整性检查通过。

### unverified

- 全量前端与 CTL 套件在本机环境下未通过；未做线上实例扫码验收。

### discard

- 首轮生成的无关 i18n 键清理；已恢复，仅保留新文案键。

### restore

- 独立工作区 `/Users/pablozhong/.codex/worktrees/whatsapp-single-bot-ui/lightvela`；主工作区未改动。
- FEAI change `whatsapp-one-bot-per-instance` 已到待归档阶段，本次不归档。

### next_action

- 以当前独立工作区提交 MR，核验远端分支与即时 CI；本次不归档、不发布。
