# CTL Local Run Guide

本文件约束 `ctl` 在本地开发、联调、走查测试和脚本维护时的标准流程。Agent 需要在本地启动 `ctl`、跑回归脚本、排查联调问题时，应优先阅读本文件。

## 1. 适用场景

- 本地启动 `ctl` 的 `api` / `service` / `bypass`
- 通过 `kubectl port-forward` 接入测试环境 sandbox
- 跑本地 REST API 走查脚本
- 修复或完善本地联调脚本
- 排查“请求已入队但异步任务未完成”的问题

## 2. 本地最小运行形态

本地联调至少需要以下组件：

1. 本地 MySQL + Redis（`dev.sh` 管理）
2. `ctl/main/api`
3. `ctl/main/service`
4. 测试环境 sandbox 的 `port-forward`

可选组件：

5. `ctl/main/bypass` — 需要验证补偿重投、定时任务时再启动
6. 监控栈（Prometheus + Grafana + Alertmanager）— 需要查看指标/告警/Dashboard 时再启动

如果只启动 `api`，异步创建/销毁不会真正执行。

## 3. 启动前检查

### 数据库与初始化

- 本地 DB schema 必须先迁移到最新版本
- 推荐入口：
  - `cd ctl && ./conf/local/dev.sh reset-db`
  - `cd ctl && make migrate-up-local`
  - `cd ctl && make seed-local-quota`

如果启动时出现：

```text
database schema version mismatch: db=5 code=6
```

说明本地库没有应用最新 migration，应先执行 migration，而不是手工改表。

### 本地配置

- 默认配置目录：`ctl/conf/local`
- 真实敏感值来自 `.secret/ctl/local.env`
- `dev.sh` / `services.sh` 会先执行 `ctl/scripts/render-secrets.sh --env local`
- 渲染后的实际运行目录是 `/tmp/mono-rendered/ctl/local`
- `ctl/conf/local/rewrite/server_conf_rewrite.toml` 当前会把 sandbox `baseUrl` 重写到 `http://127.0.0.1:18081`
- 这意味着本地联调前必须先建立 sandbox 的端口转发

## 4. 标准启动顺序

### Step 1: 启动依赖

```bash
cd ctl && ./conf/local/dev.sh start
cd ctl && make migrate-up-local
cd ctl && make seed-local-quota
```

如果要重建干净环境，优先直接用：

```bash
cd ctl && ./conf/local/dev.sh reset-db
```

> `reset-db` 只影响 MySQL/Redis，不会影响监控栈容器。

### Step 2: 建立 sandbox 端口转发

```bash
KUBECONFIG=.secret/cls-8gnhos9p-config \
kubectl port-forward -n sandbox svc/sandbox-api 18081:80
```

如果 `ctl/conf/local/rewrite/server_conf_rewrite.toml` 仍然使用 `127.0.0.1:18081`，就不要跳过这一步。

如果需要验证 `envd process` / 长会话命令（例如微信扫码登录），还应同时建立 `ingressproxy-router` 的端口转发：

```bash
KUBECONFIG=.secret/cls-8gnhos9p-config \
kubectl port-forward -n sandbox svc/ingressproxy-router 18082:80
```

如果希望一键拉起完整本地联调环境，现在也可以直接用：

```bash
cd ctl
./conf/local/dev.sh up
```

它会依次完成：

1. 启动本地 MySQL + Redis
2. 启动 `sandbox-api` / `ingressproxy-router` 的 `port-forward`
3. 以热加载模式启动 `api` / `service` / `bypass`

对应停止命令：

```bash
cd ctl
./conf/local/dev.sh down
```

补充说明：

