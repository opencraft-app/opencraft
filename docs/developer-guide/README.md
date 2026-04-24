# ctl 开发者指南

本目录保留 `ctl` / `sandbox` 集成的背景文档和设计说明。

说明：

- 本目录不是最新运行手册
- 本地启动、部署、发布、agent 约束以 `docs/agent-guides/` 和 `docs/deploy-guides/` 为准
- 如果背景文档与运行手册冲突，应优先修正背景文档

## 文档索引

| 文档 | 说明 |
|------|------|
| [sandbox-integration.md](./sandbox-integration.md) | `ctl` 如何接入 `sandbox` 的当前模型与关键约束 |
| [sandbox-template.md](./sandbox-template.md) | template / pool 的映射关系与联调方式 |
| [sandbox-command-execution.md](./sandbox-command-execution.md) | TAT 与 envd Process API 的命令执行方式 |
| [sandbox-runtime-agent.md](./sandbox-runtime-agent.md) | `envd`、`process.Process`、`clientproxy`、`TAT` 的职责边界与执行链路 |

## 项目概览

### 产品定位

OpenClaw SaaS 控制面 — AI Agent 运行时的托管服务后端 API。

### 技术栈

| 组件 | 技术选型 |
|------|---------|
| 语言 | Go 1.26 |
| HTTP 框架 | net/http |
| ORM | GORM |
| 数据库 | MySQL 8.0 |
| 消息队列 | Redis Streams |
| 异步任务 | goinbox/taskflow/v2 |
| 日志 | zap |
| 云 SDK | tencentcloud-sdk-go |

### 项目结构

```
ctl/
├── main/                  # 入口程序
│   ├── api/               # REST API 服务
│   ├── service/           # 异步消费者
│   ├── bypass/            # 定期任务
│   └── common/            # 共享初始化逻辑
├── pkg/
│   ├── tasks/             # 任务定义
│   ├── logic/             # 业务逻辑
│   ├── model/             # 数据模型 (Entity + DAO)
│   ├── adapter/           # 外部服务适配器
│   ├── transport/         # DTO
│   ├── context/           # 请求上下文
│   └── config/            # 配置管理
├── conf/                   # 配置文件
└── test/                   # 测试工具
```

### 分层架构

```
┌─────────────────────────────────────────┐
│             REST Handler                │  ← 路由、参数解析、JSON 响应
├─────────────────────────────────────────┤
│                Task                     │  ← 异步任务编排
├─────────────────────────────────────────┤
│                Logic                    │  ← 业务逻辑
├─────────────────────────────────────────┤
│                Model                    │  ← 数据访问
├─────────────────────────────────────────┤
│               Adapter                   │  ← 外部服务调用
└─────────────────────────────────────────┘
```

## 相关文档

- [架构设计文档](../ctl-design/architecture.md)
- [产品需求文档](../ctl-design/prd.md)
- [核心设计文档（历史归档）](../ctl-design/archive/core-design.md)
- [VPC 设计文档（历史归档）](../ctl-design/archive/vpc-design.md)
- [本地联调开发指南](../agent-guides/ctl-local-run-guide.md)
