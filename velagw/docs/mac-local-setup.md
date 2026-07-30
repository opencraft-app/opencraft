# Mac 本地启动指南

这份文档面向一台全新的 Mac，目标是在本地跑起一套可操作的 LLMGateway：

- 两个独立的 `new-api` set：`set-a`、`set-b`
- LLMGateway 控制面：`http://127.0.0.1:18080`
- LLMGateway 流量面：`http://127.0.0.1:18082`
- LLMGateway 管理控制台前端：`http://127.0.0.1:18081`
- LLMGateway 自己的 MySQL：`127.0.0.1:33306`
- LLMGateway 流量路由 Redis：`127.0.0.1:36379`

## 1. 准备 Mac 依赖

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

安装 Homebrew 后，安装常用工具：

```bash
brew install git go bun jq tmux
```

安装并启动 Docker Desktop 或 OrbStack。推荐 OrbStack；如果使用 Docker Desktop，需要确认 Docker daemon 已经启动：

```bash
docker version
docker compose version
```

建议给 Docker/OrbStack 至少 `6GB` 内存。这个本地拓扑会同时跑 LLMGateway MySQL、LLMGateway Redis、两个 new-api、两个 new-api MySQL 和两个 Redis。

确认 Go 和 Bun 可用：

```bash
go version
bun --version
```

如果 `brew install bun` 在当前网络环境不可用，可以改用 Bun 官方安装脚本：

```bash
curl -fsSL https://bun.sh/install | bash
exec "$SHELL"
bun --version
```

Go 需要 `1.22+`。如果公司网络需要 Git SSH，先确认工蜂 SSH key 已可用：

```bash
ssh -T git@git.woa.com
```

## 2. 拉取代码

```bash
mkdir -p ~/code
cd ~/code
git clone git@git.woa.com:wisp/velagw.git
cd velagw
```

后续命令默认都在 `~/code/velagw` 下执行。

## 3. 启动本地依赖容器

下面的命令会创建一个 Docker network，并启动：

- `llmgateway-mysql`：LLMGateway 控制面数据库，映射到宿主机 `33306`
- `llmgateway-redis`：LLMGateway 流量路由 Redis，映射到宿主机 `36379`
- `newapi-a`：第一个 new-api set，映射到宿主机 `13001`
- `newapi-b`：第二个 new-api set，映射到宿主机 `13002`
- 每个 new-api set 自己独立的 MySQL 和 Redis

```bash
docker network create llmgateway-local 2>/dev/null || true

docker rm -f \
  llmgateway-mysql llmgateway-redis \
  newapi-mysql-a newapi-redis-a newapi-a \
  newapi-mysql-b newapi-redis-b newapi-b \
  2>/dev/null || true

docker run -d --name llmgateway-mysql \
  --network llmgateway-local \
  -p 33306:3306 \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=llmgateway \
  mysql:8.4

docker run -d --name llmgateway-redis \
  --network llmgateway-local \
  -p 36379:6379 \
  redis:7-alpine redis-server --requirepass 123456

docker run -d --name newapi-mysql-a \
  --network llmgateway-local \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=new-api \
  mysql:8.4

docker run -d --name newapi-redis-a \
  --network llmgateway-local \
  redis:7-alpine redis-server --requirepass 123456

docker run -d --name newapi-mysql-b \
  --network llmgateway-local \
  -e MYSQL_ROOT_PASSWORD=123456 \
  -e MYSQL_DATABASE=new-api \
  mysql:8.4

docker run -d --name newapi-redis-b \
  --network llmgateway-local \
  redis:7-alpine redis-server --requirepass 123456
```

等待 MySQL 和 Redis 就绪：

```bash
until docker exec llmgateway-mysql mysqladmin ping -uroot -p123456 --silent; do sleep 1; done
until docker exec llmgateway-redis redis-cli -a 123456 ping | grep -q PONG; do sleep 1; done
until docker exec newapi-mysql-a mysqladmin ping -uroot -p123456 --silent; do sleep 1; done
until docker exec newapi-mysql-b mysqladmin ping -uroot -p123456 --silent; do sleep 1; done
until docker exec newapi-redis-a redis-cli -a 123456 ping | grep -q PONG; do sleep 1; done
until docker exec newapi-redis-b redis-cli -a 123456 ping | grep -q PONG; do sleep 1; done
```

