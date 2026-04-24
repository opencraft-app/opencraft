---
title: 'CTL 集成 AI-Gateway Provision 自动下发大模型配置'
slug: 'ctl-ai-gateway-provision'
created: '2026-03-23'
status: 'implementation-complete'
stepsCompleted: [1, 2, 3, 4]
tech_stack: [Go 1.21+, TOML (BurntSushi), Shell/TAT, gin (ai-gateway), net/http (ctl adapter)]
files_to_modify:
  - ctl/pkg/adapter/aigateway/adapter.go (新建)
  - ctl/pkg/adapter/aigateway/types.go (新建)
  - ctl/pkg/adapter/factory/adapter.go (修改: 注册 AiGatewayAdapter)
  - ctl/pkg/config/define.go (修改: 增加 AiGateway 配置结构)
  - ctl/pkg/config/config.go (修改: 解析 AiGateway 配置)
  - ctl/pkg/instance/async.go (修改: RunCreateInstanceTask 插入 provision + onboard)
  - ctl/pkg/instance/logic.go (修改: logic 结构体注入 aiGatewayAdapter)
  - ctl/conf/common/server_conf.toml (修改: 增加 [adapter.aigateway] 配置段)
code_patterns:
  - 'Adapter 工厂模式: AdapterFactory 接口 + sync.Once 单例懒初始化'
  - 'SandboxAdapter 自建 HTTP client + doRequest 方法封装重试/日志/metrics/tracing'
  - 'SandboxAdapter.ExecCommand: TAT 命令提交 + 轮询结果，tatShellPrefix 注入环境'
  - 'logic 结构体: 通过 NewLogic() 构造，从 adapterfactory.DefaultAdapterFactory 获取 adapter'
  - 'config: TOML → GlobalConfig.AdapterConfig 子结构，parseAdapterConf() 设默认值'
test_patterns:
  - 'ctl 目前无 adapter 层单测文件，业务层有 NewLogicForTest() 支持依赖注入'
---

# Tech-Spec: CTL 集成 AI-Gateway Provision 自动下发大模型配置

**Created:** 2026-03-23

## Overview

### Problem Statement

用户购买实例后，需要手动配置大模型 API（API Key、Base URL、模型 ID 等）才能使用 OpenClaw 的 AI 功能。当前 CTL 和 AI-Gateway 之间没有任何集成，用户体验断裂。

### Solution

在 CTL 的实例创建异步任务中，沙箱创建成功后、instance 标记为 Running 之前，增加两个步骤：
1. 调用 AI-Gateway 的 `POST /api/admin/provision` 获取用户的 API Key
2. 通过 TAT 命令执行 `openclaw onboard` 将大模型配置下发到沙箱

新增 `aigateway` adapter，遵循已有的 adapter 工厂模式。

### Scope

**In Scope:**
- 新建 `ctl/pkg/adapter/aigateway/` 适配器（接口 + 实现）
- 在 AdapterFactory 中注册 AiGatewayAdapter
- 在 TOML 配置中增加 ai-gateway 相关配置项
- 在 `RunCreateInstanceTask` 中插入 provision + onboard 步骤
- instance 状态流转：沙箱 Running → provision → TAT onboard → instance Running
- 记录技术债：ai-gateway provision 响应中尚缺的 onboard 参数

**Out of Scope:**
- AI-Gateway 端的 API 修改（API 未定型，先对接现有接口）
- Admin 鉴权（后续会去掉，当前不实现）
- 联调/端到端测试（先实现框架，不需要调试通过）
- provision 失败的补偿机制（后续迭代）

## Context for Development

### Codebase Patterns

