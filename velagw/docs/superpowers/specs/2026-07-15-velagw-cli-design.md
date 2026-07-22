# velagw CLI 设计

## 目标

提供一个 Go + Cobra 单二进制客户端，帮助甲方人员和 Agent 理解并验收
LLMGateway。CLI 同时覆盖 trade/ctl 业务接口、运营管理接口和模型流量接口，
但以 trade/ctl 生命周期为主。

CLI 不读取环境变量、不创建配置文件、不持久化 profile。URL、token 和业务参数
全部由本次命令行调用显式传入。

## 命令拓扑

命令第一层表达调用面和认证边界，第二层表达领域对象：

```text
velagw
├── doctor
├── ctl
│   ├── tenant ensure
│   ├── tenant assignment get|set
│   ├── subscription apply|extend|cancel|get
│   ├── credit get
│   └── byok get|set|sync
├── admin
│   ├── tenant show
│   └── key create
├── traffic
│   ├── models
│   └── chat
└── scenario
    ├── trade-lifecycle
    ├── onboard
    ├── renew
    ├── cancel
    ├── byok
    └── full
```

`ctl` 只使用 `--internal-token`，`admin` 只使用 `--admin-token`，`traffic`
只使用 `--api-key`。`scenario` 根据包含的步骤显式校验所需 token，不允许用高权限
token 隐式替代低权限 token。

## 参数和输出

根命令只保存本次进程的连接参数：

- `--control-url`
- `--traffic-url`
- `--internal-token`
- `--admin-token`
- `--api-key`
- `--timeout`
- `--output table|json`
- `--verbose`
- `--dry-run`

业务参数只定义在最窄的具体命令上。默认输出中文步骤和结果摘要，`-o json`
输出稳定 JSON。verbose 输出方法、脱敏路径、状态码和耗时，不输出 token。业务失败
返回非零退出码。dry-run 只展示调用计划，不发 HTTP 请求。

## 代码边界

```text
cmd/velagw/             进程入口，只处理 signal 和退出码
internal/client/        DTO、认证通道、HTTP transport、类型化 API client
internal/clientcli/     Cobra 命令工厂、参数校验和依赖装配
internal/clientcli/ui/  table/json/步骤输出，不发 HTTP 请求
internal/clientcli/scenario/ 跨调用面业务编排，不依赖 Cobra
```

依赖只能从入口流向命令层、场景层和 client：

- Cobra 命令不得直接拼 URL 或构造 HTTP request。
- scenario 调用类型化 client 接口，不执行 Cobra 子命令。
- transport 只处理请求、认证、超时、错误解码和 dry-run，不理解业务场景。
- UI renderer 只接收结果对象，不读取全局变量、不调用 client。
- 不使用包级可变状态；每个命令通过构造函数接收依赖。
- 每个叶子命令使用独立 options struct，`Validate` 与 `Run` 分离。

## 场景语义

- `trade-lifecycle`：ensure 用户、查询 assignment、apply subscription、查询
  subscription 和 credit、extend、再次查询、cancel、验证取消结果。
- `onboard`：ensure、apply、创建模型 Key，并输出下一条 traffic 命令。
- `renew`：apply 新订单并按需 extend 到指定 period end。
- `cancel`：取消并验证 active subscription 不再存在。
- `byok`：保存设置、提交异步同步意图、读取设置和同步状态。
- `full`：onboard、BYOK、签发 Key、models、chat、credit 的完整跨面验收。

场景步骤使用统一结果模型，失败时指出步骤、HTTP 状态、服务端消息和下一步建议。
已经成功的步骤不会被伪装成整体失败，也不会在失败后继续执行有副作用步骤。

## 测试

- transport：认证通道、URL、JSON、错误解码、超时、dry-run、token 脱敏。
- typed client：每个方法的 method/path/payload 与 OpenAPI 一致。
- command：命令拓扑、required flags、输出格式和退出错误。
- scenario：调用顺序、跨面 token 校验、失败即停、结果摘要。
- smoke：使用 httptest fake control/traffic 跑 trade-lifecycle 和 full。
- 编译：`go test ./...` 和 `go build ./cmd/velagw`。