- `sandbox-api` 负责 create/get/delete sandbox 等生命周期接口
- `ingressproxy-router` 负责转发到实例内 `envd` 的 `process.Process/*` 能力
- `debug/exec`、微信登录、实例创建阶段的 `openclaw onboard` 现在都依赖 `process.Process/*`，不再依赖 TAT
- `POST /v1/instances/{id}/channels/config` 也已改成走 `process.Process/*`；如果这里还在打 `/tat/commands`，测试环境常见表现是 `401 channel configuration failed`
- `ctl` 也不再替镜像兜底 `openclaw` 运行时：没有 `openclaw` 可执行文件或镜像内配置不可用时，应直接在命令结果里暴露失败
- OpenClaw `2026.3.11` 的本地 agent 烟雾命令需要显式带 `--agent main`；裸 `agent --local --message ...` 会直接报缺少会话选择参数
- `adapter.aigateway.default_base_url` 要填 OpenAI 兼容根路径（通常是 `.../v1`），否则 OpenClaw 会把请求打到错误路径，agent smoke 常见报错是 `HTTP 404: 404 page not found`
- 当前测试环境下，公网 `ingressproxy-router` 可能返回 `502 Server UnReachable`
- 本地联调时，优先使用 `127.0.0.1:18082` 的 `port-forward` 验证 `process` 流
- 当前测试镜像里 gateway 可能不是 `systemd` unit，而是镜像自拉起的 `openclaw-gateway` 进程；验证时优先看 `debug/exec openclaw_gateway_status` 的进程和 `18789` 监听
- channel 侧补充调试命令：
  - `openclaw_channels_status`: 看 `configured/running/connected`
  - `openclaw_qqbot_logs`: 看 QQBot 专项日志，再拼接最近网关日志
  - `openclaw_logs_recent`: 直接拉最近 200 行 gateway 日志
  - `openclaw_doctor`: 快速看 OpenClaw 自检结果
  - `openclaw_sessions_recent`: 看 `sessions.json` 和最近 transcript；如果 assistant 停在 `stopReason=toolUse` 且后面没有 `toolResult`，优先怀疑模型/tool-call 回合卡住，不要先甩锅给 OS 权限
- `debug/exec` 现已支持直接传原始 bash；内置别名适合沉淀常用排障动作，临时实验可直接下发 `hostname -I`、`cat /etc/lightclaw/image-version`、`ss -tlnp` 这类命令

### Step 3: 启动三服务

推荐使用 `services.sh` 一键启动，自动等待 metrics 端口就绪：

```bash
cd ctl && ./conf/local/services.sh start
```

正常输出：

```
启动 CTL 三服务...
  API 启动成功 (PID xxx, metrics :9591)
  Service 启动成功 (PID xxx, metrics :9592)
  Bypass 启动成功 (PID xxx, metrics :9593)
```

也可以手动逐个启动：

```bash
cd ctl && ./scripts/render-secrets.sh --env local
go run ./main/api -conf-dir /tmp/mono-rendered/ctl/local
go run ./main/service -conf-dir /tmp/mono-rendered/ctl/local
go run ./main/bypass -conf-dir /tmp/mono-rendered/ctl/local   # 按需
```

### Step 4: 按需启动监控栈

```bash
cd ctl && ./conf/local/services.sh monitor-up
```

启动后可访问：

- Grafana: http://localhost:3000（免登录，Dashboard 在 OpenClaw 文件夹）
- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093

### 查看全部状态

```bash
./conf/local/services.sh status
```

### 停止

```bash
./conf/local/services.sh stop          # 停三服务
./conf/local/services.sh monitor-down  # 停监控栈
./conf/local/dev.sh stop               # 停 MySQL/Redis
```

## 5. 本地走查测试

### 标准脚本

当前本地 REST API 走查脚本：

```bash
python3 ctl/scripts/tests/smoke_local_api.py
python3 ctl/scripts/tests/regression_local_api.py
```

当前测试环境 OpenClaw / QQBot 烟雾脚本：

