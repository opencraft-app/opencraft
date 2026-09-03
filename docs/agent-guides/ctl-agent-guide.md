# CTL Agent Guide

本文件约束 `ctl` 的开发逻辑、目录职责和本地开发方式。开发 `ctl` 时，Agent 应先阅读本文件。

相关补充文档：

- 本地启动、联调、回归脚本： [docs/agent-guides/ctl-local-run-guide.md](ctl-local-run-guide.md)
- 微信扫码登录 API 对接： [docs/agent-guides/ctl-weixin-login-api-guide.md](ctl-weixin-login-api-guide.md)
- CreateInstance 卡 `Creating` 跟进： [docs/agent-guides/ctl-create-instance-followup-guide.md](ctl-create-instance-followup-guide.md)
- 微信通道排障与坑点沉淀： [docs/agent-guides/ctl-weixin-followup-guide.md](ctl-weixin-followup-guide.md)
- 微信登录技术债： [docs/developer-guide/ctl-weixin-login-tech-debt.md](../developer-guide/ctl-weixin-login-tech-debt.md)
- 可观测性（Metrics/Logging/Tracing）： [docs/agent-guides/ctl-observability-guide.md](ctl-observability-guide.md)
- 部署与 Pod 形态： [docs/deploy-guides/ctl-deploy-guide.md](../deploy-guides/ctl-deploy-guide.md)

## 1. 目录职责

`ctl` 采用“业务域 + 运行时能力”分层，不按 `api/service/bypass` 复制三套业务代码。

- `ctl/main/api`
  - API 进程入口
  - 只负责启动 HTTP 服务和装配依赖
- `ctl/main/service`
  - 异步 worker 进程入口
  - 只负责启动 MQ consumer
- `ctl/main/bypass`
  - 定时任务进程入口
  - 只负责启动 bypass 调度

- `ctl/pkg/instance`
  - `instance` 业务域的核心逻辑
  - 包含实例生命周期规则、同步入口逻辑、异步入队逻辑
- `ctl/pkg/instance/worker`
  - `instance` 领域下的异步 worker 实现
  - 这里放 Create/Destroy 等实例相关 task 的执行逻辑

- `ctl/pkg/taskruntime`
  - 通用异步运行时能力
  - 包含 base task、processor、message/common 协议
  - 这里只放“任务怎么跑”，不放“业务怎么做”

- `ctl/pkg/bypass`
  - 周期任务与补偿调度
  - 这里只放定时扫描、补偿重投、清理类任务
  - 这里只放“何时触发/补偿”，不放业务域规则

- `ctl/pkg/model`
  - 数据模型与 DAO

- `ctl/pkg/metric`
  - Prometheus 指标定义，按领域拆文件（task/bypass/instance/infra/adapter/api/cgw）
  - 详见 [ctl-observability-guide.md](ctl-observability-guide.md)

- `ctl/pkg/log`
  - 统一日志字段常量（`fields.go`），三服务共用

- `ctl/pkg/tracing`
  - OpenTelemetry Span 封装

## 2. 业务分层原则

- 业务规则优先放到领域目录，例如实例生命周期规则优先放在 `ctl/pkg/instance`
- 不要因为某段逻辑最终由 `service` 或 `bypass` 进程执行，就把业务规则迁出领域目录
- `main/*` 目录不承载业务规则，只做进程装配
- 除非用户主动要求，否则不要在 `ctl` 里为旧实现保留兼容层、兼容脚本或双轨逻辑

## 3. 异步设计原则

当前 `ctl` 的异步可靠性模型是：

1. API 写 DB 中的 `tasks` 记录
2. API 通过 Redis Stream 快速投递消息
3. `main/service` 消费并执行 task
4. `main/bypass` 通过周期扫描 `tasks` 做补偿重投

关键约束：

- Redis Stream 负责“快速投递”，不是唯一事实来源
- `tasks` 表才是异步任务的持久化事实来源
- `bypass` 的职责是补偿未完成任务，不是承载业务逻辑
- `operation_histories` 是用户可见操作历史，不能复用为内部任务队列表
- 对未来可能跨 shard 聚合的衍生资料，优先做成投影：
  - 领域逻辑写 durable task
  - `main/service` 消费 task 更新投影
  - `main/bypass` 通过扫描 `tasks` 做补偿
  - 不要把全局排序号同步写回未来可能分片的主表

## 4. Schema / Migration Rules