- **Adapter 工厂模式**：`AdapterFactory` 接口声明各 adapter getter，`adapterFactory` 结构体用 `sync.Once` 懒初始化。新 adapter 需：1) 在接口加方法 2) 在结构体加 `xxxOnce sync.Once` + `xxx Adapter` 字段 3) 实现 getter
- **Adapter 实现模式**：SandboxAdapter 不使用 `client.Client` 基类，而是自建 `http.Client` + 私有 `doRequest()` 方法，封装了重试(指数退避)、日志、metrics、tracing。AI-Gateway adapter 采用更轻量的方式（功能单一）
- **TAT 命令执行**：`sandboxAdapter.ExecCommand(ctx, sandboxID, bash, timeoutSec)` 自动注入 `tatShellPrefix`（加载 nvm/pnpm 环境），提交命令后轮询结果直到 SUCCESS/FAILED/TIMEOUT
- **配置管理**：TOML → `GlobalConfig.AdapterConfig` 子结构，`parseAdapterConf()` 在 `Init()` 中调用设默认值
- **logic 依赖注入**：`logic` 结构体在 `NewLogic()` 中从 `adapterfactory.DefaultAdapterFactory` 获取 adapter，测试通过 `NewLogicForTest()` 注入 mock

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `ctl/pkg/adapter/sandbox/adapter.go` | 参考 adapter 实现模式（自建 httpClient + doRequest + 重试/日志/tracing） |
| `ctl/pkg/adapter/sandbox/types.go` | 参考类型定义模式（Request/Response 结构体） |
| `ctl/pkg/adapter/factory/adapter.go` | 适配器工厂：AdapterFactory 接口 + sync.Once 单例 |
| `ctl/pkg/config/define.go:117` | `AdapterConfig` 结构体，需增加 AiGateway 子项 |
| `ctl/pkg/config/config.go:86` | `parseAdapterConf()` 解析逻辑 |
| `ctl/pkg/instance/async.go:176` | `RunCreateInstanceTask` —— 沙箱创建后的插入点 |
| `ctl/pkg/instance/logic.go:63` | `logic` 结构体定义，需增加 `aiGatewayAdapter` 字段 |
| `ctl/pkg/instance/logic.go:78` | `NewLogic()` 构造函数，需注入 aiGatewayAdapter |
| `ai-gateway/internal/handler/admin_provision.go` | Provision API：`POST /api/admin/provision`，请求体 `{phone, external_uid, plan_name}`，响应 `{user, subscription, api_key}` |
| `ai-gateway/internal/service/provision_service.go` | Provision 业务：幂等按 phone 查/建用户 → 订阅 plan → 生成 API key |
| `images/helpers/config-llm-api.sh:248` | openclaw onboard 命令完整参数模板 |

### Technical Decisions

1. **不实现 Admin 鉴权**：AI-Gateway 的 admin 鉴权后续会去掉，当前直接调用
2. **user_id 映射**：CTL 的 `ctx.GetUserID()` 作为 `external_uid` 传给 AI-Gateway
3. **K8s 内部通信**：`http://ai-gateway.{namespace}.svc.cluster.local:{port}` 通过 TOML 配置注入
4. **框架先行**：AI-Gateway API 未定型，先实现调用框架，参数缺失的记技术债
5. **onboard 参数来源**：预期从 ai-gateway 获取用户分配的 Provider 信息；当前 provision 响应仅返回 `api_key`，缺少 `base_url`、`model_id`、`compatibility` 三个字段，记为技术债。`gateway_port` 和 `provider_id` 是沙箱本地配置，由 CTL 侧决定，无需 ai-gateway 提供
6. **轻量 adapter 设计**：aigateway adapter 只有 Provision 一个方法，比 SandboxAdapter 更简洁

## Implementation Plan

### Tasks