启动两个 new-api set：

```bash
NEWAPI_IMAGE='calciumion/new-api@sha256:3125e24f119fa5e767563226a5208f2902b3faed3f27b69ea275b32c9f04a066'

docker run -d --name newapi-a \
  --network llmgateway-local \
  -p 13001:3000 \
  -e SQL_DSN='root:123456@tcp(newapi-mysql-a:3306)/new-api' \
  -e REDIS_CONN_STRING='redis://:123456@newapi-redis-a:6379' \
  -e SESSION_SECRET='llmgateway-local-set-a-session-secret' \
  -e TZ='Asia/Shanghai' \
  -e GLOBAL_API_RATE_LIMIT_ENABLE=false \
  -e GLOBAL_WEB_RATE_LIMIT_ENABLE=false \
  -e CRITICAL_RATE_LIMIT_ENABLE=false \
  -e SEARCH_RATE_LIMIT_ENABLE=false \
  -e BATCH_UPDATE_ENABLED=true \
  -e NODE_NAME='newapi-a' \
  "$NEWAPI_IMAGE" --log-dir /app/logs

docker run -d --name newapi-b \
  --network llmgateway-local \
  -p 13002:3000 \
  -e SQL_DSN='root:123456@tcp(newapi-mysql-b:3306)/new-api' \
  -e REDIS_CONN_STRING='redis://:123456@newapi-redis-b:6379' \
  -e SESSION_SECRET='llmgateway-local-set-b-session-secret' \
  -e TZ='Asia/Shanghai' \
  -e GLOBAL_API_RATE_LIMIT_ENABLE=false \
  -e GLOBAL_WEB_RATE_LIMIT_ENABLE=false \
  -e CRITICAL_RATE_LIMIT_ENABLE=false \
  -e SEARCH_RATE_LIMIT_ENABLE=false \
  -e BATCH_UPDATE_ENABLED=true \
  -e NODE_NAME='newapi-b' \
  "$NEWAPI_IMAGE" --log-dir /app/logs
```

确认两个 set 可访问：

```bash
until curl -fsS http://127.0.0.1:13001/api/status >/dev/null; do sleep 1; done
until curl -fsS http://127.0.0.1:13002/api/status >/dev/null; do sleep 1; done
```

## 4. 启动 LLMGateway 后端

本地推荐按生产形态拆成六个进程：控制面、流量面，以及 core、BYOK、observer、maintenance 四类后台 worker。

终端 A，启动控制面：

```bash
cd ~/code/velagw

LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' \
LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' \
LLMGATEWAY_TRAFFIC_BASE_URL='http://127.0.0.1:18082' \
CLUSTER_ADMIN_USERNAME='cluster-admin' \
CLUSTER_ADMIN_PASSWORD='Qq373866172!' \
CLUSTER_ADMIN_TOKEN='dev-cluster-token' \
INTERNAL_SERVICE_TOKEN='dev-internal-token' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
go run ./cmd/llmgateway-control
```

`LLMGATEWAY_TRAFFIC_BASE_URL` 供管理台推理自检的“统一网关”模式使用；“直连 Set”模式会根据 external key binding 读取对应 Set 的 `traffic_base_url`。

终端 B，启动流量面：

```bash
cd ~/code/velagw

PORT=18082 \
LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' \
CLUSTER_ADMIN_TOKEN='dev-cluster-token' \
INTERNAL_SERVICE_TOKEN='dev-internal-token' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
go run ./cmd/llmgateway-traffic
```

终端 C，启动 core worker：

```bash
cd ~/code/velagw

LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' \
CLUSTER_ADMIN_TOKEN='dev-cluster-token' \
INTERNAL_SERVICE_TOKEN='dev-internal-token' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
LLMGATEWAY_WORKER_POOL=core \
LLMGATEWAY_WORKER_POLL_INTERVAL=5s \
LLMGATEWAY_WORKER_LEASE_TTL=1m \
go run ./cmd/llmgateway-worker
```

终端 D，启动 BYOK worker：

```bash
cd ~/code/velagw

LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' \
LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
LLMGATEWAY_WORKER_POOL=byok \
go run ./cmd/llmgateway-worker
```

终端 E，启动 observer worker：