- 任何会影响持久化 schema 的变更都必须提交对应的 `ctl/migrations/*.sql`
- 不允许把生产或本地开发 schema 变更只留在 GORM model 或 `AutoMigrate`
- 对已有 migration 不做重写式修改；schema 演进一律追加 migration
- 涉及数据迁移或兼容性修复时，优先写幂等 SQL
- `ctl` 的数据库时间口径统一按 UTC：
  - 连接层使用 UTC
  - GORM 自动时间使用 UTC
  - `instances` / `tasks` / `operation_histories` / `channel_login_sessions` 等表内部统一存 UTC
  - 展示层若需要中国自然日，读取时再做 `UTC -> +8` 转换

### 当前重点表语义

- `instances`: 实例主表
  - `sandbox_id` 一旦拿到真实值应尽快持久化，不能只停留在 `pending-*`
  - `ai_gateway_key_id` 用于跟踪实例创建时下发的 AI Gateway credential，删除实例时应可回收
  - `debug/exec` 现已走 `envd process`，不再依赖 TAT；相关联调/部署必须保证 `adapter.sandbox.processBaseUrl` 指向可用的 `ingressproxy-router`
  - 实例创建阶段的 `openclaw onboard` 也已走 `envd process`；不要再默认依赖 TAT 才能把 custom key 配进实例
  - `envd process` 的成功结束状态可能是原始字符串 `exit status 0`；`ctl` 侧需要按 `exitCode == 0` 归一为成功，不能只盯 `status == SUCCESS`
  - `ctl` 不再为 `openclaw` 命令做 `openclaw.mjs` / 配置恢复兜底；镜像必须直接提供可执行的 `openclaw` 和可用配置
- `user_resource_quota`: 用户资源配额
- `tasks`: 异步任务持久化表
- `operation_histories`: 用户可见操作历史
- `channel_login_sessions`: 微信等通道登录会话；“同一 user/instance/channel 只允许一个 active session” 必须由 DB invariant 保证
- `instance_birth_profiles`: 历史 bot 出生卡投影表，当前出生证 / borncard 产品链路已下线
  - 不再作为新功能依赖；新建实例不应继续投影出生编号
  - 保留该表仅用于兼容历史 migration / 数据，不应把其字段重新暴露到当前 API

## 5. Local Dev Rules

- `ctl` 运行时不会自动执行 migration
- 重建本地数据库后，必须显式按顺序应用 migration
- 推荐入口：
  - `cd ctl && make migrate-up-local`
  - `cd ctl && make seed-local-quota`
  - `cd ctl && ./conf/local/dev.sh reset-db`

本地脚本职责划分：

| 脚本 | 管什么 | 生命周期 |
|------|--------|----------|
| `conf/local/dev.sh` | MySQL + Redis | 跟着 DB schema 走，`reset-db` 随时销毁重建 |
| `conf/local/services.sh start/stop` | API + Service + Bypass | 开发时按需启停 |
| `conf/local/services.sh monitor-up/down` | Prometheus + Grafana + Alertmanager | 长期运行，不受 reset-db 影响 |

补充说明：

- `dev.sh reset-db` 只影响 MySQL/Redis volume，不会杀掉监控栈容器
- `dev.sh restart` 只重启 MySQL/Redis 容器，不会清空 named volume
- 若本地 DB 结构与代码不一致，优先重建并重放 migration，不优先手改表结构
- 本地联调 `sandbox`、启动三服务、跑走查脚本时，进一步参考 [docs/agent-guides/ctl-local-run-guide.md](ctl-local-run-guide.md)

## 6. Testing Rules

- 对 `instances`、`user_resource_quota`、`tasks` 这类真实业务表，集成测试优先使用 migration 建库
- 若对应表已纳入 `ctl/migrations/`，测试不要把 `AutoMigrate` 当作权威 schema
- 新增或修改 migration 时，至少验证：
  - 干净数据库上 migration 可成功应用
  - 关键 DAO / logic 集成测试通过

## 7. API 路由与 Service Gateway

CTL 的公网流量经过 Service Gateway 转发，路由规则现在由 deploy-facing `service-gateway` 配置维护，基础结构仍在 `service-gateway/k8s/base/`。

当前 CTL 路由条目：

```yaml
- name: ctl
  prefix: /v1/instances
  upstream: http://ctl-api.ctl.svc.cluster.local
  access: authenticated
```

### 新增接口时的网关规则

