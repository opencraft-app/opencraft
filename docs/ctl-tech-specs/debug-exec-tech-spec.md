---
title: CTL 调试性接口技术规格 — OpenClaw 版本检查
date: 2026-03-22
status: approved
version: 1.0
priority: phase-1-mvp
---

# CTL 调试性接口技术规格

## 一、需求概述

### 背景与目标
OpenClaw SaaS 控制面需要对外暴露调试性接口，支持通过沙箱 **TAT（腾讯云自动化助手）** 渠道向运行中的 OpenClaw 实例下发命令，用于：
- 检查 openclaw 安装状态
- 获取 openclaw 版本号
- 验证沙箱内关键组件运行状态
- 打通从 ctl 层到 sandbox TAT API 的完整命令执行链路

### MVP 范围
**第一阶段：单一接口验证**
- 实现 **openclaw_version** 检查命令
- 通过 TAT 下发 `openclaw --version` 脚本
- 返回命令执行结果（版本号、退出码、输出内容）

---

## 二、架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────┐
│   API Handler (HTTP Router)         │  main/api/server.go
│   POST /v1/instances/{id}/debug/exec │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Logic Layer (业务编排)             │  pkg/logic/instance/
│   CheckOpenClawVersion()             │
│   RouteDebugCommand()                │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Adapter Layer (沙箱交互)           │  pkg/adapter/sandbox/
│   ExecCommand()                      │  adapter.go
│   GetCommandResult()                 │
│   内置轮询 + 超时控制                 │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│   Sandbox Service API               │  E2B Sandbox
│   POST /sandboxes/{id}/tat/commands  │
│   GET /sandboxes/{id}/tat/commands   │
│         /{invocationID}              │
└─────────────────────────────────────┘
```

### 2.2 数据流

```
1. 客户端请求
   POST /v1/instances/{instance_id}/debug/exec
   {
     "command": "openclaw_version"
   }

2. Handler 解析 & 路由
   - 验证用户身份 (X-User-Id)
   - 验证实例归属
   - 解析命令类型

3. Logic 业务逻辑
   - 查询实例状态（必须 Running）
   - 根据命令类型映射脚本
   - 调用 adapter.ExecCommand()

4. Adapter TAT 执行
   POST /sandboxes/{sandboxID}/tat/commands
   {
     "bash": "openclaw --version"
   }
   → 获得 invocationID，状态 PENDING

5. Adapter 轮询结果
   GET /sandboxes/{sandboxID}/tat/commands/{invocationID}
   循环轮询直到 status = SUCCESS/FAILED/TIMEOUT
   - 初始延迟: 500ms
   - 指数退避: 1s, 2s, 4s, 8s, ...
   - 最长等待: 30s

6. 返回客户端
   200 OK
   {
     "code": "OK",
     "data": {
       "status": "SUCCESS",
       "exit_code": 0,
       "output": "openclaw version 1.2.3\n",
       "invocation_id": "inv-xxx"
     }
   }
```

---

## 三、API 定义

### 3.1 调试命令执行接口

**端点**
```
POST /v1/instances/{instance_id}/debug/exec
```

**请求头**
```
X-User-Id: {user_id}
X-Request-Id: {trace_id}  (可选)
Content-Type: application/json
```

**请求体**
```json
{
  "command": "openclaw_version"
}
```

**命令类型白名单（MVP）**
| 命令 | 脚本 | 用途 |
|------|------|------|
| `openclaw_version` | `openclaw --version` | 检查 openclaw 版本 |

**响应（成功）**
```
HTTP 200 OK
{
  "code": "OK",
  "message": "success",
  "data": {
    "status": "SUCCESS",
    "exit_code": 0,
    "output": "openclaw version 1.2.3\n",
    "command_id": "cmd-abc123",
    "invocation_id": "inv-def456",
    "start_time": "2026-03-22T10:30:00Z",
    "end_time": "2026-03-22T10:30:01Z"
  },
  "request_id": "{trace_id}"
}
```

**响应（错误 — 命令超时）**
```
HTTP 504 Gateway Timeout
{
  "code": "DEBUG_EXEC_TIMEOUT",
  "message": "command execution timeout after 30s",
  "request_id": "{trace_id}"
}
```

**响应（错误 — 无效命令）**
```
HTTP 400 Bad Request
{
  "code": "DEBUG_INVALID_COMMAND",
  "message": "invalid debug command: unknown_cmd",
  "request_id": "{trace_id}"
}
```

**响应（错误 — 实例状态不允许）**
```
HTTP 409 Conflict
{
  "code": "DEBUG_NOT_SUPPORTED",
  "message": "debug command not supported in Paused state",
  "request_id": "{trace_id}"
}
```

---

## 四、代码实现清单

### 4.1 Sandbox Adapter 层

**文件**: `ctl/pkg/adapter/sandbox/types.go`

```go
// 新增类型定义
type ExecCommandRequest struct {
	Bash string `json:"bash"`
}