```bash
cd ~/code/velagw

LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
LLMGATEWAY_WORKER_POOL=observer \
LLMGATEWAY_WORKER_POLL_INTERVAL=2s \
go run ./cmd/llmgateway-worker
```

终端 F，启动 maintenance worker（用户删除等低频维护）：

```bash
cd ~/code/velagw

LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' \
LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' \
NEWAPI_SET_ROOT_USERNAME='set-root' \
NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' \
LLMGATEWAY_WORKER_POOL=maintenance \
LLMGATEWAY_WORKER_POLL_INTERVAL=2s \
go run ./cmd/llmgateway-worker
```

健康检查：

```bash
curl -fsS http://127.0.0.1:18080/healthz
curl -fsS http://127.0.0.1:18082/healthz
```

预期：

- `18080` 有管理 API，不暴露 `/v1/*`
- `18082` 有 `/v1/*`，不暴露管理 API
- 四类 worker 都不暴露 HTTP；core 跑集群任务，BYOK、observer 和 maintenance 按用户任务水平扩展

```bash
curl -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer dev-cluster-token' \
  http://127.0.0.1:18080/api/sets

curl -o /dev/null -w '%{http_code}\n' \
  -H 'Authorization: Bearer dev-cluster-token' \
  http://127.0.0.1:18082/api/sets
```

应分别返回 `200` 和 `404`。

## 5. 启动管理控制台前端

终端 C：

```bash
cd ~/code/velagw/web

cat > .env.local <<'EOF'
VITE_CLUSTER_ADMIN_TOKEN=dev-cluster-token
EOF

bun install
bun run dev
```

打开：

```text
http://127.0.0.1:18081
```

前端 dev server 会把控制面 API `/api`、内嵌控制台壳 `/_llmgateway_console`、`/console-sw.js` 等路径代理到 `http://localhost:18080`，把 OpenAI-compatible 流量 `/v1/*` 代理到流量面 `http://localhost:18082`。

集群预览 iframe 会直接打开控制面的 `http://localhost:18080/_llmgateway_console/<set-id>/dashboard`。这里不是 Vite 代理 `/dashboard`，而是 LLMGateway 控制面按路径中的 Set ID 反代对应 new-api 控制台。Service Worker 只按 iframe 的 `clientId` 续接绝对 `/api/*` 请求；共享 Cookie 不参与 Set 路由。

如果是 Agent 或不想手动开多个终端，可以用 `tmux` 方式启动这些本地进程：

```bash
cd ~/code/velagw

tmux kill-session -t velagw-control 2>/dev/null || true
tmux kill-session -t velagw-traffic 2>/dev/null || true
tmux kill-session -t velagw-worker-core 2>/dev/null || true
tmux kill-session -t velagw-worker-byok 2>/dev/null || true
tmux kill-session -t velagw-worker-observer 2>/dev/null || true
tmux kill-session -t velagw-worker-maintenance 2>/dev/null || true
tmux kill-session -t velagw-web 2>/dev/null || true

tmux new-session -d -s velagw-control -c ~/code/velagw \
  "LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' CLUSTER_ADMIN_USERNAME='cluster-admin' CLUSTER_ADMIN_PASSWORD='Qq373866172!' CLUSTER_ADMIN_TOKEN='dev-cluster-token' INTERNAL_SERVICE_TOKEN='dev-internal-token' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' go run ./cmd/llmgateway-control"

tmux new-session -d -s velagw-traffic -c ~/code/velagw \
  "PORT=18082 LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' CLUSTER_ADMIN_TOKEN='dev-cluster-token' INTERNAL_SERVICE_TOKEN='dev-internal-token' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' go run ./cmd/llmgateway-traffic"

tmux new-session -d -s velagw-worker-core -c ~/code/velagw \
  "LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' CLUSTER_ADMIN_TOKEN='dev-cluster-token' INTERNAL_SERVICE_TOKEN='dev-internal-token' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' LLMGATEWAY_WORKER_POOL=core LLMGATEWAY_WORKER_POLL_INTERVAL=5s LLMGATEWAY_WORKER_LEASE_TTL=1m go run ./cmd/llmgateway-worker"

tmux new-session -d -s velagw-worker-byok -c ~/code/velagw \
  "LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' LLMGATEWAY_WORKER_POOL=byok go run ./cmd/llmgateway-worker"

tmux new-session -d -s velagw-worker-observer -c ~/code/velagw \
  "LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' LLMGATEWAY_WORKER_POOL=observer LLMGATEWAY_WORKER_POLL_INTERVAL=2s go run ./cmd/llmgateway-worker"

tmux new-session -d -s velagw-worker-maintenance -c ~/code/velagw \
  "LLMGATEWAY_SQL_DSN='root:123456@tcp(127.0.0.1:33306)/llmgateway?parseTime=true&loc=UTC&charset=utf8mb4' LLMGATEWAY_KEY_ROUTE_CACHE_REDIS_URL='redis://:123456@127.0.0.1:36379/0' NEWAPI_SET_ROOT_USERNAME='set-root' NEWAPI_SET_ROOT_PASSWORD='Qq373866172!' LLMGATEWAY_WORKER_POOL=maintenance LLMGATEWAY_WORKER_POLL_INTERVAL=2s go run ./cmd/llmgateway-worker"

cd ~/code/velagw/web
cat > .env.local <<'EOF'
VITE_CLUSTER_ADMIN_TOKEN=dev-cluster-token
EOF
bun install

tmux new-session -d -s velagw-web -c ~/code/velagw/web \
  "bun run dev"

tmux ls
tmux capture-pane -pt velagw-control:0 -S -80
tmux capture-pane -pt velagw-traffic:0 -S -80
tmux capture-pane -pt velagw-worker-core:0 -S -80
tmux capture-pane -pt velagw-worker-byok:0 -S -80
tmux capture-pane -pt velagw-worker-observer:0 -S -80
tmux capture-pane -pt velagw-web:0 -S -80
```

