---
id: checkpoint-model-config-command-length-2026-09-17
type: task
scope: 模型配置长命令修复的验证状态。
triggers: ["model command checkpoint", "debug exec validation", "shellUserCommand handoff"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-17-model-config-command-length.md
status: retired
reviewed_at: 2026-09-17
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## stage
实现与可运行验证完成，用户已授权提交 MR。

## verified
- 独立 worktree 基于 master `2e56ec262`。
- 旧包装的超限回归 red；新包装的同/异用户和同步/流式 debug/exec 聚焦测试 green。
- context-audit 测试 33/33 通过。
- CTL 回归 352 个顶层测试、含子项 488 项通过；排除 5 个已确认依赖 SQLite/Docker 的测试。
- CGO=0 下 vet、build 通过，文档 validator 0 errors/0 warnings。
- context validator 在修复/未改动基线上均有 1010 个相同错误；context tests 的 4 项失败已在基线复现。

## unverified
- 完整 CGO 测试需要兼容 SDK 与 SQLite/Docker；internal linker 不能解决 SQLite C 对象链接问题。
- 尚未验证生产环境或部署 revision。

## discard
- 不能将 CGO=0 全量测试失败解释为本次代码回归。

## restore
- 分支 `codex/fix-model-config-command-length`。
- Task Pack 记录了需求、设计和范围；用户已授权修复及 commit/push/MR，未授权合并/发布。

## next_action
创建 MR 并核对远端 SHA、合并状态及 CI；CI 补齐依赖测试，通过后再单独授权 CTL 发布。
