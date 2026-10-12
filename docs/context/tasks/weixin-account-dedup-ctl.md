---
id: weixin-account-dedup-ctl
type: task
scope: Weixin account deduplication and owning Bot conflict guidance.
triggers: ["weixin account dedup", "微信账号查重", "微信冲突弹窗"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/weixin-account-dedup-ctl.md
status: retired
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
拒绝同实例内同一微信账号绑定另一个 Bot，并显示原 Bot 名称及前往其通道页入口。

## non_goals
- 不自动迁移连接，不修改发布或生产，不改变 WhatsApp 唯一绑定规则。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户当前会话授权实现并提交 MR；前端关联 !5180，后端为独立 MR。
- 弹窗复用现有 Dialog/Button，按钮圆角；必须等 CTL 确认后显示扫码成功。

## interface_refs / data_structure_refs
- `ctl/pkg/instance/bots.go` 的 claim/confirm/release。
- `WEIXIN_ACCOUNT_OCCUPIED` / `details.occupied_by_bot` 只返回同实例已授权 Bot 的 ID 和名称等绑定元数据。
- Profile-scoped Weixin identity/account files; whole-instance `weixin.lock` serializes confirmations。

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`、`docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: !5179 已支持按 Profile 绑定不同微信；!5180 去除实例级占用提示并新增扫码提醒。
- superseded_refs: 原实例只能绑定一个微信的限制。

## acceptance
- 相同 account_id 或非空 user_id 只能确认一个 Bot；不同账号可分别绑定。
- 拒绝后只回滚扫码 Profile，保存先前连接及无关设置；旧 lease 不得回滚新扫描。
- 前端显示真实名称，前往 owner channels，冲突时不发成功回调。

## affected_paths
- ctl/
- docs/engineering/domains/

## required_context
- agent-gateway-runtime; site-environment-routing; service ctl。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 隔离 worktree、源码与发布分离 |
| `ctl/AGENTS.md` | 服务门禁 | 校验命令 |
| `docs/context/project/services/ctl.md` | 路由 must_read | 服务职责 |
| `docs/context/domains/agent-gateway-runtime.md` | 渠道运行时 | CTL 持有绑定权威 |
| `docs/context/domains/site-environment-routing.md` | API 消费路由 | 保留站点及鉴权边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 生成物邻居 | OpenCraft/i18n 闭合 |

## evidence
- 2026-10-12: CGO_ENABLED=0 下实例/HTTP API 相关微信与 WhatsApp 回归通过；Go vet 通过。新增并发、重复账号、旧 lease、重连及其他通道保留测试全部执行并通过（本机临时提供 PyYAML）。
- 全量 go test 在本机 macOS SDK linker 失败；CGO=0 的全量测试无法运行 SQLite/Docker 部分，不宣称全量通过。
- Documentation 校验通过；Context 全仓 4 项既有历史 metadata/compact budget 失败，context audit 单元测试 33 项通过。
- 后端基于 origin/master 0c4a75d3b；前端已有 !5180 branch 8ef246114。

## risks
- 微信服务端再次登录是否使旧 token 失效尚未实测；本实现只保证本地回滚和绑定规则，不承诺 provider 行为。
- 旧客户端无 lease 的兼容入口与直接 CLI 绕过绑定确认不构成跨实例全局账号约束。

## validation
- CTL Go tests/vet；前端 focused Vitest、pnpm check/build、OpenCraft sync/check；documentation/staged impact/diff check。

## decisions
- 冲突不自动断开 owner；current Profile 私有快照回滚；用户手动前往 owner 断开。

## scan_scope
- ctl/pkg/instance; frontend/src/pages/marketing/agent-config; frontend/src/repositories。

## scan_output
- 精确源码与测试定位，无外部扫描产物。

## handoff
- 本地实现与聚焦验证完成，交付独立后端 MR；只授权提交，不授权合并/发布。

## checkpoint
- stage: MR delivery; focused Go regression and vet passed; full suite limited by host linker/SQLite/Docker.
- verified: account files and CTL details serialization entry identified。
- unverified: real WeChat duplicate scan and provider token behavior。
- discard: earlier rectangular button mock。
- restore: isolated worktrees above, preserve primary dirty checkout。
- next_action: commit backend, push feature branch, create standalone MR。
