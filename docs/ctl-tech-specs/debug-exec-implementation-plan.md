---
title: CTL 调试接口实现计划 — 打通 TAT 命令执行链路
date: 2026-03-22
status: ready-for-implementation
version: 1.0
---

# 实现计划：CTL 调试接口（TAT 命令执行）

## 一、快速概览

### MVP 目标
在 ctl 控制面暴露 **调试命令执行接口**，通过 sandbox 的 TAT API 向运行中的 OpenClaw 实例下发命令。

**第一阶段实现内容**：
- 在 sandbox adapter 层添加 `ExecCommand()` 和 `GetCommandResult()` 方法
- 在 logic 层添加 `ExecDebugCommand()` 业务逻辑
- 在 API handler 层注册 `POST /v1/instances/{id}/debug/exec` 路由
- 实现 openclaw_version 命令的完整链路

**预计代码量**：~400-500 行代码跨越 5 个文件

---

## 二、实现步骤（分层递进）

### 步骤 1：Sandbox Adapter 扩展

**文件**：`ctl/pkg/adapter/sandbox/types.go` 和 `adapter.go`

**任务**：
- [ ] 在 `types.go` 中添加 3 个新类型：
  - `ExecCommandRequest` 
  - `TATCommandResponse`
  - `ExecCommandResult`
  
- [ ] 在 `adapter.go` 中实现 2 个新方法：
  - `ExecCommand(ctx, sandboxID, bash, timeoutSec)` — 同步执行（含轮询）
  - `GetCommandResult(ctx, sandboxID, invocationID)` — 查询结果
  
- [ ] 实现轮询逻辑：
  - 指数退避策略：500ms → 1s → 2s → 4s → 8s
  - 超时控制：默认 30s，最大 5min
  - 终态判断：SUCCESS/FAILED 停止轮询

**关键实现点**：
```go
// 复用现有 doRequest() 方法调用 sandbox TAT API
// POST /sandboxes/{id}/tat/commands → 202 Accepted
// GET /sandboxes/{id}/tat/commands/{invocationID} → 200 OK
```

**预计代码行数**：~150 行

---

### 步骤 2：业务逻辑层实现

**文件**：`ctl/pkg/logic/instance/logic.go`

**任务**：
- [ ] 在 `logic.go` 中添加调试命令映射表：
  ```go
  var debugCommandMap = map[string]string{
      "openclaw_version": "openclaw --version",
  }
  ```

- [ ] 实现 `ExecDebugCommand(ctx, instanceID, commandType)` 方法：
  1. 验证用户身份和实例归属
  2. 查询实例，检查状态必须为 Running
  3. 根据 commandType 查表获取脚本
  4. 调用 adapter.ExecCommand()
  5. 错误映射到 errcode（超时/不支持/失败等）
  6. 返回规范化结果

**关键检查**：
- 实例存在且属于当前用户 ✓（复用 GetByInstanceID）
- 实例状态为 Running ✓（状态机检查）
- 命令类型有效 ✓（映射表查询）

**预计代码行数**：~60 行

---

### 步骤 3：Transport DTO 定义

**文件**：`ctl/pkg/transport/instance.go`

**任务**：
- [ ] 添加 2 个新类型：
  - `ExecDebugCommandRequest` — 请求体
  - `ExecDebugCommandResponse` — 响应体

**预计代码行数**：~20 行

---

### 步骤 4：错误码定义

**文件**：`ctl/pkg/errcode/debug.go`（新建）

**任务**：
- [ ] 创建新文件 `debug.go`
- [ ] 定义 4 个错误码：
  - `ErrDebugInvalidCommand` (400)
  - `ErrDebugExecFailed` (500)
  - `ErrDebugExecTimeout` (504)
  - `ErrDebugNotSupported` (409)

**预计代码行数**：~15 行

---

### 步骤 5：API Handler 注册

**文件**：`ctl/main/api/server.go`

**任务**：
- [ ] 在 `handleInstance()` 方法中添加新分支处理：
  ```
  POST /v1/instances/{id}/debug/exec
  ```

- [ ] 实现 handler 逻辑：
  1. 解析 instance_id
  2. 验证请求头和请求体
  3. 调用 logic.ExecDebugCommand()
  4. 返回响应或错误

**关键点**：
- 复用现有的 `newRequestContext()` 获取用户身份
- 复用现有的 `decodeJSONBody()` 和 `writeSuccess/writeHTTPError()`
- 遵循现有的 handler 写法模式

**预计代码行数**：~30 行

---

## 三、测试计划

### 单元测试

**文件**：`ctl/test/adapter/sandbox/exec_command_test.go`（新建）