```bash
python3 ctl/scripts/tests/smoke-openclaw-testenv.py \
  --base-url http://127.0.0.1:19590 \
  --user-id usr_<your_user_id> \
  --expected-base-url http://lb-a885sn2l-bs459xiehz3uvpwd.clb.bj-tencentclb.com/v1

python3 ctl/scripts/tests/smoke-openclaw-qqbot-testenv.py \
  --base-url http://127.0.0.1:19590 \
  --user-id usr_<your_user_id> \
  --qqbot-token "$QQBOT_TOKEN" \
  --keep-instance

python3 ctl/scripts/tests/regression-openclaw-testenv.py \
  --base-url http://127.0.0.1:19590 \
  --user-id usr_<your_user_id>
```

脚本分层：

- `smoke_local_api.py`
  - 轻量冒烟
  - 覆盖 `health -> create -> wait running -> debug exec -> destroy`
- `regression_local_api.py`
  - 全量走查
  - 覆盖 Create / List / Get / Pause / Resume / Timeout / Destroy / Debug / Quota
- `ctl/scripts/tests/smoke-openclaw-testenv.py`
  - 测试环境主链路冒烟
  - 覆盖 `health -> create -> wait running -> openclaw_config -> openclaw_agent_smoke -> destroy`
- `ctl/scripts/tests/regression-openclaw-testenv.py`
  - 测试环境自动化 API 回归
  - 覆盖 `health -> create -> list -> get -> debug -> pause -> resume -> timeout -> operations -> logs -> destroy`
- `ctl/scripts/tests/smoke-openclaw-qqbot-testenv.py`
  - 测试环境 QQBot 冒烟
  - 覆盖 `health -> create -> wait running -> 主链路校验 -> /channels/config -> channel/gateway/debug logs`

全量脚本覆盖：

- `/health`
- Create / List / Get / Pause / Resume / Timeout / Destroy
- Debug command 执行
- 配额打满场景
- OpenClaw custom model 主链路
- QQBot 配置下发与最小调试采样

### 当前脚本语义

- Create/Destroy 已按异步语义处理
- Create 返回 `201` + `Creating` 后，脚本会轮询实例直到 `Running`
- Destroy 返回 `Deleting` 后，脚本会轮询直到实例删除完成
- 脚本会先检查 sandbox endpoint 是否可连通，再开始生命周期验证

### 常用命令

```bash
python3 ctl/scripts/tests/smoke_local_api.py
python3 ctl/scripts/tests/regression_local_api.py --user-id 10001
python3 ctl/scripts/tests/regression_local_api.py --quota-probe-limit 20
```

## 6. 排障顺序

当本地联调失败时，按以下顺序看：

1. `./conf/local/services.sh status` 确认三服务和监控栈状态
2. sandbox `port-forward` 是否仍在线
3. 本地脚本是否在启动前通过 sandbox connectivity check
4. `tasks` 表是否写入任务记录
5. `service` 是否消费到 Redis Stream 消息
6. 实例状态是否从 `Creating` / `Deleting` 推进

### 常见故障

#### schema version mismatch

- 先跑 migration
- 不手改本地表结构

#### sandbox endpoint unreachable

- 说明 `127.0.0.1:18081` 未联通
- 优先检查 `kubectl port-forward` 是否仍存活

#### 只启动了 `api`

- 请求可能返回 `Creating`
- 但没有 `service` 消费消息，实例不会进入 `Running`
- 推荐用 `./conf/local/services.sh start` 一键启动全部

#### service 有消费但实例长时间停在 `Creating`

- 看 `service` 日志里的 sandbox 请求结果：`./conf/local/services.sh logs service`
- 看 `tasks` 表状态和 message
- 再判断是外部依赖失败，还是内部状态流转缺口
- 如果同一个 `CreateInstance` task 每隔约 1 分钟就被 `ctl-bypass/checkTasks` 重放一次：
  - 说明这个 task 没有正确收口到 `FAILED`
  - 重点检查 `tasks.task_state` 是否错误地停在 `RUNNING`
  - 重点检查 `ctl-service` 的 create worker 失败路径是否已经调用最终失败收口逻辑；否则 bypass 会持续重投，同一个实例可能被反复重建，甚至绑到和原模板不一致的 sandbox 库存

#### sandbox-api 正常，但 process 长会话返回 404 / 502

