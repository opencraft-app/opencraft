# 简易 curl 测试手册

默认假设你已经通过 `./scripts/dev-compose.sh up --build` 启动本地环境，服务监听 `http://localhost:8080`。

## Docker Compose 端到端测试
```bash
./scripts/e2e/run.sh
```

保留环境用于排查：
```bash
KEEP_COMPOSE=true ./scripts/e2e/run.sh
```

## 腾讯云真实账号 smoke test
用于验证当前仓库已经能直接打到真实腾讯云账号，跑通：

- `CreateInstance`
- `DescribeInstance`
- `TerminateInstance`

这个 live test 默认不会执行，只有显式设置开关才会跑。

需要的环境变量：

- `SANDBOX_TENCENT_LIVE=1`
- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `TENCENT_REGION`
- `TENCENT_INSTANCE_TYPE` 或 `SANDBOX_TENCENT_LIVE_INSTANCE_TYPE`
- `SANDBOX_TENCENT_LIVE_ZONE`
- `SANDBOX_TENCENT_LIVE_VPC_ID`
- `SANDBOX_TENCENT_LIVE_SUBNET_ID`
- `SANDBOX_TENCENT_LIVE_SECURITY_GROUPS`
- `SANDBOX_TENCENT_LIVE_IMAGE_ID`
- 以及登录方式二选一：
  - `TENCENT_INSTANCE_PASSWORD`
  - `TENCENT_KEY_PAIR_ID`

执行：
```bash
# 在 sandbox/ 目录下执行
GOWORK=off go test ./internal/provider -run TestTencentCloudProviderLiveCreateAndTerminateInstance -count=1 -v
```

说明：

- 该测试会真实创建一台 CVM，然后在 `defer` 里终止它
- 如果 `CreateInstance` 成功而 `TerminateInstance` 失败，测试会直接失败，避免静默遗留实例
- 这条 live test 只验证账号、地域、VPC/子网、安全组、镜像、实例创建和销毁链路是否可用
- 线上高风险错误场景（如安全组限额、子网 IP 不足、可用区售罄）仍建议通过模拟真实腾讯云错误码的单测覆盖

## 健康检查
```bash
curl -s http://localhost:8080/health | jq .
```

## 创建池
```bash
curl -s -X POST http://localhost:8080/pools \
  -H 'Content-Type: application/json' \
  -d '{"name":"pool-a","description":"demo","base_image":"img-xxxx"}' | jq .
```
记下返回的 `id` 作为 `POOL_ID`。

## 补货（库存入库 CLEAN）
```bash
# 自动生成地址
curl -s -X POST http://localhost:8080/pools/$POOL_ID/inventory \
  -H 'Content-Type: application/json' \
  -d '{"count":2}' | jq .

# 指定地址（数量由地址决定，count 将被忽略）
curl -s -X POST http://localhost:8080/pools/$POOL_ID/inventory \
  -H 'Content-Type: application/json' \
  -d '{"count":2,"addresses":["192.168.0.10","192.168.0.11"]}' | jq .
```

## 查看池内实例
```bash
curl -s http://localhost:8080/pools/$POOL_ID/instances | jq .
```

## 业务分配（CLEAN → ALLOCATED）
```bash
curl -s -X POST http://localhost:8080/pools/$POOL_ID/allocate | jq .
```
记下返回的 `id` 作为 `INSTANCE_ID`。

## 业务释放（ALLOCATED → DRY）
```bash
curl -s -X POST http://localhost:8080/instances/$INSTANCE_ID/release | jq .
```

## Worker 推进状态
- DRY → RESETTING：
```bash
curl -s -X PATCH http://localhost:8080/instances/$INSTANCE_ID/state \
  -H 'Content-Type: application/json' \
  -d '{"target_state":"RESETTING"}' | jq .
```
- RESETTING → CLEAN：
```bash
curl -s -X PATCH http://localhost:8080/instances/$INSTANCE_ID/state \
  -H 'Content-Type: application/json' \
  -d '{"target_state":"CLEAN"}' | jq .
```

说明：

- 本地 compose 和 e2e 都统一读取 `.secret/sandbox/local.env`（相对仓库根目录）
- 如果命令执行失败，先运行 `./scripts/dev-compose.sh config` 或 `KEEP_COMPOSE=true ./scripts/e2e/run.sh` 检查渲染后的环境
