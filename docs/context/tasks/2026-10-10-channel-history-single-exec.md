## goal

将渠道聊天记录的 Bot/Profile 解析与数据库读取合并为一次 TAT 执行，同时保持现有归属校验、Bot 不存在和历史记录过滤语义。

## non_goals

- 不增加 Profile 缓存或任意并发阈值。
- 不变更前端、网关白名单、功能开关或生产部署。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户 2026-10-10 请求：审查 MR !5152 的 CR 后“修改代码吧”；重点是每次历史请求两次远程执行。
- CR 参考：`/Users/pablozhong/WorkBuddy/lightvela/cr-reports/CR-MR5152.md`，其性能数据是本地脚本测试，真实 TAT 耗时待测。

## interface_refs / data_structure_refs

- `ctl/pkg/instance/channel_history.go`：`ListChannelSessions`、`ListChannelMessages` 与脚本 JSON payload。
- `ctl/pkg/instance/bots.go`：`list_hermes_profiles` 的官方 Hermes Profile 列表和默认 Profile 投影规则。
- `ctl/pkg/instance/logic.go`：`ExecDebugCommandWithBackend` 的实例归属、Running 和权益校验。

## history_context

- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md` 的渠道聊天记录只读接口。
- relevant_evolution：MR !5147 已合并 CTL 只读接口；MR !5152 是网关白名单，与本次 CTL 改动独立。
- superseded_refs：无。

## acceptance

- 每次渠道历史请求只调用一次 `execHermesProfileCommand`。
- 默认 Bot、命名 Bot、缺失 Bot 与异常 Profile ID 的行为有聚焦测试；消息投影继续过滤工具和敏感内容。
- CTL 聚焦测试、静态检查、文档变更检查通过。

## affected_paths

- `ctl/pkg/instance/channel_history.go`
- `ctl/pkg/instance/channel_history_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `agent-gateway-runtime`、`control-plane-ops`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/agent-gateway-runtime.md@origin/master` | Agent 公共入口边界 | 不以 CTL 单测宣称公共入口可用 |
| `docs/context/project/services/ctl.md@origin/master` | CTL 服务边界 | 保留实例权威存储校验 |
| `ctl/AGENTS.md@origin/master` | 最近的服务说明 | 确定服务验证命令 |
| `docs/context/tasks/TASK-TEMPLATE.md@origin/master` | Task Pack 结构 | 记录本轮证据和风险 |
| `docs/engineering/domains/agent-gateway-runtime.md@origin/master` | 正式设计 | 同步一次 TAT 执行约束 |

## evidence

- `channel_history.go` 先调用 `getInstanceBotResponse`，后调用 `execHermesProfileCommand`；前者的 `listHermesProfiles` 也调用 `execHermesProfileCommand`，故当前每次两次远程执行。
- 当前主线基线：`origin/master` 于 2026-10-10 更新至 `3bc4384e5`。
- 新脚本在同一 TAT 命令中调用 Hermes Profile API，并在读取 SQLite 前匹配 Bot、验证 Profile ID；CTL 单测断言每次请求只有一条 PTY TAT 调用。
- 2026-10-10 聚焦测试 `CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestReadChannelHistory|TestChannelHistory' -count=1` 通过；聚焦 `go vet` 通过。
- 文档检查、staged change-impact 与 `git diff --check` 通过。
- 全量 `CGO_ENABLED=0 go test ./...` 因仓库其他测试需要 CGO SQLite，且部分测试需要 rootless Docker 而失败；不能作为本次改动失败归因。

## risks

- 远端脚本组合可能改变默认 Profile 的映射；以默认、命名及缺失 Bot 测试覆盖。
- 前端断开请求后实际 TAT 终止行为尚未核验，本次不做并发阈值推断。
- 回滚方式：撤回本次 CTL 源码变更；功能开关仍默认关闭。

## validation

- `cd ctl && CGO_ENABLED=0 go test ./pkg/instance ./main/api -run 'TestReadChannelHistory|TestChannelHistory' -count=1`
- `cd ctl && CGO_ENABLED=0 go vet ./pkg/instance ./main/api`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions

- 选一次 TAT 命令内实时解析 Profile；不选 30–60 秒缓存，因为删除 Bot 后缓存会暂时保留旧映射。
- 并发限制留待真实 TAT 延迟与并发数据确定阈值。

## scan_scope

- `ctl/pkg/instance/`，`ctl/main/api/`，`docs/engineering/domains/agent-gateway-runtime.md`。

## scan_output

- 无独立扫描产物。

## handoff

- CTL 优化已提交独立 MR !5154（目标 `master`），当前未合并、未部署，也未开启功能开关。真实 Hermes/TAT 环境延迟与并发容量仍待测试环境验证。
