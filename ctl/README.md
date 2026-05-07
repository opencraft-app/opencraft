# ctl - Go 云服务控制面项目模板

基于 lightglobal 裁剪而来的 Go 控制面项目脚手架，适用于需要异步编排云资源操作的 SaaS 服务开发。

Trigger note:

- 2026-04-26: README-only change to trigger the Beijing ctl image rebuild and GitOps promotion
- 2026-05-07: README-only change to rerun Beijing ctl release after DB readiness gate support landed
- 2026-05-07: README-only change to rerun Beijing ctl release after CI DB password bootstrap was prepared

## 架构概览

项目采用三服务分离架构：

```
┌──────────┐      ┌───────────────┐      ┌──────────┐
│ API 服务  │─MQ──▶│  Service 服务   │      │ Bypass   │
│ (HTTP)   │      │  (异步消费者)   │      │ (定期任务) │
└──────────┘      └───────────────┘      └──────────┘
     │                   │                      │
     └───────────────────┴──────────────────────┘
                         │
              ┌──────────┴──────────┐
              │   MySQL + Redis     │
              └─────────────────────┘
```

- **API 服务** — 接收 HTTP 请求，执行同步 Task 或发送 MQ 消息触发异步处理
- **Service 服务** — 消费 Redis Streams 消息，执行异步 Task（如多步云资源创建）
- **Bypass 服务** — 定期执行后台任务（如状态巡检、资源清理）

## 目录结构

```
ctl/
├── main/                       # 三个服务入口
│   ├── api/                    #   API 服务（REST HTTP）
│   ├── service/                #   异步消费者服务
│   ├── bypass/                 #   定期任务服务
│   └── common/                 #   共享初始化逻辑
│
├── pkg/                        # 核心代码
│   ├── logic/                  # 业务逻辑层
│   │   ├── factory/            #   Logic 工厂
│   │   ├── objectid/           #   ID 生成（Snowflake）
│   │   ├── lock/               #   分布式锁
│   │   └── common/             #   通用业务逻辑
│   │
│   ├── model/                  # 数据模型层（GORM Entity + DAO）
│   │   ├── factory/            #   Model 工厂
│   │   └── task/               #   异步任务记录模型
│   │
│   ├── tasks/                  # 异步任务框架
│   │   ├── common/             #   BaseTask、Step 配置等基础类
│   │   ├── service/            #   异步 Task（Service 消费者中执行）
│   │       └── processor/      #   消息分发处理器
│   │   └── bypass/             #   定期 Task（Bypass 中执行）
│   │
│   ├── adapter/                # 外部服务适配器
│   │   ├── factory/            #   适配器工厂接口
│   │   └── client/             #   HTTP 客户端基类
│   │
│   ├── config/                 # 配置管理（TOML 两层覆盖）
│   ├── context/                # 请求上下文（TraceID、UIN 等）
│   ├── mq/                     # 消息队列（Redis Streams）
│   ├── resource/               # 资源初始化（MySQL、Redis、日志）
│   ├── tracing/                # 分布式追踪（OpenTelemetry）
│   ├── metric/                 # 监控指标（Prometheus）
│   ├── exception/              # 异常定义
│   ├── cache/                  # 缓存逻辑
│   ├── bypass/                 # 定期任务框架
│   ├── transport/              # 数据传输对象（DTO）
│   └── util/                   # 工具函数
│
├── conf/                       # TOML 配置文件
│   └── server/
│       ├── common/             #   通用配置
│       └── rewrite/            #   覆盖配置（环境差异化）
│
├── test/                       # 测试文件
├── tools/                      # 构建脚本
├── Makefile                    # 构建入口
├── Dockerfile                  # 容器构建
├── go.mod                      # Go 依赖管理（module: ctl）
└── .golangci.yml               # 代码检查规则
```

## 核心技术栈

| 组件 | 技术选型 |
|------|---------|
| HTTP 框架 | net/http |
| ORM | GORM v1.25 |
| 数据库 | MySQL |
| 消息队列 | Redis Streams |
| 异步任务 | goinbox/taskflow/v2 (Step-based) |
| 配置管理 | TOML + 两层覆盖 |
| 监控 | Prometheus |
| 链路追踪 | OpenTelemetry |
| 服务治理 | Polaris |
| ID 生成 | Snowflake |

