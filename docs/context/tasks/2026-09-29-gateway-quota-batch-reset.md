## goal
提供可后台运行、可断点续跑的 CTL 网关用户订阅额度批量预检/重置脚本。

## non_goals
- 本轮不执行任何真实用户的非 dry-run 重置。
- 不更改网关服务端 API、套餐周期或历史用量日志。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话 2026-09-29：“写一个循环、可后台执行的、并有limit（支持无限） dryrun 和非dryrun的重置脚本”；外部需求编号 unknown。

## interface_refs / data_structure_refs
- `GET /internal/bots?status=Running&page=&page_size=` 获取可选用户；`POST /internal/users/{userID}/gateway/quota/reset`，请求 `dry_run`。
- 非 dry-run 仅在预检成功后执行；同一批次同一用户最多处理一次，连接结果不明时停止。

## history_context
- current_design_refs: `ctl/main/api/internal_bots.go`、`ctl/pkg/adapter/llmgateway/quota_reset.go`、`new-api/model/subscription.go`。
- relevant_evolution: 上海/新加坡 CTL 实测 dry-run 成功；`kubectl proxy` 不适合作为该 Bearer 鉴权操作入口，`kubectl port-forward` 可用。
- superseded_refs: none。

## acceptance
- 默认 dry-run，支持显式执行、正整数或 `all` limit、唯一用户去重、后台输出与安全 checkpoint。
- 通过 kubeconfig 自动管理 port-forward，且不在日志或命令行打印令牌。
- 用本地假服务验证 dry-run 无写、执行有写、limit、去重、恢复与错误停止。

## affected_paths
- `ctl/scripts/reset_gateway_user_quota.py`、`ctl/scripts/tests/test_reset_gateway_user_quota.py`、`ctl/scripts/README-gateway-quota-reset.md`、`docs/engineering/domains/agent-gateway-runtime.md` 和本文。

## required_context
- `control-plane-ops`、`agent-gateway-runtime`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 根边界 | 生产操作必须另行授权 |
| `ctl/AGENTS.md` | 服务约束 | CTL API 路径 |
| `docs/context/project/services/ctl.md` | 路由结果 | CTL 责任边界 |
| `docs/context/domains/agent-gateway-runtime.md` | 路由结果 | 网关归属 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计 | 人工额度重置的不变量 |

## evidence
- 代码显示网关 reset API 支持 `dry_run`、单用户订阅校验及保留自然重置周期；Running Bot 列表分页且含 user_id。
- 脚本自身经 kubeconfig/port-forward 对上海和新加坡各一个真实用户 dry-run，均返回 `ready`，`amount_used_before == amount_used_after`；没有发出 `dry_run:false`。
- `--all-running-bots --limit 1` 在上海/新加坡也各成功预检 1 人，分别发现 4230/2832 个去重 Running Bot owner（发现数为当时快照，非总订阅用户数）。

## risks
- `--limit all` 范围大：仅作为单轮人数上限，非永久重复作业；执行需额外确认。
- 连接中断时执行结果可能未知：停止而不自动重发；下次重跑先预检与人工核对。
- checkpoint 含用户 ID，应 0600 权限持久化；日志不含 token。

## validation
- 聚焦 Python 单元测试、语法检查、脚本 help、context 文档门禁。
- `python3 -m unittest discover -s ctl/scripts/tests -p 'test_reset_gateway_user_quota.py' -v`：6 个用例通过，覆盖文件来源、去重/limit、checkpoint 隔离、执行确认和不明结果停止。
- Python 语法检查、文档校验（0 个断链/告警）及显式变更集的 change-impact 检查通过；高风险领域映射提示需要 `wisp/mono2-maintainers` 审阅。

## decisions
- 提供文件来源和 Running Bot 用户来源；不假定 Running Bot 等于全部订阅用户。
- 正式执行前逐用户 dry-run；不可确认结果时 fail closed。

## scan_scope
- `ctl/main/api/internal_bots.go`、`ctl/pkg/adapter/llmgateway/quota_reset.go`、`ctl/scripts/`。

## scan_output
- 精确源码检索见本会话。

## handoff
- 脚本与运行说明已完成；只在两地各执行了单用户及 Running Bot owner 的 dry-run。非 dry-run 未在生产执行，需独立审阅目标范围、日志和 checkpoint 后由操作者显式启动。