```go
func TestExecCommand_Success(t *testing.T) {
    // 场景 1：命令成功执行
    // Mock: POST → 202, GET → 200 SUCCESS
    // 验证：返回 ExecCommandResult 包含 output
}

func TestExecCommand_Failed(t *testing.T) {
    // 场景 2：命令执行失败
    // Mock: GET → 200 FAILED, exitCode != 0
    // 验证：返回错误信息但不返回 error
}

func TestExecCommand_Timeout(t *testing.T) {
    // 场景 3：轮询超时
    // Mock: GET 始终返回 PENDING
    // 验证：返回 ErrSandboxTimeout
}

func TestExecCommand_Retry(t *testing.T) {
    // 场景 4：指数退避轮询
    // 验证：首次 500ms，后续 1s/2s/4s/8s
}
```

**文件**：`ctl/test/logic/instance/debug_command_test.go`（新建）

```go
func TestExecDebugCommand_ValidCommand(t *testing.T) {
    // 场景 1：有效命令
    // Mock: 实例存在，状态 Running，adapter 返回成功
    // 验证：返回结果正确
}

func TestExecDebugCommand_InvalidCommand(t *testing.T) {
    // 场景 2：无效命令
    // 验证：返回 ErrDebugInvalidCommand
}

func TestExecDebugCommand_WrongStatus(t *testing.T) {
    // 场景 3：实例非 Running 状态
    // 验证：返回 ErrDebugNotSupported
}

func TestExecDebugCommand_InstanceNotFound(t *testing.T) {
    // 场景 4：实例不存在
    // 验证：返回 ErrInstanceNotFound
}
```

### 集成测试

**本地联调步骤**：
```bash
# 1. 启动 sandbox 服务本地 port-forward
kubectl port-forward -n sandbox svc/sandbox-api 18081:80

# 2. 配置 ctl 连接到本地 sandbox
# 编辑 ctl/conf/local/common/server_conf.toml
[adapter.sandbox]
baseUrl = "http://127.0.0.1:18081"

# 3. 启动 ctl 服务
cd ctl && go run ./main/api

# 4. 创建测试 instance（先创建实例）
INSTANCE_ID=$(curl -s -X POST http://localhost:9590/v1/instances \
  -H 'X-User-Id: test-user' \
  -H 'Content-Type: application/json' \
  -d '{}' | jq -r '.data.instance_id')

# 5. 等待实例 Running（预留 30s）
sleep 30

# 6. 执行调试命令
curl -X POST http://localhost:9590/v1/instances/$INSTANCE_ID/debug/exec \
  -H 'X-User-Id: test-user' \
  -H 'Content-Type: application/json' \
  -d '{"command":"openclaw_version"}' | jq .

# 预期响应
{
  "code": "OK",
  "message": "success",
  "data": {
    "status": "SUCCESS",
    "exit_code": 0,
    "output": "openclaw version 1.2.3\n",
    "invocation_id": "inv-xxx"
  }
}
```

### 回归测试

- [ ] 现有 POST /v1/instances 创建流程无变化
- [ ] 现有 GET /v1/instances/{id} 查询无变化
- [ ] 现有 DELETE /v1/instances/{id} 删除无变化
- [ ] 现有 POST /v1/instances/{id}/pause 暂停无变化
- [ ] 现有 POST /v1/instances/{id}/resume 恢复无变化
- [ ] 错误码注册无冲突（debug 范围 15001-15099）

---

## 四、代码审查清单

### Adapter 层审查
- [ ] ExecCommand() 轮询逻辑正确
  - [ ] 初始等待 500ms ✓
  - [ ] 指数退避 ≤ 8s ✓
  - [ ] 超时判断基于 deadline ✓
  - [ ] context cancellation 正确处理 ✓
  
- [ ] 错误处理完整
  - [ ] 网络错误映射 ✓
  - [ ] 超时错误返回 errcode.ErrSandboxTimeout ✓
  - [ ] 空 invocationID 处理 ✓

### Logic 层审查
- [ ] 状态检查严格
  - [ ] 仅允许 Running 状态 ✓
  - [ ] 返回适当错误码 ✓
  
- [ ] 命令映射完整
  - [ ] openclaw_version 定义正确 ✓
  - [ ] 非白名单命令拒绝 ✓

### Handler 层审查
- [ ] 路由注册正确
  - [ ] 路径 `/v1/instances/{id}/debug/exec` ✓
  - [ ] 方法 POST ✓
  
- [ ] 请求验证完整
  - [ ] X-User-Id 必须 ✓
  - [ ] command 字段必须 ✓
  - [ ] 无多余参数 ✓

### 测试覆盖
- [ ] 单元测试：adapter 轮询逻辑 ✓
- [ ] 单元测试：logic 命令验证 ✓
- [ ] 单元测试：handler 请求解析 ✓
- [ ] 集成测试：完整链路 ✓