type TATCommandResponse struct {
	SandboxID    string `json:"sandboxID"`
	PoolID       string `json:"poolID"`
	InstanceID   string `json:"instanceID"`
	Region       string `json:"region"`
	CommandID    string `json:"commandID"`
	InvocationID string `json:"invocationID"`
	Status       string `json:"status"`
}

type TATCommandResult struct {
	TATCommandResponse
	ExitCode      int64  `json:"exitCode"`
	Output        string `json:"output"`
	ErrorInfo     string `json:"errorInfo,omitempty"`
	StartTime     string `json:"startTime,omitempty"`
	EndTime       string `json:"endTime,omitempty"`
	ExecutionTime string `json:"executionTime,omitempty"`
}

// 业务层抽象（简化返回）
type ExecCommandResult struct {
	InvocationID  string
	Status        string // SUCCESS/FAILED/TIMEOUT
	ExitCode      int64
	Output        string
	ErrorInfo     string
}
```

**文件**: `ctl/pkg/adapter/sandbox/adapter.go`

添加以下方法到 `SandboxAdapter`：

```go
// ExecCommand 同步执行命令（自动轮询）
func (a *SandboxAdapter) ExecCommand(
	ctx context.Context,
	sandboxID string,
	bash string,
	timeoutSec int,
) (*ExecCommandResult, error) {
	if timeoutSec <= 0 {
		timeoutSec = 30 // 默认 30 秒
	}
	if timeoutSec > 300 {
		timeoutSec = 300 // 最多 5 分钟
	}

	// Step 1: 下发命令
	invResp := new(TATCommandResponse)
	if err := a.doRequest(
		ctx, "tat_exec", http.MethodPost,
		"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands",
		nil, &ExecCommandRequest{Bash: bash},
		http.StatusAccepted, invResp,
	); err != nil {
		return nil, err
	}

	invocationID := invResp.InvocationID
	if invocationID == "" {
		return nil, errcode.Wrap(errcode.ErrSandboxServiceError, "empty invocation id")
	}

	// Step 2: 轮询查询结果
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	pollInterval := 500 * time.Millisecond

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		if time.Now().After(deadline) {
			return &ExecCommandResult{
				InvocationID: invocationID,
				Status:       "TIMEOUT",
			}, errcode.ErrSandboxTimeout
		}

		result := new(TATCommandResult)
		if err := a.doRequest(
			ctx, "tat_query", http.MethodGet,
			"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands/"+url.PathEscape(invocationID),
			nil, nil, http.StatusOK, result,
		); err != nil {
			return nil, err
		}

		// 终态判断
		if result.Status == "SUCCESS" || result.Status == "FAILED" {
			return &ExecCommandResult{
				InvocationID: result.InvocationID,
				Status:       result.Status,
				ExitCode:     result.ExitCode,
				Output:       result.Output,
				ErrorInfo:    result.ErrorInfo,
			}, nil
		}

		// 指数退避，最多等待 8 秒
		if pollInterval < 8*time.Second {
			pollInterval *= 2
		}
		sleepWithContext(ctx, pollInterval)
	}
}

