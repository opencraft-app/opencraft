---
id: task-model-config-command-length-2026-09-17
type: task
scope: 修复 CTL 用户包装重复长命令导致模型配置读取失败。
triggers: ["model configuration", "debug exec", "shellUserCommand"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - ctl/pkg/instance/weixin_login.go
  - ctl/pkg/instance/command_exec_test.go
  - ctl/pkg/instance/shell_user_command_test.go
status: retired
reviewed_at: 2026-09-17
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

# 模型配置长命令执行修复

## goal
修复模型配置读取经 CTL `shellUserCommand` 包装后重复命令正文、超过 Linux 单参数长度限制导致的 `DEBUG_EXEC_FAILED`。

## non_goals
- 不改变模型配置、Profile、凭据、重置业务语义或 TAT 执行通道。
- 不合并 MR 或发布生产；用户后续已授权 commit/push/创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户现网截图及“帮忙修复一下”。
- MR !4115，source `7e300634654d10c22c0e2119e9a2cbf17f1ef6d1`，merge `2e56ec262d341991b31f02e08058437575f875be`。

## interface_refs / data_structure_refs
- `ctl/pkg/instance/weixin_login.go:shellUserCommand`。
- `ctl/pkg/instance/logic.go:ExecDebugCommandWithBackend, StreamDebugCommandWithBackend`。
- `ctl/pkg/adapter/sandbox:ProcessStartRequest`：保留 bash login shell、环境变量、用户和输出/退出码协议。

## history_context
- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md`、`ctl/docs/README.md`。
- relevant_evolution：!4115 扩大共享 Python helper；主 Profile 的 read 命令经双份包装由 128458 增至 136044 字节，超过 131072 字节。
- superseded_refs：历史 !4044/!4065 仅作定位线索；本次以 !4115 合并结果为基线。

## acceptance
- 同步和流式 debug/exec 发送的 70 KiB 脚本包装低于 128 KiB，不重复正文。
- 当前用户和 sudo 分支保留参数边界、环境、stdin/stdout/stderr 和退出码。
- 不指定用户时原命令直接返回。
- 完成 CTL Go 测试、vet、格式检查和 context/documentation 门禁。

## affected_paths
- `ctl/pkg/instance/weixin_login.go`
- `ctl/pkg/instance/command_exec_test.go`
- `ctl/pkg/instance/shell_user_command_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`
- 本 Task Pack 和 checkpoint。

## required_context
- service-ctl、control-plane-ops、agent-gateway-runtime。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@2e56ec262` | 仓库约束 | worktree、验证、交付边界 |
| `ctl/AGENTS.md@2e56ec262` | 服务约束 | Go 门禁 |
| `docs/context/project/services/ctl.md@2e56ec262` | 路由 must_read | 明确 CTL 执行权 |
| `docs/context/domains/agent-gateway-runtime.md@2e56ec262` | 路由 must_read | 运行时边界 |
| `ctl/docs/README.md@2e56ec262` | 服务权威入口 | 验证范围 |
| `docs/engineering/domains/agent-gateway-runtime.md@2e56ec262` | 正式设计 | 同步命令包装不变量 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@2e56ec262` | 模型页相邻测试 | 检查 real-source smoke 的本地 shell 路径未覆盖 CTL 包装 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务契约 | 记录状态 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 交接契约 | 保存检查点 |

## evidence
- 最新 master `2e56ec262`；独立 worktree `lightvela-model-config-command-length`。
- 有界搜索：`shellUserCommand`、`shellUserEnv`、`ExecDebugCommandWithBackend` 命中 CTL 实现和 `command_exec_test.go`。
- 现有 frontend smoke 直接调用生成的脚本，未经过 CTL 的用户包装。

## risks
- 共享包装函数影响同步/流式 debug/exec 和 Hermes model set 调用；须保留用户及环境语义。
- 仍通过 bash `-c` 传参；单份原始脚本自身超过系统限制属于后续传输层工作，本次不扩展接口。

## validation
- 旧实现回归失败：70 KiB 脚本双份包装为 144053 字节（含 NUL）；两条用户分支均失败。
- `CGO_ENABLED=0 go test ./pkg/instance -run 'Test(ShellUserCommand|DebugCommandSupportsLongRunAsAgentUserScript|ExecDebugCommand|StreamDebugCommand)' -count=1` 通过。
- 默认 CGO 构建受本机 macOS SDK 11 缺少 `SecTrustCopyCertificateChain` 符号阻塞；CGO=0 的全量测试又受到 SQLite stub 和 Docker 缺失限制。
- context-audit 测试 33/33 通过。
- CTL 相关回归通过：`CGO_ENABLED=0 go test ./pkg/instance/... ./main/api/... ./pkg/adapter/sandbox/... -skip '^Test(DestroyInstanceDoesNotRecordAcceptedEventWhenAlreadyDeleting|EnqueueRollbackRenewPassTaskIsIdempotentByParent|StableRollbackTaskRemainsRetryableWhenMQSendFails|ResolveInstanceSpecIDFollowsPassBundleAfterModify|UpdateModifyPassPayloadPreservesFinalizedReceipt)$' -count=1`，352 个顶层测试、含子项 488 个通过。5 个列明的 SQLite/Docker 依赖测试未执行。
- `CGO_ENABLED=0 go vet ./...`、`CGO_ENABLED=0 go build ./...`、gofmt 与 `git diff --check` 通过。
- `validate_documentation.py --repo . --format json`：0 errors、0 warnings。
- 生成 catalog 后，对照独立未修改 master worktree，context validator 两边同为 1010 个现有问题；按仓库路径归一化后新增 0、减少 0。context tests 的 4 项失败在基线复现。
- `audit_context.py --repo .` 成功执行发现流程，状态为 needs_agent_review/not_assessed，不声称审计评级通过。
- internal linker 无法兼容本机 SQLite C 对象，故不修改系统 SDK 或测试依赖来追求全量绿色。
- `validate_change_impact.py --repo . --staged` 通过；提交前重新 fetch，master 仍为 `2e56ec262`，无需 rebase。

## decisions
- 使用 shell 位置参数保存启动器；条件分支只选择启动器，命令正文仅引用一次，避免扩大实现范围。

## scan_scope
- CTL instance 执行包装与对应测试；frontend 模型 helper 仅用于问题证据。

## scan_output
- 无独立扫描产物。

## handoff
- 实现完成，分支 `codex/fix-model-config-command-length`；用户已授权提交并创建 MR，交付状态以工蜂最新查询为准。
- 修复是 CTL 服务改动，现网生效需要后续 CTL 交付；没有在生产运行命令或更改配置。
- 当前本机全量 Go 与 context 门禁限制已记录；需要具有 SQLite/Docker 环境的 CI 补齐依赖测试。