- [x] **Task 1: 新建 AI-Gateway 配置结构**
  - File: `ctl/pkg/config/define.go`
  - Action: 在 `AdapterConfig` 结构体（第 118 行附近）中增加 `AiGateway` 子项：
    ```go
    AiGateway *AiGatewayConfig `toml:"aigateway"`
    ```
    在 `SandboxConfig` 附近新增 `AiGatewayConfig` 结构体：
    ```go
    // AiGatewayConfig AI-Gateway 适配器配置
    type AiGatewayConfig struct {
        BaseURL  string `toml:"base_url"`   // K8s 内部地址，如 http://ai-gateway.ai.svc.cluster.local:8080
        Timeout  int    `toml:"timeout"`     // 请求超时（秒），默认 10
        PlanName string `toml:"plan_name"`   // provision 使用的计划名称
        // 以下为技术债：等 ai-gateway 响应完善后从响应读取，届时移除这些配置
        DefaultBaseURL       string `toml:"default_base_url"`       // 临时：大模型 API Base URL
        DefaultModelID       string `toml:"default_model_id"`       // 临时：模型 ID
        DefaultCompatibility string `toml:"default_compatibility"`  // 临时：兼容模式 openai|anthropic
        DefaultGatewayPort   int    `toml:"default_gateway_port"`   // openclaw gateway 本地端口，默认 18789
        DefaultProviderID    string `toml:"default_provider_id"`    // provider 标识，默认自动生成
    }
    ```
  - Notes: `DefaultBaseURL`/`DefaultModelID`/`DefaultCompatibility` 是临时方案，等 ai-gateway provision 响应增加这些字段后，改从响应读取并移除配置项

- [x] **Task 2: 配置解析默认值**
  - File: `ctl/pkg/config/config.go`
  - Action: 在 `parseAdapterConf()` 函数末尾（第 107 行之后）增加 AiGateway 配置解析：
    ```go
    if ServerConf.AdapterConfig.AiGateway == nil {
        ServerConf.AdapterConfig.AiGateway = &AiGatewayConfig{}
    }
    if ServerConf.AdapterConfig.AiGateway.Timeout <= 0 {
        ServerConf.AdapterConfig.AiGateway.Timeout = 10
    }
    if ServerConf.AdapterConfig.AiGateway.DefaultGatewayPort <= 0 {
        ServerConf.AdapterConfig.AiGateway.DefaultGatewayPort = 18789
    }
    if ServerConf.AdapterConfig.AiGateway.DefaultCompatibility == "" {
        ServerConf.AdapterConfig.AiGateway.DefaultCompatibility = "openai"
    }
    ```

- [x] **Task 3: 新建 AI-Gateway Adapter 类型定义**
  - File: `ctl/pkg/adapter/aigateway/types.go` (新建)
  - Action: 定义请求/响应结构体：
    ```go
    package aigateway

    // ProvisionRequest 调用 AI-Gateway POST /api/admin/provision 的请求体
    type ProvisionRequest struct {
        Phone       string `json:"phone"`
        ExternalUID string `json:"external_uid"`
        Nickname    string `json:"nickname,omitempty"`
        PlanName    string `json:"plan_name"`
    }

    // ProvisionResponse AI-Gateway provision 的响应体（data 字段）
    type ProvisionResponse struct {
        User         ProvisionUser         `json:"user"`
        Subscription ProvisionSubscription `json:"subscription"`
        APIKey       string                `json:"api_key"`
        // 技术债：后续 ai-gateway 应增加以下字段
        // BaseURL       string `json:"base_url"`
        // ModelID       string `json:"model_id"`
        // Compatibility string `json:"compatibility"`
    }

    // ProvisionUser provision 响应中的用户信息
    type ProvisionUser struct {
        ID          string `json:"id"`
        Phone       string `json:"phone"`
        ExternalUID string `json:"external_uid"`
        Nickname    string `json:"nickname"`
        Status      string `json:"status"`
    }

    // ProvisionSubscription provision 响应中的订阅信息
    type ProvisionSubscription struct {
        ID           string `json:"id"`
        UserID       string `json:"user_id"`
        PlanID       string `json:"plan_id"`
        TokenBalance int64  `json:"token_balance"`
        ExpiresAt    string `json:"expires_at"`
    }

    // apiResponse 包装 AI-Gateway 的标准响应格式
    type apiResponse struct {
        Code    int             `json:"code"`
        Message string          `json:"message"`
        Data    json.RawMessage `json:"data"`
    }
    ```
  - Notes: `apiResponse` 用于先解外层，再解 `Data` 到 `ProvisionResponse`；需 `import "encoding/json"`

