## goal
将 CTL `DescribePass` 云 API 的用户标识出参从 `UserId` 改为 `ExternalUserId`。

## non_goals
- 不修改请求参数、Pass 查询条件、CLGateway 路由或鉴权。
- 不兼容保留旧的 `UserId` 字段。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户要求：云 API 查询 Pass 的出参字段改为 `ExternalUserId`。

## interface_refs / data_structure_refs
- `ctl/main/api/cloudapi_handler.go`: `cloudAPIPass`、`detailToCloudAPIPass`。
- 成功响应保持腾讯云 Cloud API envelope，仅将 `Response.Pass.UserId` 改为
  `Response.Pass.ExternalUserId`。

## history_context
- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`: `DescribePass` 已返回 CTL `pass.user_id`，当前 JSON 字段名为 `UserId`。
- `superseded_refs`: 无。

## acceptance
- 成功响应包含 `ExternalUserId` 且值为 Pass 的 `user_id`。
- 成功响应不再包含 `UserId`。
- CTL Cloud API 聚焦测试及全量 Go 测试通过。

## affected_paths
- `ctl/main/api/cloudapi_handler.go`
- `ctl/main/api/cloudapi_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `control-plane-ops`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/ctl.md@b38e92f` | CTL 服务边界 | 确认公共契约验证要求 |
| `ctl/AGENTS.md@b38e92f` | CTL 局部规则 | 确认测试命令 |
| `docs/context/project/adjacency/cloudladdergateway.md@b38e92f` | 公网代理邻接 | 确认 CLGateway 仅透传，无需改动 |

## evidence
- 当前 `cloudAPIPass.UserID` 序列化为 `UserId`，值来自 `PassDetail.UserID`。
- `cloudAPIPass.ExternalUserID` 现序列化为 `ExternalUserId`，仍由 `PassDetail.UserID` 填充。
- 聚焦测试断言 `ExternalUserId=usr_cloudapi_1`，并断言响应中不存在旧 `UserId`。
- `cd ctl && go test ./...` 通过；`cd ctl && go vet ./...` 通过。

## risks
- 调用方若仍解析 `UserId` 会受影响；本次按明确要求进行不兼容字段改名。
- 回滚方式：恢复 JSON 字段名和测试断言。

## validation
- `cd ctl && go test ./main/api`
- `cd ctl && go test ./...`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 不同时返回两个字段，避免协议继续暴露语义重复字段。

## scan_scope
- `ctl/main/api`、`cloudladdergateway`、相关正式设计文档。

## scan_output
- 精确检索只命中 CTL 响应结构和测试；CLGateway 不解析响应体。

## handoff
- 当前状态：实现和 CTL 全量验证已完成，尚未提交。