// GetCommandResult 查询单次命令执行结果（异步模式用）
func (a *SandboxAdapter) GetCommandResult(
	ctx context.Context,
	sandboxID string,
	invocationID string,
) (*ExecCommandResult, error) {
	if invocationID == "" {
		return nil, errcode.ErrSandboxInvalidParam
	}

	result := new(TATCommandResult)
	if err := a.doRequest(
		ctx, "tat_query", http.MethodGet,
		"/sandboxes/"+url.PathEscape(sandboxID)+"/tat/commands/"+url.PathEscape(invocationID),
		nil, nil, http.StatusOK, result,
	); err != nil {
		return nil, err
	}

	return &ExecCommandResult{
		InvocationID: result.InvocationID,
		Status:       result.Status,
		ExitCode:     result.ExitCode,
		Output:       result.Output,
		ErrorInfo:    result.ErrorInfo,
	}, nil
}
```

### 4.2 Transport 层

**文件**: `ctl/pkg/transport/instance.go`

```go
// 调试命令请求
type ExecDebugCommandRequest struct {
	Command string `json:"command" validate:"required,oneof=openclaw_version"`
}

// 调试命令响应
type ExecDebugCommandResponse struct {
	Status       string `json:"status"`       // SUCCESS/FAILED/TIMEOUT
	ExitCode     int64  `json:"exit_code"`
	Output       string `json:"output"`
	CommandID    string `json:"command_id"`
	InvocationID string `json:"invocation_id"`
	StartTime    string `json:"start_time,omitempty"`
	EndTime      string `json:"end_time,omitempty"`
}
```

### 4.3 Logic 层

**文件**: `ctl/pkg/logic/instance/logic.go`

添加以下方法：

```go
// 调试命令映射表
var debugCommandMap = map[string]string{
	"openclaw_version": "openclaw --version",
}

