---
id: task-opencraft-ci-isolated-install-checkpoint
type: task
scope: Recovery checkpoint for the OpenCraft MR guard repair.
triggers: ["opencraft CI checkpoint", "opencraft guard", "embedded test dependencies"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-30-opencraft-ci-isolated-install.md
status: active
reviewed_at: 2026-09-30
review_due: 2026-10-30
revision: 1.0.0
precedence: task
derived: false
---

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4872 的 CI 失败后，用户要求修复并提交 MR；完整范围见 Task Pack。

## interface_refs / data_structure_refs
- `.ci/checks/opencraft_guard.sh` 与 `UPSTREAM.json`；完整接口见 Task Pack。

## history_context
- current_design_refs: `.ci/README.md` trusted guard 规则。
- relevant_evolution: master 合入 MR !4868 后生成清单漂移。
- superseded_refs: 无。

## context_receipt
- 已读上下文与测试邻居见 Task Pack 的 `context_receipt`。

## stage
隔离安装与生成清单修复完成本地验证，准备提交独立 MR。

## verified
- 官方同步将 master 的 `UPSTREAM.json` 修订号更新为当前源文件计算值，130 个文件校验通过。
- 隔离目录的 OpenCraft guard 安装依赖后，嵌入式测试 145/145 通过。
- 生成清单检查 130 个文件、MR guard 合同测试 7/7、文档断链检查通过。
- MR !4872 的附件 CI 日志显示旧 guard 在共享源码工作目录执行 `npm ci` 后缺少多个锁定依赖。

## unverified
- 新 MR 的远端 CI 及合并状态。
- 本机 Apple Git 2.24 不支持 `git init -b`，导致 CI runtime 全量测试中 19 项环境错误；Linux CI 结果待查。
- Context catalog / 单测受仓库既有 Task Pack schema 错误影响；新增两份 Task Pack 未出现在错误清单。

## discard
- 首轮隔离测试缺少跨目录 locale 文件的失败结果已由复制该文件的修正替代。

## restore
- 独立工作树 `/Users/pablozhong/.codex/worktrees/opencraft-ci-isolation/lightvela`，分支 `codex/opencraft-guard-isolated-install`。
- 原功能 MR !4872 仍在 `codex/paused-agent-chat-prompt` 分支，未在此分支修改。

## next_action
完成必要静态检查与 MR 远端提交核验。