- 如果新接口在已有前缀（如 `/v1/instances/...`）下，**无需修改网关配置**，会自动匹配
- 如果新接口引入了**新的顶级前缀**（如 `/v1/channels`、`/v1/billing` 等），**必须**在 deploy-facing `service-gateway` routes 配置中添加对应路由条目，默认结构为：
  ```yaml
  - name: <service-name>
    prefix: /v1/<new-prefix>
    methods: [GET, POST, PUT, DELETE, OPTIONS]
    upstream: http://ctl-api.ctl.svc.cluster.local
    access: authenticated
  ```
- 添加后需通过当前 repo 的 `gitops` 发布视图更新 `service-gateway` deploy-facing 配置，并由 Argo 收敛。

### 公网入口排障原则

- `lightclaw.tech` 的 `/v1/instances` 行为，先受 `service-gateway` 影响，再到 `ctl-api`；公网异常时，不要只看 `ctl-api` 直连结果
- 如果出现“直连 `ctl-api` 成功，但公网 `lightclaw.tech` 同接口返回 500”的分叉，优先检查：
  - `service-gateway` 的 `ctl` route upstream 是否仍指向旧 namespace / 旧 service
  - `service-gateway` access log 是否记录到了该请求
  - 公网错误响应是否带了 `X-Request-Id` / `request_id`
- `2026-03-26` 的真实事故是：`service-gateway` 仍把 `/v1/instances` 转发到 `http://ctl-api.lightclaw.svc.cluster.local`，而测试环境真实 `ctl` 已迁到 `http://ctl-api.ctl.svc.cluster.local`；结果是直连测试环境 `ctl-api` 可成功配置 QQBot，但 `lightclaw.tech/v1/instances/.../channels/config` 直接返回 `500 CHANNEL_CONFIG_FAILED`

## 8. Review Checklist

- schema 改动是否附带 migration
- model tag 是否与 migration 一致
- 异步任务是否正确落到 `tasks`，而不是错误复用 `operation_histories`
- `service` 与 `bypass` 的职责是否混淆
- 本地重建步骤是否仍可执行
- 文档是否说明了新增字段 / 表 / 异步链路变化
- 新增指标/日志/Span 是否遵循 [ctl-observability-guide.md](ctl-observability-guide.md) 规范
- 新增 API 接口是否需要在 Service Gateway 注册新路由（见第 7 节）

## 9. Test Env Validation Rule

当 Agent 修改了 `ctl` 的测试环境配置、部署脚本或敏感配置渲染逻辑时，不能只停留在：

- `kubectl apply`
- Argo app status / cluster workload status
- `/health`

最低要求是：

1. 通过当前 repo 的 `gitops` pin / config 变更完成 rollout
2. 用 `kubectl port-forward -n ctl svc/ctl-api 19590:80` 暴露测试环境 API
3. 直接调用测试环境 `ctl-api` 验证至少一条真实业务链路：
   - `GET /health`
   - `GET /v1/instances`
   - `POST /v1/instances`
   - 轮询到 `Running`
   - `DELETE /v1/instances/{id}`

补充约束：

- 如果变更只影响 ConfigMap / 模板，也仍然统一走 Argo 主线，不要再维护旧的双轨发布入口
- `ctl/scripts/tests/smoke_local_api.py` 适合本地联调，不适合直接把测试环境渲染配置拿来做远端 sandbox 可达性判断
- 如果变更涉及 OpenClaw custom model、`debug/exec`、`adapter.aigateway` 或 sandbox pool 镜像，发布后优先跑 [`ctl/scripts/tests/smoke-openclaw-testenv.py`](../../ctl/scripts/tests/smoke-openclaw-testenv.py)，不要只看 `/health`
- 如果变更涉及 instance churn guard / per-user abuse cooldown，发布后优先跑 `cd ctl && CTL_TEST_USER_ID='usr_<your_user_id>' make testenv-abuse-cooldown`
- `testenv-abuse-cooldown` 需要真实测试用户；历史终态实例不会挡住脚本，但用户当前若已有活跃实例，会污染计数和清理语义

## 10. OpenClaw 联调经验