先区分是哪一层失败：

1. `sandbox-api` 正常
   - `curl http://127.0.0.1:18081/health`
   - `POST /sandboxes` 能成功创建 sandbox
2. `process` 路由是否正确
   - sandbox 真实暴露的 Connect 路径是 `/process.Process/Start`
   - 不是 `/envdprocess.Process/Start`
3. `ingressproxy-router` 是否可用
   - 若公网地址返回 `502 Server UnReachable`，优先改用 `kubectl port-forward -n sandbox svc/ingressproxy-router 18082:80`
   - 用 `sandbox/cmd/sandboxcli` 直连 `127.0.0.1:18082` 做最小验证
4. `ctl` 配置里的 `adapter.sandbox.processBaseUrl` 是否真的指向了 `ingressproxy-router`
   - 如果没配该字段，`ctl` 会默认退回到 `baseUrl`
   - 当 `baseUrl` 只指向 `sandbox-api` 时，`debug/exec`、微信登录这类 process 链路会表现为“实例正常，但命令执行失败”
5. `ctl` 是否把 envd 成功结束误判成失败
   - `sandboxcli` 直连 `process.Process/Start` 时，end status 可能是原始字符串 `exit status 0`
   - 如果 `sandboxcli` 能成功打印命令输出，但 `ctl /debug/exec` 仍返回 `DEBUG_EXEC_FAILED`，优先检查 `ctl` 是否只按 `status == SUCCESS` 判断成功
   - 如果需要查 QQBot / Telegram 之类的 channel 是否真的落地，不要只看 `/channels/config` 的 HTTP 200；继续跑 `debug/exec openclaw_channels_status`，确认输出里已经到 `configured` / `running` / `connected`
   - 如果 channel/gateway 都正常，但用户说“它开始说要查 IP/记忆，然后就卡住”，继续跑 `debug/exec openclaw_sessions_recent`。这类现象经常是 agent 进入 toolUse 回合后没有产出最终回复，不是 QQBot 掉线

推荐验证命令：

```bash
cd sandbox && GOWORK=off go run ./cmd/sandboxcli \
  -api-base-url http://127.0.0.1:18081 \
  -process-base-url http://127.0.0.1:18082 \
  -template-id pool-c2 \
  -cmd 'echo hello'
```

如果上面能输出 `hello`，说明：

- `envd` 本身可用
- `clientproxy -> envd process` 链路可用
- 后续问题优先看实例内命令自身，而不是先怀疑 `envd`

#### OpenClaw 命令秒退 0 且无输出

这类问题不要先归因到 `envd`。先在 fresh sandbox 里直接检查 OpenClaw 运行态：

```bash
cd sandbox && GOWORK=off go run ./cmd/sandboxcli \
  -api-base-url http://127.0.0.1:18081 \
  -process-base-url http://127.0.0.1:18082 \
  -template-id pool-c2 \
  -cmd 'env -i HOME=/root USER=root PATH=/usr/bin:/bin:/usr/local/bin which openclaw; env -i HOME=/root USER=root PATH=/usr/bin:/bin:/usr/local/bin openclaw --version; cat /root/.openclaw/openclaw.json'
```

排障判断：

- 如果 `echo hello` 正常，但 `openclaw channels login --channel openclaw-weixin` 秒退 0 且无二维码：
  - 优先怀疑镜像里的 OpenClaw / 插件状态不对
  - 不优先怀疑 `envd`
- 如果 `openclaw.json` 里只有 `plugins.entries.openclaw-weixin.enabled = true`，但 `plugins.installs` 没有 `openclaw-weixin`：
  - 说明配置已启用，但插件安装结果没有稳定落盘
  - 优先检查镜像构建脚本里的插件安装并发、安装后校验、以及 pool 是否已切到新镜像
