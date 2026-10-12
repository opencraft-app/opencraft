---
id: weixin-gateway-recovery-fix
type: task
scope: 修复微信扫码恢复与已安装 Hermes 网关命令的兼容性。
triggers: ["weixin gateway recovery", "微信恢复失败", "gateway stop"]
owner: pablozhong
authority: primary
source_of_truth:
  - ctl/pkg/instance/weixin_account.go
status: active
reviewed_at: 2026-10-12
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
修复失败扫码回滚无法停止网关、导致微信重试持续失败的问题。

## non_goals
- 不发布生产、不恢复用户实例、不修改账号查重身份读取、不改变 WhatsApp。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户现场反馈，无单独 TAPD ID：点击重试也不行。
- 用户复现现网 DELETE channel-bindings/weixin 409 WEIXIN_RECOVERY_FAILED；request_id 9b4b2dd4-67bc-48bc-b24f-aa95691bb359，随后连接和重试持续失败。

## interface_refs / data_structure_refs
- `ctl/pkg/instance/bots.go:channelBindingPayload` 与私有 state.json snapshot；不修改 API schema。
- claim/confirm/release 和 recovery_required；既有错误码与私有快照不变。

## history_context
- current_design_refs: docs/engineering/domains/agent-gateway-runtime.md 微信回滚失败与删除契约。
- relevant_evolution: !5222 引入恢复状态；本轮真实 runtime 检查证明 stop 命令不可用。
- superseded_refs: 原文“停止失败仍覆盖配置”被本轮停止确认后恢复所替代。
- !5222 引入回滚和 recovery_required；实际 ACLI 2026.9.30/specs1.1.64 没有 gateway stop，带 --agent 调帮助退出1 unknown flag。
- docs/engineering/domains/agent-gateway-runtime.md 的微信回滚失败契约需同步更新。

## acceptance
- 失败恢复只停止目标 Profile；已停止幂等成功；停止失败不覆盖配置。
- 历史 recovery_required 在下一次 claim/release 可以恢复。
- 单元测试模拟真实不支持 stop 的 ACLI，并覆盖停止/重启失败、Profile 隔离和并发锁。

## affected_paths
- ctl/pkg/instance/weixin_account.go
- ctl/pkg/instance/weixin_account_test.go
- docs/engineering/domains/agent-gateway-runtime.md
- frontend/src/pages/marketing/agent-config/components/HermesQrCodeModal.tsx (frontend worktree)
- frontend/src/pages/marketing/agent-config/__tests__/hermes-qr-code-modal.test.tsx (frontend worktree)

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| ctl/AGENTS.md | 服务门禁 | Go测试 |
| docs/context/project/services/ctl.md | must_read | 控制面边界 |
| docs/context/domains/agent-gateway-runtime.md | must_read | 实例运行时 |
| docs/context/tasks/weixin-account-dedup-ctl.md | 相关历史 | 回滚协议 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | modal测试与生成物 |
| frontend/vitest.config.ts | 测试邻居 | 前端聚焦验证 |

## validation
- CTL guard / vet，documentation、change impact、diff check；frontend focused Vitest、check、build、OpenCraft sync/check。

## evidence
- Backend clean new branch codex/weixin-gateway-recovery-fix from origin/master83223816e。
- No production/cloud mutations authorized or performed.

## handoff
读取实际 Hermes gateway_stop 和 ACLI restart specs，核实 Profile 作用域后实施；前端只补准确恢复错误提示。


## stage
实现与交接门禁已完成，用户已授权前后端分别提交 MR，开始提交；尚未发布。

## verified
- 北京 root / 子 Bot PID 分别 2024626 / 2037236；native gateway stop --help 均成功。
- CTL guard 68 tests passed; none skipped，含 go vet。
- 前端 focused Vitest 11 tests；check 翻译结构及 TypeScript baseline 0 new diagnostics。
- docs-impact passed；documentation errors=[]。

## unverified
- 现网实例确切失败日志、镜像版本和修复后恢复；无生产实例变更授权。
- 国内站隔离构建成功；物理依赖副本避免 Turbopack 跨 root symlink 限制，源 worktree dev server 不受影响。
- OpenCraft 生成副本需要源码 commit 后同步，尚未提交。

## discard
- 临时 agent-settings-page useEffect 已恢复原文件，不提交诊断代码。

## restore
- CTL branch codex/weixin-gateway-recovery-fix，base83223816e；frontend codex/wechat-per-bot-frontend。
- 测试日志 /tmp/weixin-recovery-*.log；不保存 credential 值。

## next_action
提交 CTL 独立修复 MR；前端继续推 !5180，源码提交后按 frontend/AGENTS.md 同步 OpenCraft 生成闭包。


## validation_limits
- 全量 CTL go test ./... 执行失败，包含 CGO_DISABLED 的 SQLite stub、rootless Docker 缺失及未改动的 TestRunCreateInstanceTaskProvisionsAiGatewayOnCreate 期望差异；不能声称全量通过。
- Context unittest 27 tests 有4个仓库治理失败；context-audit unittest 33 tests 通过。新增 Task Pack catalog 无自身错误，documentation errors=[]，docs-impact passed。
- OpenCraft readonly check 检出真源漂移；尚未源码 commit，按 frontend/AGENTS.md 保留为提交后生成步骤，不手改生成副本。
- 停止动作预算45秒、helper预算50秒，加既有重启60秒，位于自定义 debug command120秒预算内。