## 6. 纳管两个 new-api set

可以在控制台页面里点“纳管集群”和“重新纳管”。如果想用命令行初始化：

```bash
curl -fsS -X POST http://127.0.0.1:18080/api/sets \
  -H 'authorization: Bearer dev-cluster-token' \
  -H 'content-type: application/json' \
  -d '{"id":"set-a","name":"集群 A","base_url":"http://localhost:13001","status":"active"}'

curl -fsS -X POST http://127.0.0.1:18080/api/sets/set-a/bootstrap \
  -H 'authorization: Bearer dev-cluster-token'

curl -fsS -X POST http://127.0.0.1:18080/api/sets \
  -H 'authorization: Bearer dev-cluster-token' \
  -H 'content-type: application/json' \
  -d '{"id":"set-b","name":"集群 B","base_url":"http://localhost:13002","status":"active"}'

curl -fsS -X POST http://127.0.0.1:18080/api/sets/set-b/bootstrap \
  -H 'authorization: Bearer dev-cluster-token'
```

刷新 `http://127.0.0.1:18081` 后，概览页应该能看到两个集群。点击集群预览时，内嵌 new-api 控制台应该显示新版 `/dashboard`，而不是 404。

注意：内嵌 new-api 控制台是上游管理界面，页面里如果出现示例推理地址，可能会按 iframe 当前域名展示。LLMGateway 本地对外推理入口以流量面为准，也就是 `http://127.0.0.1:18082/v1/*`；前端开发环境里的 `/v1/*` 也会代理到这个端口。

部分 new-api 管理 API，例如订阅计划配置，会拒绝 access token，要求 dashboard session。LLMGateway 控制面会在这类响应上自动使用纳管 root 的 dashboard session 重放请求；如果仍看到 `API access token is not allowed`，先重新执行对应 set 的 bootstrap。

## 7. 本地推理 E2E 和可选真实渠道

可复现 E2E 默认会启动一个本地 OpenAI-compatible fake upstream：
`kagent-dev/mockllm`。配置在 `test/e2e/mockllm/config.json`，集群清单
`test/e2e/cluster.compose.yaml` 中的默认值是：

```yaml
mock_llm:
  api_key: sk-mockllm-local
  base_url: http://mockllm:8080
  model: llmgw-mock-chat
```

因此即使没有真实 provider key，`bash test/e2e/run.sh` 也会完成一条真实
HTTP 链路：LLMGateway 保存配置包、先同步 `ModelRatio`/`CompletionRatio`
等定价 option、再同步渠道到两个 Set，随后签发用户 key，并通过
`/v1/chat/completions` 验证非流式和流式响应。