- [x] **Task 4: 新建 AI-Gateway Adapter 实现**
  - File: `ctl/pkg/adapter/aigateway/adapter.go` (新建)
  - Action: 实现轻量 adapter：
    ```go
    package aigateway

    import (
        "bytes"
        "context"
        "encoding/json"
        "fmt"
        "io"
        "net"
        "net/http"
        "time"

        "ctl/pkg/config"
        "go.uber.org/zap"
    )

    // Adapter 定义 AI-Gateway 对外暴露的操作接口
    type Adapter interface {
        // Provision 调用 AI-Gateway 为用户创建账号、订阅计划并生成 API Key
        Provision(ctx context.Context, req *ProvisionRequest) (*ProvisionResponse, error)
    }

    // AiGatewayAdapter AI-Gateway HTTP 适配器
    type AiGatewayAdapter struct {
        baseURL    string
        httpClient *http.Client
        logger     *zap.Logger
    }

    // NewAiGatewayAdapter 创建 AI-Gateway 适配器
    func NewAiGatewayAdapter(conf *config.AiGatewayConfig, logger *zap.Logger) *AiGatewayAdapter {
        if conf == nil {
            conf = &config.AiGatewayConfig{}
        }
        if logger == nil {
            logger = zap.NewNop()
        }

        timeout := time.Duration(conf.Timeout) * time.Second
        if conf.Timeout <= 0 {
            timeout = 10 * time.Second
        }

        return &AiGatewayAdapter{
            baseURL: strings.TrimRight(conf.BaseURL, "/"),
            httpClient: &http.Client{
                Timeout: timeout,
                Transport: &http.Transport{
                    DialContext: (&net.Dialer{
                        Timeout:   timeout,
                        KeepAlive: 30 * time.Second,
                    }).DialContext,
                    MaxIdleConns:        5,
                    MaxIdleConnsPerHost: 5,
                    IdleConnTimeout:     30 * time.Second,
                },
            },
            logger: logger.With(zap.String("component", "aigateway-adapter")),
        }
    }

    // Provision 调用 POST /api/admin/provision
    func (a *AiGatewayAdapter) Provision(ctx context.Context, req *ProvisionRequest) (*ProvisionResponse, error) {
        if a.baseURL == "" {
            return nil, fmt.Errorf("ai-gateway base_url not configured")
        }

        body, err := json.Marshal(req)
        if err != nil {
            return nil, fmt.Errorf("marshal provision request: %w", err)
        }

        url := a.baseURL + "/api/admin/provision"
        httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
        if err != nil {
            return nil, fmt.Errorf("create provision request: %w", err)
        }
        httpReq.Header.Set("Content-Type", "application/json")
        httpReq.Header.Set("Accept", "application/json")

        start := time.Now()
        resp, err := a.httpClient.Do(httpReq)
        duration := time.Since(start)

        if err != nil {
            a.logger.Warn("ai-gateway provision request failed",
                zap.String("url", url),
                zap.Duration("duration", duration),
                zap.Error(err),
            )
            return nil, fmt.Errorf("provision request failed: %w", err)
        }
        defer resp.Body.Close()

        respBody, err := io.ReadAll(resp.Body)
        if err != nil {
            return nil, fmt.Errorf("read provision response: %w", err)
        }

        a.logger.Info("ai-gateway provision response",
            zap.String("url", url),
            zap.Int("status", resp.StatusCode),
            zap.Duration("duration", duration),
        )

        if resp.StatusCode != http.StatusOK {
            return nil, fmt.Errorf("provision returned status %d: %s", resp.StatusCode, string(respBody))
        }

        // 解析响应：AI-Gateway 使用 response.SuccessResponse 包装，data 字段包含实际内容
        var apiResp apiResponse
        if err := json.Unmarshal(respBody, &apiResp); err != nil {
            return nil, fmt.Errorf("decode provision response: %w", err)
        }

        var result ProvisionResponse
        if err := json.Unmarshal(apiResp.Data, &result); err != nil {
            return nil, fmt.Errorf("decode provision data: %w", err)
        }

        return &result, nil
    }

    var _ Adapter = (*AiGatewayAdapter)(nil)
    ```
  - Notes: 不需要重试逻辑（上层业务对 provision 失败采用 warn + 不阻断策略）；需补充 `import "strings"`