---

## 五、交付清单

### 代码文件
- [ ] `ctl/pkg/adapter/sandbox/types.go` — 新增类型
- [ ] `ctl/pkg/adapter/sandbox/adapter.go` — 新增方法 (ExecCommand, GetCommandResult)
- [ ] `ctl/pkg/adapter/sandbox/adapter_test.go` — 单元测试
- [ ] `ctl/pkg/logic/instance/logic.go` — 新增方法 (ExecDebugCommand)
- [ ] `ctl/pkg/logic/instance/logic_test.go` — 单元测试
- [ ] `ctl/pkg/transport/instance.go` — 新增 DTO
- [ ] `ctl/pkg/errcode/debug.go` — 新建错误码 ✓（已在规格中定义）
- [ ] `ctl/main/api/server.go` — 新增 handler 分支

### 文档
- [ ] `_bmad-output/planning-artifacts/debug-exec-tech-spec.md` ✓（已完成）
- [ ] `_bmad-output/planning-artifacts/debug-exec-implementation-plan.md` ✓（本文件）
- [ ] 本地联调指南（集成到 `docs/ctl-dev-setup/README.md`）

### 测试
- [ ] `ctl/test/adapter/sandbox/exec_command_test.go` — 新建 adapter 单元测试
- [ ] `ctl/test/logic/instance/debug_command_test.go` — 新建 logic 单元测试
- [ ] 集成测试脚本：`ctl/test/debug_exec_integration_test.sh`（可选）

---

## 六、时间估计与优先级

| 任务 | 预计工作量 | 优先级 |
|------|----------|--------|
| Adapter 层实现 + 单元测试 | 2-3h | P0 |
| Logic 层实现 + 单元测试 | 1-2h | P0 |
| Transport DTO | 0.5h | P0 |
| 错误码定义 | 0.25h | P0 |
| Handler 注册 | 1h | P0 |
| 集成测试 & 调试 | 2-3h | P1 |
| **总计** | **7-9.5h** | — |

**建议拆分**：
- Day 1 上午：完成 Adapter + Logic 实现
- Day 1 下午：Handler 注册 + 单元测试
- Day 2 上午：集成测试 & 联调

---

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Sandbox TAT API 延迟高 | 用户等待时间长 | 默认 30s 超时可接受；Phase 2 支持异步 |
| 轮询丢失中间状态 | 无法诊断慢速命令 | 通过 GetCommandResult() 支持手动查询；Phase 2 完整状态追踪 |
| 命令输出超大 | OOM 风险 | Phase 2 添加输出截断（≤1MB）；当前无输出 |
| 权限管理缺失 | 安全风险 | Phase 2 实现命令白名单细粒度管理；当前仅限内部调试 |

---

## 八、后续扩展（Phase 2+）

### 短期（1-2 周）
- [ ] 支持更多调试命令
  - `python --version`
  - `go version`
  - `docker ps`
  - `systemctl status openclaw`
  
- [ ] 暴露异步接口
  - POST 返回 invocationID，客户端轮询
  - 无需等待 30s

### 中期（1-2 月）
- [ ] 命令审计日志
  - 存储到 operation_histories 表
  - 支持查询历史执行记录
  
- [ ] 命令输出管理
  - 截断超过 1MB 的输出
  - 存储到 COS
  
- [ ] 权限管理
  - 细粒度命令白名单
  - 命令执行日志外审

### 长期（Backlog）
- [ ] 集成 Shell 终端
  - 支持交互式命令（stdin/stdout）
  - 基于 envd Process API
  
- [ ] 性能监控命令
  - `top`, `free`, `df` 等系统命令
  - 返回结构化指标

---

## 九、成功标准

✅ **MVP 完成标准**：
1. 单元测试通过率 ≥ 95%
2. 集成测试通过（本地 port-forward 链路）
3. 技术规格文档完整准确
4. 代码审查 approved
5. 现有接口回归测试全过

✅ **上线标准**：
1. 以上所有条件
2. 生产环境集成测试通过
3. 性能基准：响应时间 ≤ 35s（30s 超时 + 5s 余量）
4. 错误处理完整（4 个错误码都被覆盖）

---

## 参考资源

- [CTL 调试接口技术规格](./debug-exec-tech-spec.md)
- [Sandbox 命令执行方式](../developer-guide/sandbox-command-execution.md)
- [CTL 本地开发指南](../ctl-dev-setup/README.md)
- [现有 API 实现参考](../../ctl/main/api/server.go)
- [Adapter 层参考](../../ctl/pkg/adapter/sandbox/adapter.go)
- [Logic 层参考](../../ctl/pkg/instance/logic.go)