- 如果 `plugins.entries.openclaw-weixin.enabled = true` 且 `plugins.installs.openclaw-weixin` 也存在，但 `openclaw channels login --channel openclaw-weixin` 仍在 20 秒内崩掉：
  - 优先检查是否出现 `JavaScript heap out of memory`
  - `2026-03-28` 测试环境 fresh sandbox 已实测过这条路径，失败点在 `openclaw-channels` 进程 OOM，不是“没装插件”

#### OpenClaw 配置文件 override 变量

OpenClaw `2026.3.11` 认的是 `OPENCLAW_CONFIG_PATH`，不是 `OPENCLAW_CONFIG_FILE`。

排障时如果你想临时指定一份配置文件，应该这样做：

```bash
env -i HOME=/root USER=root PATH=/usr/bin:/bin:/usr/local/bin \
  OPENCLAW_CONFIG_PATH=/tmp/openclaw.json \
  openclaw config file
```

如果输出不是 `/tmp/openclaw.json`，说明 override 没生效，后面的 `agent --local` / `gateway run` 结果都不可信。

#### 微信登录二维码拿不到，但 sandbox 已能创建

当前先区分“镜像协议/运行时问题”和“CTL 协议消费问题”，不要再默认按旧的 PTY 流式链路排障。

快速判断方法：

1. 先验证实例内 OpenClaw/插件是否正常
2. 再验证镜像协议命令和状态文件是否一致

如果在 fresh sandbox 里出现：

- `ctl` 的 login session 一直卡在 `starting`
- 或很快进入 `failed`
- 或 `cancel` 返回异常但实例内看起来已经停掉

优先按下面顺序排查。

镜像层判断：

- 如果构建机上直接执行 `openclaw channels login --channel openclaw-weixin` 能打印二维码
- 但 fresh sandbox 里不行
- 先确认 pool 已切到新镜像
- 再确认 sandbox 内：
  - `/usr/local/bin/openclaw` wrapper 存在
  - `~/.local/share/pnpm/openclaw` 不是空 shim
  - `~/.openclaw/extensions/openclaw-weixin` 存在
  - `~/.openclaw/openclaw.json` 中 `plugins.installs` 包含 `openclaw-weixin`
  - 如果以上都满足，但登录命令仍失败，再看 stdout/stderr 里是否有 `JavaScript heap out of memory`

结构化协议判断：

- 先在实例内直接执行：

```bash
env -i HOME=/root USER=root PATH=/usr/bin:/bin \
  openclaw-weixin-login-session status --session-id <session_id>
```

- 再读状态文件：

```bash
cat /tmp/lightclaw-weixin-login/<session_id>/state.json
cat /tmp/lightclaw-weixin-login/<session_id>/output.log
```

排障判断：

- 如果 `state.json` 已是 `waiting_qr`，但 API 还停在 `starting`：
  - 优先怀疑 CTL 协议消费层
  - 重点看 `ctl/pkg/instance/weixin_login.go` 的轮询、回退和取消保护
- 如果 `state.json` 也是 `failed`：
  - 优先怀疑镜像协议脚本或实例内 OpenClaw/插件运行时
- 如果 `cancel` API 报错，但 `state.json` 已经是终态：
  - 优先怀疑 CTL 对 process 返回或状态回刷的处理

验证标准：

- 通过 `ctl` 创建微信 login session 后：
  - `GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}` 应返回 `status=waiting_qr`
  - 并带 `qr_ascii`
- `GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}/events`
  - 应返回 `200`
  - 首条事件应为 `event: snapshot`

## 6.1 微信登录控制面验证

微信登录不是短命令执行，而是会话型流程。当前 `ctl` 控制面能力已经具备以下接口：

- `POST /v1/instances/{id}/channels/weixin/login-sessions`
- `GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}`
- `GET /v1/instances/{id}/channels/weixin/login-sessions/{session_id}/events`
- `POST /v1/instances/{id}/channels/weixin/login-sessions/{session_id}/cancel`

推荐联调顺序：

1. 创建 session

```bash
curl -sS -X POST \
  -H 'X-User-Id: usr_<your_user_id>' \
  http://127.0.0.1:9590/v1/instances/<instance_id>/channels/weixin/login-sessions
```