- [x] **Task 5: 在 AdapterFactory 注册 AiGatewayAdapter**
  - File: `ctl/pkg/adapter/factory/adapter.go`
  - Action:
    1. 增加 import：`"ctl/pkg/adapter/aigateway"`
    2. 在 `AdapterFactory` 接口增加：`AiGatewayAdapter() aigateway.Adapter`
    3. 在 `adapterFactory` 结构体增加两个字段：
       ```go
       aigatewayOnce sync.Once
       aigateway     aigateway.Adapter
       ```
    4. 实现 getter 方法：
       ```go
       // AiGatewayAdapter ...
       func (f *adapterFactory) AiGatewayAdapter() aigateway.Adapter {
           f.aigatewayOnce.Do(func() {
               f.aigateway = aigateway.NewAiGatewayAdapter(
                   config.ServerConf.AdapterConfig.AiGateway, resource.ZapLogger)
           })
           return f.aigateway
       }
       ```

- [x] **Task 6: logic 结构体注入 aiGatewayAdapter**
  - File: `ctl/pkg/instance/logic.go`
  - Action:
    1. 增加 import：`aigateway "ctl/pkg/adapter/aigateway"`
    2. 在 `logic` 结构体（第 63 行）增加字段：
       ```go
       aiGatewayAdapter aigateway.Adapter
       ```
    3. 在 `NewLogic()`（第 78 行）中初始化：
       ```go
       aiGatewayAdapter: adapterfactory.DefaultAdapterFactory.AiGatewayAdapter(),
       ```
    4. 在 `NewLogicForTest()` 签名中增加 `aiGatewayAdapter aigateway.Adapter` 参数并赋值到结构体