如果要跑业务画像压测，可以使用同一个 compose 网络里的 Go load runner。
短烟测：

```bash
docker compose -p llmgateway-load -f test/e2e/compose.yaml --profile load run --build --rm \
  -e LOAD_USERS=5 \
  -e LOAD_RUN_DURATION=20s \
  -e LOAD_USER_ARRIVAL_INTERVAL=100ms \
  -e LOAD_CHAT_INTERVAL=1s \
  load-runner
```

完整默认画像：

```bash
docker compose -p llmgateway-load -f test/e2e/compose.yaml --profile load run --build --rm load-runner
```

默认画像是 1000 个用户、每 0.5 秒新增 1 个用户、每个用户每 3 秒调用一次
`/v1/chat/completions`、每个用户配置 2 个 BYOK provider、每 1 秒配置一个，
平台侧预置 4 个 channel。默认运行 10 分钟；`LOAD_RUN_DURATION=0` 表示一直
跑到手动停止。

如果你有 OpenAI-compatible provider，可以在 LLMGateway 控制台的“渠道”页面从黄金 set 导入/发布配置包。也可以先用 E2E live 配置验证链路。不要把真实 key 提交到 Git：

```bash
cat > test/e2e/.env.local <<'EOF'
LLMGATEWAY_LIVE_API_KEY=sk-your-provider-key
LLMGATEWAY_LIVE_BASE_URL=https://tokenhub.tencentmaas.com
LLMGATEWAY_LIVE_MODEL=minimax-m2.7
EOF
```

`test/e2e/.env.local` 已经在 `.gitignore` 中。

## 8. 跑测试

后端单元测试：

```bash
go test ./...
```

前端测试和构建：

```bash
cd web
bun run test
bun run build
```

可复现 E2E。这个命令会自己启动一套隔离 Docker Compose 集群，不依赖上面手工启动的本地容器：

```bash
cd ~/code/velagw
bash test/e2e/run.sh
```

如果只想验证基础服务端口：

```bash
curl -fsS http://127.0.0.1:18080/readyz
curl -fsS http://127.0.0.1:18082/readyz
curl -fsS http://127.0.0.1:13001/api/status
curl -fsS http://127.0.0.1:13002/api/status
```

## 9. 常见问题

### 端口被占用

本地默认占用：

| 端口 | 用途 |
| --- | --- |
| `13001` | new-api set-a |
| `13002` | new-api set-b |
| `18080` | LLMGateway 控制面 |
| `18081` | LLMGateway 前端 dev server |
| `18082` | LLMGateway 流量面 |
| `33306` | LLMGateway MySQL |

检查占用：

```bash
lsof -nP -iTCP:18080 -sTCP:LISTEN
```

### 集群预览显示 404

先确认控制面是最新代码，并且 iframe 地址类似：

```text
http://localhost:18080/_llmgateway_console/set-a/dashboard
```

如果看到 `/console/user`，说明前端没有刷新到新版本，重启 `bun run dev` 并刷新浏览器。

### 预览空白或接口 401

重新纳管 set：

```bash
curl -fsS -X POST http://127.0.0.1:18080/api/sets/set-a/bootstrap \
  -H 'authorization: Bearer dev-cluster-token'
```

如果仍失败，看控制面日志里是否有 `invalid access token`。LLMGateway 会在部分控制台 API 失败时刷新 admin token，但空 set 首次初始化仍需要 bootstrap 成功。

### 订阅计划页面或合规接口返回 403

如果错误信息包含 `dashboard session authentication` 或 `API access token is not allowed`，说明上游 new-api 这个接口不接受 access token。先重新纳管 set；LLMGateway 会用纳管 root 的 2FA session 自动重放这类请求。

### Docker 容器清理

```bash
docker rm -f \
  llmgateway-mysql \
  newapi-mysql-a newapi-redis-a newapi-a \
  newapi-mysql-b newapi-redis-b newapi-b \
  2>/dev/null || true

docker network rm llmgateway-local 2>/dev/null || true
```

### 重新开始一套干净数据

执行上面的清理命令后，从“启动本地依赖容器”重新开始即可。所有 MySQL 容器没有挂宿主机 volume，删除容器后数据会一起清空。