2. 读取快照

```bash
curl -sS \
  -H 'X-User-Id: usr_<your_user_id>' \
  http://127.0.0.1:9590/v1/instances/<instance_id>/channels/weixin/login-sessions/<session_id>
```

预期：

- `status` 很快进入 `waiting_qr`
- `qr_ascii` 非空

3. 订阅 SSE

```bash
curl -N -sS \
  -H 'X-User-Id: usr_<your_user_id>' \
  -H 'Accept: text/event-stream' \
  http://127.0.0.1:9590/v1/instances/<instance_id>/channels/weixin/login-sessions/<session_id>/events
```

预期：

- 返回 `200`
- 立即收到：

```text
event: snapshot
data: {...}
```

前端接入建议：

1. 前端点击“绑定微信”后，先调 `POST create session`
2. 拿到 `session_id` 后，同时：
   - 拉一次 `GET snapshot`
   - 建立 `GET events` SSE 连接
3. UI 展示顺序：
   - 优先展示 `qr_ascii`
   - 若有 `qr_url`，作为“打开扫码页面”的辅助入口
4. SSE 断线时，退回 `GET snapshot` 轮询

当前现实约束：

- `qr_url` 不保证稳定拿到，而且它是扫码落地页 URL，不是二维码图片 URL
- `qr_ascii` 是当前最可靠的返回形式
- 默认烟测只要求稳定到 `waiting_qr`
- 没有扫码完成时，不应期待 session 进入 `success`

#### reset-db 被残留容器阻挡

- `dev.sh reset-db` 只管 `docker-compose.yml`（MySQL/Redis），不影响监控栈
- 如果看到容器名冲突，检查是否有其他 compose project 创建了同名容器
- 监控栈容器（`ctl-dev-prometheus` 等）由 `docker-compose.monitoring.yml` 独立管理

## 7. 脚本维护规则

当 Agent 修改本地回归脚本时，应遵守：

- 优先保持脚本幂等，可重复执行
- 脚本要明确区分“代码 bug”和“环境未准备好”
- 对异步接口不要再按同步语义断言
- 优先增加前置检查，减少长时间无意义轮询
- 如脚本依赖本地 rewrite 配置，应直接提示对应的 `port-forward` 命令
- 修改脚本后至少验证：
  - `python3 ctl/scripts/tests/smoke_local_api.py --help`
  - `python3 ctl/scripts/tests/regression_local_api.py --help`
  - 在当前本地环境下实际执行一遍
- 除非用户主动要求，否则不要为旧 Bash 脚本保留兼容入口

## 8. Agent 执行约束

当 Agent 被要求”本地启动并验证 `ctl`”时，默认执行顺序应为：

1. 检查 migration 状态
2. 检查 sandbox `port-forward`
3. 用 `./conf/local/services.sh start` 启动三服务
4. 按需用 `./conf/local/services.sh monitor-up` 启动监控栈
5. 先跑 `ctl/scripts/tests/smoke_local_api.py`
6. 需要更完整验证时，再跑 `ctl/scripts/tests/regression_local_api.py`
7. 若失败，优先修复代码或脚本，再重新验证

不要只启动 `api` 就宣称本地联调通过。

### 本地文件职责速查

| 文件 | 管什么 | 谁调用 |
|------|--------|--------|
| `conf/local/docker-compose.yml` | MySQL + Redis | `dev.sh` |
| `conf/local/docker-compose.monitoring.yml` | Prometheus + Grafana + Alertmanager | `services.sh monitor-up/down` |
| `conf/local/dev.sh` | DB 生命周期（start/stop/reset-db/migrate） | 手动或 Agent |
| `conf/local/services.sh` | 三服务 + 监控栈启停 | 手动或 Agent |
| `conf/local/common/server_conf.toml` | 本地服务配置 | 三服务读取 |
| `conf/local/rewrite/server_conf_rewrite.toml` | 本地覆盖（如 sandbox URL） | 三服务读取 |