- [x] **Task 7: 实现 provision + onboard 逻辑**
  - File: `ctl/pkg/instance/async.go`
  - Action: 在 `RunCreateInstanceTask` 中，沙箱创建成功、唯一性校验通过之后、`UpdateSandboxAndStatus` 之前（约第 208 行前），插入 provision + onboard 逻辑：

    **新增私有方法 A — `provisionAiGateway`：**
    ```go
    // provisionAiGateway 调用 AI-Gateway 为用户创建账号并获取 API Key
    func (l *logic) provisionAiGateway(ctx pctx.Context, userID, instanceID string) (*aigateway.ProvisionResponse, error) {
        if l.aiGatewayAdapter == nil {
            return nil, fmt.Errorf("aiGatewayAdapter not configured")
        }
        req := &aigateway.ProvisionRequest{
            Phone:       userID, // 技术债：暂用 userID，待统一 user_id 体系后调整
            ExternalUID: userID,
            PlanName:    config.ServerConf.AdapterConfig.AiGateway.PlanName,
        }
        resp, err := l.aiGatewayAdapter.Provision(ctx, req)
        if err != nil {
            return nil, fmt.Errorf("ai-gateway provision: %w", err)
        }
        l.logger.Info("ai-gateway provision succeeded",
            zap.String("instance_id", instanceID),
            zap.String("user_id", userID),
            zap.String("gw_user_id", resp.User.ID),
        )
        return resp, nil
    }
    ```

    **新增私有方法 B — `configureOnboard`：**
    ```go
    // configureOnboard 通过 TAT 命令在沙箱中执行 openclaw onboard 下发大模型配置
    func (l *logic) configureOnboard(ctx pctx.Context, sandboxID string, provisionResp *aigateway.ProvisionResponse) error {
        if provisionResp == nil || strings.TrimSpace(provisionResp.APIKey) == "" {
            return fmt.Errorf("provision response missing api_key")
        }

        gwConf := config.ServerConf.AdapterConfig.AiGateway
        baseURL := gwConf.DefaultBaseURL       // 技术债：后续从 provisionResp 读取
        modelID := gwConf.DefaultModelID       // 技术债：后续从 provisionResp 读取
        compat := gwConf.DefaultCompatibility  // 技术债：后续从 provisionResp 读取
        gwPort := gwConf.DefaultGatewayPort
        providerID := gwConf.DefaultProviderID

        // 如果关键参数缺失，跳过 onboard（仅记日志）
        if baseURL == "" || modelID == "" {
            l.logger.Warn("onboard skipped: default_base_url or default_model_id not configured",
                zap.String("sandbox_id", sandboxID),
            )
            return nil
        }

        // 如果未配置 provider_id，用 base_url 前 8 位 hash
        if providerID == "" {
            providerID = fmt.Sprintf("custom-%x", sha256.Sum256([]byte(baseURL)))[:15]
        }

        cmd := fmt.Sprintf(
            `openclaw onboard --non-interactive --accept-risk `+
                `--mode local `+
                `--auth-choice custom-api-key `+
                `--custom-base-url '%s' `+
                `--custom-model-id '%s' `+
                `--custom-api-key '%s' `+
                `--custom-compatibility '%s' `+
                `--custom-provider-id '%s' `+
                `--gateway-port %d `+
                `--gateway-bind loopback `+
                `--skip-channels --skip-skills --skip-health`,
            baseURL, modelID, provisionResp.APIKey, compat, providerID, gwPort,
        )

        result, err := l.sandboxAdapter.ExecCommand(ctx, sandboxID, cmd, 60)
        if err != nil {
            return fmt.Errorf("exec onboard command: %w", err)
        }
        if result.Status != "SUCCESS" {
            return fmt.Errorf("onboard command status=%s exitCode=%d output=%s",
                result.Status, result.ExitCode, result.Output)
        }

        l.logger.Info("openclaw onboard configured successfully",
            zap.String("sandbox_id", sandboxID),
            zap.String("provider_id", providerID),
        )
        return nil
    }
    ```

    **修改 `RunCreateInstanceTask` 流程：**
    在第 207 行（`duplicateSandboxID` 检查通过之后）、第 208 行（`UpdateSandboxAndStatus`）之前插入：
    ```go
    // --- AI-Gateway Provision + OpenClaw Onboard ---
    provisionResp, provisionErr := l.provisionAiGateway(ctx, ctx.GetUserID(), payload.InstanceID)
    if provisionErr != nil {
        l.logger.Warn("ai-gateway provision failed, instance will be created without LLM config",
            zap.Error(provisionErr),
            zap.String("instance_id", payload.InstanceID),
        )
    }
    if provisionResp != nil {
        if onboardErr := l.configureOnboard(ctx, sandboxResp.SandboxID, provisionResp); onboardErr != nil {
            l.logger.Warn("openclaw onboard configuration failed",
                zap.Error(onboardErr),
                zap.String("instance_id", payload.InstanceID),
                zap.String("sandbox_id", sandboxResp.SandboxID),
            )
        }
    }
    ```
    然后正常执行 `UpdateSandboxAndStatus` 将 instance 设为 Running。

  - Notes: 需增加 import `"crypto/sha256"` 和 `aigateway "ctl/pkg/adapter/aigateway"`

- [x] **Task 8: TOML 配置文件**
  - File: `ctl/conf/server/common/server_conf.toml` 和 `ctl/conf/test/rewrite/server_conf_rewrite.toml`（如已有）
  - Action: 增加 `[adapter.aigateway]` 配置段：
    ```toml
    [adapter.aigateway]
    base_url = ""
    timeout = 10
    plan_name = "default"
    # 临时配置：等 ai-gateway provision 响应完善后移除
    default_base_url = ""
    default_model_id = ""
    default_compatibility = "openai"
    default_gateway_port = 18789
    default_provider_id = ""
    ```
  - Notes: 测试环境的 rewrite 配置中需填入实际的 K8s Service 地址（`http://ai-gateway.{namespace}.svc.cluster.local:{port}`）

### Acceptance Criteria

