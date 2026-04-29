# Lightclaw Monorepo - 全面项目分析报告

## 目录
1. [项目简介](#项目简介)
2. [技术栈](#技术栈)
3. [目录结构](#目录结构)
4. [核心功能模块](#核心功能模块)
5. [API 端点](#api-端点)
6. [测试框架](#测试框架)
7. [部署架构](#部署架构)

---

## 项目简介

### 概述
这是 **Lightclaw** 的主 Monorepo 项目 - 一套完整的围绕"用户申请机器人实例 → 分配 sandbox 运行环境 → 通过 gateway 对外提供能力 → 前后台分别管理和使用"的系统。

### 核心价值主张
Lightclaw 是一个 **AI 平台即服务 (PaaS)** 系统，提供：
- 用户前台与营销网站
- 用户认证、邀请体系
- Bot 实例生命周期管理
- Sandbox 资源池与 Ingress 代理
- 对外统一 API 与管理后台
- AI 兼容代理（OpenAI-compatible）

### 主流程概念
```
ctl      决定"给谁分什么实例"
↓
sandbox  决定"实例怎么创建、回收、路由和执行"
↓
gateway  决定"外部怎么访问这些能力"
↓
dashboard 决定"运营和研发怎么管理系统"
↓
infra_pulumi 决定"这些东西跑在哪些云资源上"
```

### 主线服务（当前核心）
- **frontend** - 用户前台 Web (React + Vite)
- **user/auth** - 用户认证系统 (Go)
- **service-gateway** - 对外统一 API 入口 (Go)
- **sandbox** - 沙箱资源池系统 (Go)
- **nextgen-dashboard** - 管理终端 (Go + Shell CLI)
- **infra_pulumi** - 云资源基础设施即代码 (Go + Pulumi)
- **ai-gateway** - AI 兼容代理网关 (Go)
- **gateway-dashboard** - 后台管理系统 (Node.js + React)

### 当前外网地址
- **北京测试**: https://lightclaw.tech, https://admin.lightclaw.tech
- **上海 shprod**: https://api.lightclaw.cn, https://admin.lightclaw.cn, https://preview.lightclaw.cn

---

## 技术栈

### 后端技术栈
| 组件 | 技术 | 说明 |
|------|------|------|
| **语言** | Go 1.25-1.26 | 主要后端服务语言 |
| **HTTP 框架** | Gin | RESTful API 框架 |
| **ORM** | GORM v1.25+ | 数据库 ORM |
| **数据库** | MySQL / SQLite | 持久化存储 |
| **缓存/MQ** | Redis | 缓存、消息队列(Streams) |
| **ID 生成** | Snowflake | 分布式 ID |
| **监控** | Prometheus + OpenTelemetry | 指标采集与链路追踪 |
| **服务治理** | Polaris | 流量治理 |
| **异步任务** | goinbox/taskflow/v2 | Step-based 异步编排 |
| **配置管理** | TOML + 两层覆盖 | 环境差异化配置 |
| **DB Migration** | golang-migrate/migrate/v4 | SQL 版本管理 |

### 前端技术栈
| 组件 | 技术 | 说明 |
|------|------|------|
| **框架** | React 19.1+ | UI 框架 |
| **构建工具** | Vite 7.1+ | 前端构建 |
| **语言** | TypeScript 5.9 | 类型安全 |
| **样式** | Tailwind CSS v4 | Utility-first CSS |
| **UI库** | shadcn/ui + Radix | 组件库 |
| **路由** | React Router 7.9+ | 客户端路由 |
| **动画** | Framer Motion | 动画库 |
| **终端** | xterm.js | Web 终端仿真 |

### 云平台 & 部署
| 组件 | 技术 | 说明 |
|------|------|------|
| **云平台** | 腾讯云 | CVM、TKE、TCR、TDSQL |
| **容器编排** | Kubernetes (TKE) | 容器管理 |
| **IaC** | Pulumi + Go | 基础设施即代码 |
| **GitOps** | ArgoCD | 持续部署 |
| **镜像仓库** | TCR (腾讯容器镜像) | 私有镜像仓库 |
| **前端托管** | Cloudflare Pages | 静态托管 |
| **CDN** | EdgeOne | 腾讯云 CDN |

### 开发工具
- **代码检查**: golangci-lint, pre-commit
- **包管理**: Go Modules, pnpm, npm
- **本地开发**: Docker Compose, Makefile
- **API文档**: Swagger/Swag
- **测试框架**: Go testing, Testify, Vitest (JS)

---

## 目录结构

### 顶层目录概览
```
mono2-clean/
├── README.md                 # 项目总览 & 工程规范
├── AGENTS.md                 # 协作规则 & schema 变更约束
├── Makefile                  # 一键启动所有服务
├── go.work                   # Go workspace 配置
│
├── 【核心业务服务】
├── frontend/                 # 用户前台 Web (React)
├── user/                     # 用户域
│   └── auth/                 # 认证、登录、session
├── service-gateway/          # 对外统一 API 入口
├── sandbox/                  # 沙箱资源池系统
├── ctl/                      # Bot 实例控制面
├── ai-gateway/               # AI 兼容代理网关
├── payment/                  # 支付系统
├── subscription/             # 订阅与计费
│
├── 【运维管理】
├── nextgen-dashboard/        # 浏览器终端管理台 (Shell)
├── nextgen-dashboard-client/ # 本地管理台客户端
├── gateway-dashboard/        # 后台管理系统 (React)
├── admin-gateway/            # 管理 API 入口
├── argocd/                   # GitOps 部署配置 (Argo CD)
│
├── 【基础设施】
├── infra_pulumi/             # 云资源 IaC (Pulumi)
├── deploy/                   # 部署事实目录 (platform.env)
├── .ci/                      # CI/CD 脚本与配置
│
├── 【工具与文档】
├── ctl/                      # 控制面工具
├── docs/                     # 设计文档、开发说明
├── images/                   # 镜像构建、agent/helper
├── scripts/                  # 共享脚本库
├── tools/                    # 开发工具
```

### 关键目录详解

#### 1. **ai-gateway/** - AI 兼容代理网关
```
ai-gateway/
├── cmd/server/               # HTTP 服务入口
├── internal/
│   ├── handler/              # REST 请求处理器 (admin_*, user_*, openai_*)
│   ├── service/              # 业务逻辑层
│   ├── repository/           # 数据访问层 (ORM)
│   ├── model/                # 数据模型 (GORM Entity)
│   ├── adapter/              # 外部服务适配
│   ├── middleware/           # 中间件 (auth, logging, etc)
│   ├── router/               # 路由注册
│   ├── config/               # 配置管理
│   ├── pkg/                  # 工具包 (encryption, redis, etc)
│   ├── scheduler/            # 后台调度
│   └── serverstate/          # 连接追踪与优雅关闭
├── test/
│   ├── handler/              # 单元测试
│   ├── integration/          # 集成测试
│   ├── gateway/              # 网关功能测试
│   └── routing/              # 路由解析测试
├── migrations/               # 数据库迁移脚本
├── k8s/                      # Kubernetes 配置
│   ├── base/                 # 基础清单
│   └── overlays/             # 环境覆盖 (beijing-sandbox, shprod)
├── Makefile                  # 构建入口
└── go.mod                    # Go 依赖
```

#### 2. **ctl/** - Bot 实例控制面
```
ctl/
├── main/
│   ├── api/                  # HTTP REST 服务
│   ├── service/              # 异步消费者服务
│   ├── bypass/               # 定期任务服务
│   └── common/               # 共享初始化
├── pkg/
│   ├── logic/                # 业务逻辑层
│   │   ├── factory/          # Logic 工厂
│   │   ├── objectid/         # Snowflake ID 生成
│   │   ├── lock/             # 分布式锁
│   │   └── common/           # 通用逻辑
│   ├── model/                # 数据模型
│   ├── tasks/                # 异步任务框架
│   │   ├── service/          # 异步 Task
│   │   ├── bypass/           # 定期 Task
│   │   └── processor/        # 消息分发
│   ├── adapter/              # 外部服务适配
│   ├── config/               # TOML 配置
│   ├── mq/                   # Redis Streams 消息队列
│   ├── resource/             # 资源初始化
│   ├── tracing/              # OpenTelemetry 追踪
│   ├── metric/               # Prometheus 指标
│   └── cache/                # 缓存逻辑
├── conf/
│   ├── server/common/        # 通用配置 (TOML)
│   └── server/rewrite/       # 环境覆盖配置
├── test/                     # 单元测试
├── migrations/               # DB 迁移 (时间戳版本)
├── Dockerfile                # 多阶段 Docker 构建
└── go.mod                    # 依赖定义
```

#### 3. **frontend/** - 用户前台
```
frontend/
├── src/
│   ├── main.tsx              # React 入口
│   ├── App.tsx               # 根组件 & 路由
│   ├── pages/                # 页面组件
│   │   ├── landing/          # 营销首页
│   │   ├── auth/             # 登录/注册
│   │   ├── dashboard/        # 用户面板
│   │   ├── bots/             # Bot 管理
│   │   └── settings/         # 设置页
│   ├── components/
│   │   ├── ui/               # shadcn/ui 组件库
│   │   ├── domain/           # 业务组件
│   │   └── site/             # 站点级组件
│   ├── layouts/              # 布局壳 (Marketing, App)
│   ├── theme/                # 主题与设计 token
│   ├── hooks/                # React hooks
│   ├── services/             # API 调用封装
│   └── styles.css            # 全局样式与 CSS variables
├── dist/                     # 构建输出
├── test-results/             # 测试报告
├── public/                   # 静态资源
├── package.json              # 依赖声明
├── vite.config.ts            # Vite 配置
├── tsconfig.app.json         # TypeScript 配置
└── Dockerfile                # 容器镜像
```

#### 4. **sandbox/** - 沙箱资源池
```
sandbox/
├── cmd/
│   ├── server/               # API 服务主程序
│   ├── worker/               # Worker 执行程序
│   ├── ingressproxy-router/  # Ingress 代理
│   ├── ingressproxy-shard/   # 分片处理
│   ├── migrate/              # DB 迁移
│   ├── faultinjector/        # 故障注入
│   └── refill/               # 资源补充
├── internal/
│   ├── api-gin/              # REST 处理器
│   ├── model/                # 数据模型
│   ├── service/              # 业务逻辑
│   ├── repository/           # 数据访问
│   ├── pkg/                  # 工具库
│   └── scheduler/            # 后台任务
├── test/                     # 测试
├── migrations/               # DB 迁移脚本
└── go.mod                    # 依赖
```

#### 5. **infra_pulumi/** - 基础设施即代码
```
infra_pulumi/
├── cmd/infractl/             # CLI 工具入口
├── pkg/
│   ├── backend/              # Pulumi 后端配置
│   ├── tke/                  # TKE 集群配置
│   ├── tcr/                  # 镜像仓库配置
│   ├── database/             # 数据库配置
│   ├── observe/              # 监控资源配置
│   ├── network/              # 网络配置
│   └── common/               # 公共逻辑
├── envs/
│   └── tencentcloud/
│       ├── beijing-sandbox/  # 北京测试环境
│       └── shprod/           # 上海生产环境
├── stack.yaml                # Pulumi 栈定义
└── Makefile
```

#### 6. **gateway-dashboard/** - 后台管理系统
```
gateway-dashboard/
├── src/
│   ├── components/           # React 组件
│   ├── pages/                # 页面
│   ├── services/             # API 调用
│   ├── stores/               # 状态管理
│   └── styles/               # 样式
├── public/                   # 静态资源
├── package.json
├── vite.config.ts
└── Dockerfile
```

---

## 核心功能模块

### 1. AI Gateway (ai-gateway/) - 核心 AI 兼容代理

#### 功能定位
AI Gateway 是一个 **OpenAI-compatible API proxy**，提供：
- 多提供商路由与负载均衡
- Token 计费与额度管理
- 速率限制与熔断保护
- 请求/响应日志与审计
- 模型映射与版本管理
- 数据加密存储

#### 主要能力
| 模块 | 说明 |
|------|------|
| **Routing** | 基于模型、用户、优先级的智能路由 |
| **Billing** | 实时 token 消耗计费与用户余额扣款 |
| **RateLimit** | 按用户、模型、时间窗口的速率限制 |
| **Auth** | API Key 认证、Bearer Token、用户 session |
| **Proxy** | 流式响应代理、连接复用、错误恢复 |
| **Cache** | Redis 缓存、TTL 管理 |
| **Monitoring** | 请求追踪、错误上报、指标导出 |

#### API 端点 (见下文)

#### 数据模型
```go
// 核心实体
- Users              // 用户账户
- APIKeys            // API 密钥
- Providers          // LLM 提供商配置
- ModelMappings      // 模型名映射表
- Plans              // 计费套餐
- Subscriptions      // 用户订阅
- TokenUsage         // Token 使用记录
- BillingTransactions // 账单交易
- RateLimitConfig    // 限流配置
```

### 2. CTL (ctl/) - Bot 实例控制面

#### 功能定位
CTL 是 Lightclaw 的 **资源编排控制面**，负责：
- Bot 实例的创建、更新、删除生命周期
- 资源分配与库存管理
- 异步任务编排与重试
- 状态转移与事件驱动

#### 三服务架构
```
┌──────────────────────────────────────────────────┐
│                                                  │
│  API Service (同步)  Service Service (异步)  Bypass Service (定期)
│  HTTP 处理           MQ 消费者              后台任务
│  ↓                   ↓                      ↓
│  Task 生成      Task 执行与状态管理    周期任务执行
│  立即返回       多步骤编排              状态巡检/清理
│
└──────────────────────────────────────────────────┘
         ↓                   ↓
    MySQL 数据库          Redis Streams 消息队列
```

#### 异步任务框架
- **BaseTask**: 所有 Task 基类，支持 Step 编排
- **Step**: 原子操作单位，支持重试、补偿
- **TaskContext**: 跨 Step 状态传递
- **goinbox/taskflow/v2**: 底层编排引擎

#### 主要 API
```
GET  /health                              # 健康检查
POST /v1/instances                        # 创建实例
GET  /v1/instances                        # 查询实例列表
GET  /v1/instances/{instance_id}          # 查询实例详情
PUT  /v1/instances/{instance_id}          # 更新实例
DELETE /v1/instances/{instance_id}        # 销毁实例
POST /v1/instances/{instance_id}/pause    # 暂停实例
POST /v1/instances/{instance_id}/resume   # 恢复实例
POST /v1/instances/{instance_id}/timeout  # 更新超时
```

### 3. Sandbox (sandbox/) - 资源池系统

#### 功能定位
Sandbox 是 Lightclaw 的 **资源编排与执行层**，负责：
- CVM 虚拟机生命周期（创建、回收、重装）
- 实例库存管理与预创建
- Ingress 代理与流量路由
- Worker 执行与任务调度
- 故障检测与自动恢复

#### 核心组件
| 组件 | 职责 |
|------|------|
| **API Server** | 对外 REST 接口 |
| **Worker** | 后台任务执行（CVM 创建、销毁、SSH 连接) |
| **Ingress Router** | 请求路由代理 |
| **Ingress Shard** | 分片处理、负载均衡 |
| **Scheduler** | 定期巡检、库存补充 |
| **Fault Injector** | 故障模拟测试 |

#### 主要能力
- Pool 池管理（库存、预创建比例）
- Inventory 实例库存（分配、回收、重装）
- ClientProxy 代理（SSH、WSS 隧道）
- Metrics 监控指标

### 4. Frontend (frontend/) - 用户前台

#### 功能定位
前端是用户交互的主入口，提供：
- 营销首页与品牌展示
- 用户注册、登录流程
- 邀请码校验
- 免费套餐选择
- Dashboard 与 Workspace 管理
- 用户设置与账户管理

#### 路由结构
```
Landing Page
    ↓
Login/Register (OAuth + Guest)
    ↓
Invite Code Validation (optional)
    ↓
Plans Selection (Free Tier Confirmation)
    ↓
Dashboard
    ├── Workspace / Bots Management
    └── Settings / Account
```

#### 设计系统
- Tailwind CSS v4 + shadcn/ui 组件库
- 统一主题 token（色彩、字体、圆角、阴影）
- 响应式布局与移动优先
- 深色/浅色主题支持

### 5. Gateway Dashboard (gateway-dashboard/) - 后台管理

#### 功能定位
后台提供运营和运维的管理界面：
- 用户管理与权限控制
- Provider/Routing 配置
- Sandbox Pool 管理
- Bot 实例监控
- 计费与订阅管理
- 系统日志与审计

### 6. Infra Pulumi (infra_pulumi/) - 云资源 IaC

#### 功能定位
基础设施即代码，管理：
- **TKE 集群** - 北京/上海 Kubernetes 集群
- **TCR 镜像仓库** - 私有镜像存储
- **TDSQL 数据库** - MySQL 数据库
- **Redis** - 缓存与消息队列
- **监控** - Prometheus + Grafana
- **网络** - VPC、子网、安全组、Ingress
- **环境差异** - Beijing-Sandbox vs ShProd

#### Pulumi Stack
```
/envs/tencentcloud/
├── beijing-sandbox/     # 北京测试环境堆栈
├── shprod/              # 上海生产环境堆栈
└── common/              # 共享配置
```

---

## API 端点

### AI Gateway 核心 API

#### 1. OpenAI 兼容端点
```
POST /v1/chat/completions              # 聊天完成（流式或非流式）
POST /v1/completions                   # 文本完成
POST /v1/embeddings                    # 文本嵌入
POST /v1/models                        # 列出可用模型
GET  /v1/models/{model}                # 获取模型详情
```

#### 2. 认证与授权
```
POST /auth/login                        # 用户登录
POST /auth/logout                       # 用户登出
GET  /auth/session                      # 获取 session 信息（token introspection）
POST /auth/validate                     # 验证 API Key
```

#### 3. 用户相关
```
GET  /v1/users/me                       # 获取当前用户信息
GET  /v1/users/me/balance               # 获取用户余额
PUT  /v1/users/me                       # 更新用户信息
POST /v1/users/me/usage                 # 查询使用历史
```

#### 4. 订阅与计费
```
GET  /v1/subscriptions                  # 获取订阅信息
POST /v1/subscriptions                  # 创建订阅
PUT  /v1/subscriptions/{sub_id}         # 更新订阅
GET  /v1/billing/invoices               # 获取发票
GET  /v1/billing/usage                  # 查询计费使用
```

#### 5. 管理员端点 (需特殊权限)
```
GET  /admin/users                       # 列出所有用户
POST /admin/users                       # 创建用户
PUT  /admin/users/{user_id}             # 更新用户
DELETE /admin/users/{user_id}           # 删除用户

GET  /admin/providers                   # 列出提供商
POST /admin/providers                   # 添加提供商
PUT  /admin/providers/{provider_id}     # 更新提供商
DELETE /admin/providers/{provider_id}   # 删除提供商

GET  /admin/model-mappings              # 模型映射列表
POST /admin/model-mappings              # 添加映射
PUT  /admin/model-mappings/{mapping_id} # 更新映射

GET  /admin/plans                       # 计费套餐列表
POST /admin/plans                       # 创建套餐
PUT  /admin/plans/{plan_id}             # 更新套餐

GET  /admin/stats                       # 系统统计
GET  /admin/stats/extended              # 扩展统计
GET  /admin/config                      # 系统配置
PUT  /admin/config                      # 更新配置
```

#### 6. 缓存管理
```
POST /cache/invalidate                  # 清除缓存
GET  /cache/stats                       # 缓存统计
```

#### 7. 健康检查
```
GET  /health                            # 健康检查
GET  /ready                             # 准备检查 (readiness probe)
```

### CTL 控制面 API
```
GET  /health                            # 健康检查

POST /v1/instances                      # 创建实例
GET  /v1/instances                      # 列表查询
GET  /v1/instances/{instance_id}        # 详情查询
PUT  /v1/instances/{instance_id}        # 更新信息
DELETE /v1/instances/{instance_id}      # 销毁实例
POST /v1/instances/{instance_id}/pause  # 暂停
POST /v1/instances/{instance_id}/resume # 恢复
POST /v1/instances/{instance_id}/timeout# 更新超时
```

### Service Gateway API
```
/*                                      # 路径转发到后端服务
                                        # 白名单检查、鉴权透传、用户上下文注入
```

### Admin Gateway API
```
/admin/*                                # 管理后台 API 路由
```

---

## 测试框架

### Go 服务测试

#### AI Gateway 测试结构
```
ai-gateway/test/
├── handler/                # 单元测试
│   ├── user_self_test.go
│   └── ...
├── integration/            # 集成测试
│   ├── integration_test.go
│   ├── mem_repos_test.go
│   └── openai_mock_test.go
├── gateway/               # 网关功能测试
│   ├── auth_test.go
│   ├── billing_test.go
│   ├── ratelimit_test.go
│   └── ...
└── routing/               # 路由解析测试
    └── routing_resolution_test.go
```

#### CTL 测试
```
ctl/test/
├── integration/           # 集成测试
└── regression/            # 回归测试
```

#### Sandbox 测试
```
sandbox/test/
└── ...
```

#### 测试运行命令
```bash
# AI Gateway 回归测试
make test-ai-gateway-regression

# CTL 回归测试
make test-ctl-regression

# CTL 集成测试
make test-ctl-integration

# 所有核心回归
make test-regression
```

### 前端测试

#### Frontend 测试
- **框架**: Vitest (Vite 原生测试框架)
- **库**: React Testing Library
- **覆盖**: 组件测试、集成测试

```bash
pnpm test
```

### 测试工具与 Mock
- **Go**: testify, DATA-DOG/go-sqlmock, miniredis, testcontainers
- **JS**: Vitest, jsdom, @testing-library

---

## 部署架构

### 部署模式

#### 当前发布真源
- **代码仓库**: `git@git.woa.com:wisp/mono.git` (origin)
- **GitOps 真源**: `git@git.woa.com:wisp/mono2.git` (target)
- **发布分支**: `master`

#### 北京 / 上海主链发布流程
```
1. 编写代码 + 提交 commit
   ↓
2. git push origin master (代码协作)
   ↓
3. (可选) 构建镜像: python3 scripts/build-release-image.py
   ↓
4. 更新 argocd/services/<service>/<env>/
   ↓
5. git push target master (GitOps 同步)
   ↓
6. ArgoCD 自动收敛 + 验证
```

#### 标准构建入口
```bash
# 构建镜像
python3 scripts/build-release-image.py --service <service> --env <env> --tag <tag>

# infra 配置更新
cd infra_pulumi
GOWORK=off go run ./cmd/infractl up --stack <env>

# 同步 platform.env
GOWORK=off go run ./cmd/infractl sync --stack <env>
```

### Kubernetes 部署结构

#### 服务发布标准形态
```
<service>/
├── k8s/
│   ├── base/                    # 基础 manifests
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   ├── kustomization.yaml
│   │   └── ...
│   └── overlays/<env>/          # 环境覆盖
│       ├── kustomization.yaml
│       ├── generated/           # 本地生成物 (不提交 Git)
│       │   ├── platform.env
│       │   └── <service>-runtime-secrets.env
│       └── ...
└── scripts/
    └── deploy-k8s.sh            # 部署脚本
```

#### Kustomize 关键约束
- `base/` 放稳定资源 (Deployment/Service/Job)
- `overlays/<env>/` 放环境差异
- `configMapGenerator` 管理非敏感数据
- `secretGenerator` 管理敏感值
- Workload 通过 `envFrom` 读取 ConfigMap/Secret

#### 环境差异处理
- `deploy/envs/<env>/platform.env` - infra_pulumi 回写的事实来源
- `.secret/<service>/test.env` - 本地未跟踪敏感配置
- 不手改生成物，所有真实变更落在源码

### 数据库标准

#### 三段式治理
```
1. bootstrap        # 建库、建用户、授权
   ↓
2. migration        # 执行 schema 迁移 (migrations/*.sql)
   ↓
3. seed             # 写默认业务数据 (幂等)
```

#### 时间管理
- **存储层**: 统一 UTC 存储
- **连接层**: DSN 设置 `parseTime=true` 和 `time_zone='+00:00'`
- **应用层**: `time.Now().UTC()` 写库
- **展示层**: 读时 UTC → 本地时区转换

#### Migration 命名约定
- 使用时间戳版本: `20260428_120000_xxx.sql`
- 不再维护 `v1/v2/v3` 固定版本

### 北京 / 上海环境差异

| 方面 | 北京 (beijing-sandbox) | 上海 (shprod) |
|------|------|------|
| **集群** | TKE | TKE |
| **镜像仓库** | lightclaw-bj8.tencentcloudcr.com | shprod registry |
| **API 域名** | lightclaw.tech | api.lightclaw.cn |
| **管理域名** | admin.lightclaw.tech | admin.lightclaw.cn |
| **前端域名** | lightclaw.tech | preview.lightclaw.cn |
| **证书管理** | 手工 TLS secrets | 云端托管自动轮转 |
| **运维模式** | 可手工 apply | GitOps (Argo) |

### 一键启动命令

#### 开发启动
```bash
# 后台启动所有服务
make dev

# 前台启动（可看日志，Ctrl+C 停止）
make dev-fg

# 只启动后端
make backend

# 只启动前端
make dashboard

# 停止所有服务
make stop
```

---

## 工程约定与最佳实践

### 关键工程思想

#### 1. 单一事实来源
- 云资源 → `infra_pulumi`
- 运行时配置 → `deploy/envs/<env>/platform.env`
- 敏感配置 → `.secret/<service>/test.env`
- **不手改生成物** (`platform.env`、`generated/*`)

#### 2. 发布是显式动作
- 必须显式传 `ENV=<env>`
- 不允许默认值
- 所有环境输入来自外部，不写死在代码

#### 3. 生成物与源码分层
- 源码可 review、可复现、可迁移
- 生成物只服务发布，不进版本管理
- 真实变更落在 `infra_pulumi`、`k8s/base`、`k8s/overlays/<env>`、脚本、文档

#### 4. 控制面与工作负载边界
- `infra_pulumi` 负责：云资源、TKE、TCR、监控、环境差异、集群级能力
- 各服务目录负责：workload manifests、镜像构建、migration/seed、rollout

#### 5. 收敛优先
- 新链路跑通后直接收敛到单一实现
- 不保留双轨方案
- 及时消灭历史债务

### Pre-commit 检查

```bash
# 初始化（clone 后执行一次）
make setup

# 手动运行检查
make precommit-check
```

### Commit 信息规范

遵循 **Lore Commit Protocol**（见仓库具体规范）

标准格式：
```
<type>(<scope>): <subject>

<body>

<footer>
```

### 代码质量

- **Go**: golangci-lint（`.golangci.yml`）
- **JS**: ESLint + Prettier（配置中）
- **pre-commit hooks**: 自动检查

---

## 总结

**Lightclaw** 是一个成熟的、结构清晰的 AI SaaS 平台，特点包括：

1. **清晰的分层** - 前台、控制面、资源池、网关、运维各司其职
2. **完整的生命周期** - 从用户注册到 Bot 创建、计费、销毁的全链路
3. **生产级工程** - IaC、GitOps、优雅关闭、可观测性、分布式追踪
4. **云原生** - Kubernetes、容器化、多环境支持
5. **标准化流程** - 明确的发布约定、数据库标准、部署模板

**核心服务调用关系**:
```
frontend
  ↓ auth API
user/auth
  ↓ REST API
service-gateway ──→ ctl (Bot 实例)
  ↓                  ↓
ai-gateway         sandbox (资源池)
  ↓
Portkey (第三方路由)
  ↓
LLM Providers (OpenAI, Anthropic, etc)
```

**运维管理栈**:
```
argocd/ (GitOps 部署)
  ↓
nextgen-dashboard/ + gateway-dashboard/
  ↓
infra_pulumi/ (IaC 云资源)
```