## 请求处理流程

### 同步请求

```
HTTP Request → REST Handler → Logic → Model/Adapter → Response
```

### 异步请求

```
HTTP Request → REST Handler → MQ.Produce(message)  → 立即返回 TaskId
                                    │
                                    ▼
                            Service 消费 MQ 消息
                                    │
                                    ▼
                            Task.Run() → Step1 → Step2 → ... → 更新 DB 状态
```

## 分层职责

| 层 | 目录 | 职责 |
|---|------|------|
| Handler | `main/api/` | 解析 REST 请求、构造上下文、返回 JSON |
| Task | `pkg/tasks/` | 编排多步操作（Step-based），管理事务和重试 |
| Logic | `pkg/logic/` | 纯业务逻辑（不感知 HTTP/MQ） |
| Model | `pkg/model/` | 数据实体定义、GORM DAO 操作 |
| Adapter | `pkg/adapter/` | 外部服务调用封装（如腾讯云 API） |

## 当前 API

当前 `instance` 能力统一走 REST JSON 接口，不再使用 `POST /?Action=...` 风格。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/v1/instances` | 创建实例（支持可选 `name`） |
| `GET` | `/v1/instances` | 查询实例列表 |
| `GET` | `/v1/instances/{instance_id}` | 查询实例详情 |
| `PUT` | `/v1/instances/{instance_id}` | 更新实例资料（当前支持名称） |
| `DELETE` | `/v1/instances/{instance_id}` | 销毁实例 |
| `POST` | `/v1/instances/{instance_id}/pause` | 暂停实例 |
| `POST` | `/v1/instances/{instance_id}/resume` | 恢复实例 |
| `POST` | `/v1/instances/{instance_id}/timeout` | 更新超时时间 |

请求头约定：

- `X-User-Id`: 用户标识
- `X-Request-Id`: 可选请求 ID

### 新增业务模块步骤

1. 在 `pkg/model/` 下创建数据模型（Entity + DAO）
2. 在 `pkg/logic/` 下实现业务逻辑
3. 在 `main/api/` 下添加 REST handler 和路由
4. 如需异步处理，在 `pkg/instance/worker/` 或 `pkg/taskruntime/` 下扩展异步任务
5. 如需定期任务，在 `pkg/tasks/bypass/` 下创建 Bypass Task

## 构建与运行

```bash
# 编译三个服务
make build

# 单独编译
make build-api
make build-service
make build-bypass

# 构建 Docker 镜像
make build-image

# 运行（需指定配置目录）
./bin/api -conf-dir ./conf/server
./bin/service -conf-dir ./conf/server
./bin/bypass -conf-dir ./conf/server
```

发布镜像现在是 **源码构建型**：

- `ctl/Dockerfile` 会在镜像构建阶段直接编译 `main/api`、`main/service`、`main/bypass`
- 正式发布前不再要求先执行 `make build` 才能让镜像吃到最新源码
- `make build` 仍保留给本地运行和手工调试使用

## 配置说明

配置采用 TOML 格式，两层覆盖机制：

- `conf/server/common/server_conf.toml` — 通用配置
- `conf/server/rewrite/server_conf_rewrite.toml` — 环境覆盖配置

关键配置项：

```toml
[Api]
Host = "0.0.0.0"
Port = 8080

[Mysql]
Host = "127.0.0.1"
Port = 3306
User = "root"
Pass = ""
DB = "ctl"

[Redis]
Host = "127.0.0.1"
Port = 6379

[MQ]
StreamKey = "ctl_mq_stream"
GroupName = "ctl_mq_group"
```

## 本地服务启动

启动前先准备 `.secret/ctl/local.env`，模板见 [local.env.example](conf/secret-templates/local.env.example)。

```bash
./conf/local/services.sh start    # 启动三服务（会自动渲染到 /tmp/mono-rendered/ctl/local）
./conf/local/services.sh status   # 看状态
./conf/local/services.sh stop     # 停掉
./conf/local/services.sh logs api # 看某个服务日志
```