- [ ] AC 1: Given ctl 代码已编译，when 检查 `ctl/pkg/adapter/aigateway/` 包，then 存在 `Adapter` 接口和 `AiGatewayAdapter` 实现，`Provision` 方法签名正确，`go build ./...` 编译通过
- [ ] AC 2: Given `AdapterFactory` 接口，when 调用 `AiGatewayAdapter()` 方法，then 返回非 nil 的 `aigateway.Adapter` 实例（单例模式，多次调用返回同一实例）
- [ ] AC 3: Given 配置文件中 `[adapter.aigateway]` 段，when `config.Init()` 解析后，then `ServerConf.AdapterConfig.AiGateway` 非 nil，默认值正确（timeout=10, gateway_port=18789, compatibility="openai"）
- [ ] AC 4: Given `RunCreateInstanceTask` 执行到沙箱创建成功后，when ai-gateway 可达且 provision 成功，then 调用 `Provision` 获取 API key，然后通过 TAT `ExecCommand` 执行 `openclaw onboard` 命令
- [ ] AC 5: Given `RunCreateInstanceTask` 执行，when ai-gateway 不可达或 provision 失败，then 记录 warn 日志，instance 仍然正常创建为 Running 状态（不阻断主流程）
- [ ] AC 6: Given `RunCreateInstanceTask` 执行，when provision 成功但 onboard TAT 命令失败，then 记录 warn 日志，instance 仍然正常创建为 Running 状态（不阻断主流程）
- [ ] AC 7: Given `logic` 结构体，when 通过 `NewLogic()` 构造，then `aiGatewayAdapter` 字段由 `adapterfactory.DefaultAdapterFactory.AiGatewayAdapter()` 初始化
- [ ] AC 8: Given 整个 ctl 项目，when 执行 `go build ./...`，then 编译通过无错误

## Additional Context

### Dependencies

- AI-Gateway 服务需在同一 K8s 集群可达（不同命名空间，通过 K8s Service DNS 访问）
- AI-Gateway 需有有效的 plan 数据（plan_name 在 TOML 中配置）
- 沙箱需已进入 Running 状态才能执行 TAT 命令（由 `RunCreateInstanceTask` 流程保证）

### Testing Strategy

- **编译验证**：`cd ctl && go build ./...` 确保无编译错误
- **手动 Review**：Code Review 确认 adapter 模式一致性、日志规范、错误处理不阻断
- **后续集成测试**（本次不含）：待 ai-gateway API 定型且部署到同一集群后，补充端到端测试
- **可选单测**：为 `provisionAiGateway` 和 `configureOnboard` 写单测，通过 `NewLogicForTest()` 注入 mock adapter

### Notes

**技术债清单（需 AI-Gateway 侧配合）：**
- [ ] Provision 响应需增加 `base_url`：上游大模型 API 的根地址（如 `https://api.lkeap.cloud.tencent.com/coding/v3`），gateway 将请求转发到此地址
- [ ] Provision 响应需增加 `model_id`：模型标识（如 `glm-5`），对应上游 Provider 的 model name
- [ ] Provision 响应需增加 `compatibility`：兼容模式（`openai` 或 `anthropic`），gateway 据此选择协议格式
- [ ] Admin 鉴权去除或统一 service-to-service 认证
- [ ] `ProvisionRequest.Phone` 暂用 userID，待统一 user_id 体系后调整

**设计说明 — Provision 失败不阻断：**
当前设计中 provision 和 onboard 失败都不会阻断实例创建。原因：
1. AI-Gateway API 未定型，初期故障率可能较高
2. 用户可通过其他方式手动配置大模型
3. 后续可增加补偿机制（定时任务重试未配置的实例）

**临时配置说明：**
`AiGatewayConfig` 中的 `DefaultBaseURL`/`DefaultModelID`/`DefaultCompatibility`/`DefaultGatewayPort`/`DefaultProviderID` 是因为当前 ai-gateway provision 响应不含这些信息的临时方案。当 ai-gateway 侧补充后，这些配置项将被废弃，改为从 provision 响应中读取。