// ExecDebugCommand 执行调试命令
func (l *logic) ExecDebugCommand(
	ctx pctx.Context,
	instanceID string,
	commandType string,
) (*transport.ExecDebugCommandResponse, error) {
	if ctx == nil || strings.TrimSpace(ctx.GetUserID()) == "" {
		return nil, errcode.ErrInstanceMissingUserID
	}
	instanceID = strings.TrimSpace(instanceID)
	commandType = strings.TrimSpace(commandType)
	if instanceID == "" || commandType == "" {
		return nil, errcode.ErrInstanceInvalidParam
	}

	// 验证命令类型
	bash, ok := debugCommandMap[commandType]
	if !ok {
		return nil, errcode.Wrap(errcode.ErrDebugInvalidCommand, "unknown command: %s", commandType)
	}

	// 查询实例
	entity, err := l.instanceDao.GetByInstanceID(ctx, instanceID)
	if err != nil {
		return nil, err
	}

	// 状态检查
	if entity.Status != modelinstance.InstanceStatusRunning {
		return nil, errcode.Wrap(
			errcode.ErrDebugNotSupported,
			"debug command not supported in %s state", entity.Status,
		)
	}

	// 执行命令（30 秒超时）
	result, err := l.sandboxAdapter.ExecCommand(ctx, entity.SandboxId, bash, 30)
	if err != nil {
		if errors.Is(err, errcode.ErrSandboxTimeout) {
			return nil, errcode.Wrap(errcode.ErrDebugExecTimeout, "command execution timeout after 30s")
		}
		return nil, errcode.Wrap(errcode.ErrDebugExecFailed, "exec failed: %v", err)
	}

	return &transport.ExecDebugCommandResponse{
		Status:       result.Status,
		ExitCode:     result.ExitCode,
		Output:       result.Output,
		CommandID:    "", // TAT 响应中没有命令 ID
		InvocationID: result.InvocationID,
	}, nil
}
```

### 4.4 API Handler 层

**文件**: `ctl/main/api/server.go`

在 `newRouter()` 中注册路由：

```go
func newRouter(handler *instanceHandler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeSuccess(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/v1/instances", handler.handleInstances)
	mux.HandleFunc("/v1/instances/", handler.handleInstance)
	// 新增调试路由
	return metricsMiddleware(requestLoggingMiddleware(notFoundMiddleware(mux)))
}
```

在 `handleInstance()` 中添加分支：

```go
case len(parts) == 2 && r.Method == http.MethodPost && parts[1] == "debug":
	// 处理 /v1/instances/{id}/debug/ 前缀的子路由
	path := strings.TrimPrefix(r.URL.Path, "/v1/instances/"+instanceID+"/debug/")
	subParts := strings.Split(strings.Trim(path, "/"), "/")
	
	if len(subParts) == 1 && subParts[0] == "exec" {
		ctx, ok := newRequestContext(r)
		if !ok {
			writeHTTPError(w, r, errcode.ErrInstanceMissingUserID)
			return
		}
		var req transport.ExecDebugCommandRequest
		if err := decodeJSONBody(r, &req); err != nil {
			writeHTTPError(w, r, errcode.Wrap(errcode.ErrInstanceInvalidParam, "%s", err.Error()))
			return
		}
		resp, err := h.logic.ExecDebugCommand(ctx, instanceID, req.Command)
		if err != nil {
			writeHTTPError(w, r, err)
			return
		}
		writeSuccess(w, r, http.StatusOK, resp)
		return
	}
```

### 4.5 错误码定义

**文件**: `ctl/pkg/errcode/debug.go`（新建）

```go
package errcode

// Debug 错误码范围: 15001-15099
var (
	ErrDebugInvalidCommand = Register(New("DEBUG_INVALID_COMMAND", 400, "invalid debug command"))
	ErrDebugExecFailed     = Register(New("DEBUG_EXEC_FAILED", 500, "command execution failed"))
	ErrDebugExecTimeout    = Register(New("DEBUG_EXEC_TIMEOUT", 504, "command execution timeout"))
	ErrDebugNotSupported   = Register(New("DEBUG_NOT_SUPPORTED", 409, "debug command not supported in this instance state"))
)
```

---

## 五、测试计划

### 5.1 单元测试

```go
// ctl/test/adapter/sandbox/exec_command_test.go
func TestExecCommand_Success(t *testing.T) {
	// Mock POST /tat/commands → 202 + invocationID
	// Mock GET /tat/commands/{inv} → 200 + SUCCESS
	// 验证轮询逻辑和超时控制
}

func TestExecCommand_Timeout(t *testing.T) {
	// Mock GET 始终返回 PENDING
	// 验证超时后返回 ErrSandboxTimeout
}

func TestExecCommand_Failed(t *testing.T) {
	// Mock GET 返回 FAILED + exitCode != 0
	// 验证结果正确包含错误信息
}
```

### 5.2 集成测试

```bash
# 本地联调步骤
1. 启动 sandbox 服务（kubectl port-forward）
2. 创建测试 sandbox
3. 调用 ctl debug 接口
4. 验证返回版本号

# curl 示例
curl -X POST http://localhost:9590/v1/instances/ins-xxx/debug/exec \
  -H 'X-User-Id: test-user' \
  -H 'Content-Type: application/json' \
  -d '{"command":"openclaw_version"}'
```

### 5.3 回归测试

- 现有实例操作不受影响（create/delete/pause/resume）
- 错误码注册不冲突
- 日志/追踪正确输出

---

## 六、配置与部署

### 6.1 无新增配置需求

所有功能复用现有 sandbox adapter 配置（baseUrl、apiKey、timeout 等）。

### 6.2 本地开发配置

编辑 `ctl/conf/local/common/server_conf.toml`：

```toml
[adapter.sandbox]
baseUrl = "http://127.0.0.1:18081"  # 本地 port-forward
apiKey = "your-api-key"
timeout = 60
```

---

## 七、约束与限制

| 项 | 值 | 说明 |
|----|-----|------|
| 单条脚本最大长度 | 64 KB | 继承 sandbox TAT API 限制 |
| 命令执行超时 | 30 秒（可配） | adapter 层硬编码 |
| 最大轮询次数 | ~20 次 | 指数退避，间隔最多 8s |
| 支持的实例状态 | Running 仅 | Paused/Creating/Deleted 返回 409 |
| 并发限制 | 无特殊限制 | 受 sandbox 服务限制 |

---

## 八、后续扩展（Phase 2）

- 支持更多调试命令：`python --version`、`go version`、`docker ps` 等
- 暴露异步接口：POST 立即返回 invocationID，客户端轮询 GET
- 命令审计日志：存储执行历史、输出到数据库
- 命令输出截断：超过 1MB 自动截断
- 权限控制：细粒度命令白名单管理

---

## 九、参考文档

- [Sandbox 命令执行方式](../developer-guide/sandbox-command-execution.md)
- [Sandbox OpenAPI](../ctl-sandbox-plan-design/sandbox-openapi.yaml)
- [Architecture Decision Document](./architecture.md)
- [Local Dev Setup](../ctl-dev-setup/README.md)