- 先分清“镜像执行面”还是“模型链路”在坏；镜像是否更新可直接查 `/etc/lightclaw/image-version`
- `ctl` 不应继续为镜像补 `.bashrc` / `nvm` / `pnpm` / `openclaw.mjs` 兜底；镜像必须自己满足最小 PATH 直接运行 `openclaw`
- 测试环境真实用户 ID 形态是 `usr_*`，不是 `10001`
- `adapter.aigateway.default_base_url` 必须带 OpenAI 兼容根路径，通常以 `/v1` 结尾
- OpenClaw 2026.3.11 用 `OPENCLAW_CONFIG_PATH` 指定配置文件
- 预设 SOUL 模板属于 repo 内静态资产，当前收敛到 `ctl/assets/souls/`，并通过 `ctl` 自己的 Kustomize overlay 生成 ConfigMap 挂到 `/etc/ctl/souls`；不要先上数据库或配置中心
- 如果 OpenClaw `agent --local` 失败，而同一 key 的 `stream=false` 直连成功，优先检查 ai-gateway 的 streaming 路径；不要先把锅甩给 custom provider 配置
- 如果 `openclaw agent --local --json` 返回 `payloads: []` 且 `meta.stopReason = "toolUse"`，不要先怀疑 Linux 权限。先检查 ai-gateway 的 `stream=true` + `tools` SSE 是否真的带了 `delta.tool_calls`；只有 `finish_reason: "tool_calls"` 没有实际 tool call 时，OpenClaw 会空转成 `No reply from agent.`
- `POST /v1/instances/{id}/channels/config` 现在也应走 `ingressproxy-router -> envd process`，不要再走旧的 TAT `/tat/commands`；测试环境实测旧路径会直接 `401`
- OpenClaw channel/gateway 排障优先看 `debug/exec openclaw_channels_status` 和 `debug/exec openclaw_gateway_status`，前者能直接看到 `configured/running/connected`，后者能确认 `18789` 监听和真实 gateway 进程
- 如果 channel 在线但“回一句后没反应”，继续跑 `debug/exec openclaw_qqbot_logs`、`debug/exec openclaw_logs_recent`、`debug/exec openclaw_doctor`；不要只盯配置文件
- 如果日志里已经出现 `No reply from agent.`，继续跑 `debug/exec openclaw_sessions_recent`。重点看最近 transcript 里是不是停在 `assistant stopReason=toolUse`，但后面没有任何 `toolResult`；这种形态更像模型/tool-call 兼容性或 agent 工具回合卡住，不像 Linux 文件权限问题
- `debug/exec` 现在除了内置别名，也支持直接传原始 bash。像 `hostname -I`、`cat /etc/lightclaw/image-version` 这类临时命令，不必每次再给 `ctl` 加白名单
- 当前镜像下，QQBot 配置成功后 `openclaw channels status --probe` 可直接看到 `QQ Bot default: enabled, configured, running, connected`
- 当前测试镜像里 gateway 可能以自拉起进程形式运行，而不是 `openclaw-gateway.service` systemd unit；判断是否可用时优先看进程和 `18789` 监听，不要只盯 `systemctl`

### 10.1 这轮排障最容易浪费时间的点

- 先验“是不是最新镜像”。如果 fresh sandbox 里 `/etc/lightclaw/image-version` 不是预期值，后面所有现象都可能是旧世界的幽灵，不值得深挖
- 不要把“实例 Running”当成 OpenClaw 已经可用。至少要继续看：
  - `debug/exec openclaw_config`
  - `debug/exec openclaw_agent_smoke`
  - `debug/exec openclaw_gateway_status`
- 同一个“bot 不回话”表象，背后可能是完全不同的层：
  - 镜像执行面坏
  - `envd process` / ingressproxy 坏
  - ai-gateway custom model 坏
  - QQBot channel 连通正常，但 agent 处理没产出
- 这类问题最浪费时间的根因通常不是单点 bug，而是“镜像、执行链路、模型网关、可观测性”同时各有一个坑；排查时要强制分层，不要一次只盯 OpenClaw 本身

### 10.2 推荐的测试环境验证分层

1. 镜像层
   - 看 `/etc/lightclaw/image-version`
   - 看 `openclaw --version`
   - 看 `openclaw-gateway` 进程和 `18789` 监听
2. 主链路层
   - `POST /v1/instances`
   - `debug/exec openclaw_config`
   - `debug/exec openclaw_agent_smoke`
3. channel 层
   - `POST /v1/instances/{id}/channels/config`
   - `debug/exec openclaw_channels_status`
   - `debug/exec openclaw_qqbot_logs`
   - `debug/exec openclaw_sessions_recent`
4. 外部人工验证层
   - 再让真实用户发消息，按时间点对日志抓现场
