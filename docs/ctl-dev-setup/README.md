# ctl 本地联调开发指南

> **注意**：本文档为早期联调记录，包含详细的环境排查日志和 pool/子网明细。
> 标准本地启动流程请优先阅读：[CTL Local Run Guide](../agent-guides/ctl-local-run-guide.md)

本文档帮助开发者快速在本地启动 ctl 服务，连接 sandbox 测试集群进行联调。

## 前置条件

- Go 1.26+
- Docker & Docker Compose
- `kubectl`
- 可访问测试集群 kubeconfig：`.secret/cls-8gnhos9p-config`
- 本地敏感配置：`.secret/ctl/local.env`
  - 可从 [ctl/conf/secret-templates/local.env.example](../../ctl/conf/secret-templates/local.env.example) 复制模板
  - 若缺失，请向团队索取 `.secret` 目录离线包
- 已为联调用户初始化 `user_resource_quota`

## 项目结构

```
ctl/
├── main/
│   ├── api/main.go       # API 服务入口（HTTP，端口 9590）
│   ├── service/main.go   # MQ 消费者服务入口
│   └── bypass/main.go    # Bypass 工具入口
├── conf/
│   ├── server/           # 线上/测试环境配置（不可修改）
│   └── local/            # 本地开发配置（git 跟踪）
│       ├── common/server_conf.toml    # 主配置文件
│       ├── rewrite/server_conf_rewrite.toml  # 覆盖配置
│       ├── docker-compose.yml          # 本地 MySQL + Redis
│       └── dev.sh                      # 一键启停脚本
├── migrations/               # 数据库迁移文件
└── go.work                   # monorepo workspace（根目录）
```

## 快速启动

### 当前联调建议（2026-03-21）

测试环境当前有两个已确认问题：

- `sandbox-api` 公网 CLB `lb-a8iar6q7-6v49t2ofpg7zwed8.clb.bj-tencentclb.com` 从本地访问返回 `502 Server UnReachable`
- `pool-c0` / `pool-c1` 没有可分配库存；sandbox worker 持续报 `InvalidZone.MismatchRegion`

为了先打通“本地 ctl -> 测试环境 sandbox 集群”的联调链路，建议先使用下面的临时方案：

```bash
# 建立本地到测试环境 sandbox-api 的转发
KUBECONFIG=.secret/cls-8gnhos9p-config \
  kubectl port-forward -n sandbox svc/sandbox-api 18081:80
```

然后在 `ctl/conf/local/rewrite/server_conf_rewrite.toml` 覆盖：

```toml
[adapter.sandbox]
baseUrl = "http://127.0.0.1:18081"

[api.instance]
default_template_id = "pool-c3"
candidate_template_ids = ["pool-c2", "pool-c3", "pool-c4", "pool-c5"]
```

补充说明（`2026-03-28`）：

- 当前测试环境 `ctl` 实际配置是 `default_template_id = "pool-c3"`
- 当前测试环境 `ctl` 实际候选池是 `pool-c0~pool-c5`
- `pool-bj8` 目前保留给 `sandbox` 侧兜底，不是 `ctl` 默认入口

排障时请注意：

- `sandbox/k8s/base/manifests.yaml` 只能作为仓库中的参考清单，不保证和测试集群当前实际生效配置完全一致
- 涉及 CLB、Deployment、ConfigMap、镜像 tag、replicas、运行时环境变量时，应优先以 `kubectl get ... -o yaml` 和实时日志为准
- 本次排障里，集群实际对象与仓库清单大体一致，但“公网 CLB 不通、pool 库存异常”的结论是通过实时集群状态确认的，不是仅凭 repo 文件推断

### 1. 准备 `.secret` 本地配置

```bash
mkdir -p .secret/ctl
cp ctl/conf/secret-templates/local.env.example \
  .secret/ctl/local.env
```

填写真实值后，`dev.sh` / `services.sh` 会在启动前自动渲染运行时配置到：

- `/tmp/mono-rendered/ctl/local`

### 2. 启动本地依赖（MySQL + Redis）

```bash
cd ctl
./conf/local/dev.sh start
```

启动后可通过以下命令管理：

| 命令 | 说明 |
|---|---|
| `./conf/local/dev.sh start` | 启动 MySQL + Redis |
| `./conf/local/dev.sh stop` | 停止并删除容器 |
| `./conf/local/dev.sh logs` | 查看容器日志 |
| `./conf/local/dev.sh status` | 查看容器状态 |
| `./conf/local/dev.sh restart` | 重启容器，不清空 volume |
| `./conf/local/dev.sh migrate` | 对本地 MySQL 执行全部 migration |
| `./conf/local/dev.sh seed-quota` | 写入默认联调用配额 |
| `./conf/local/dev.sh reset-db` | 清空本地 DB volume 并自动执行 migrate + seed |

本地依赖地址（使用非标准端口避免冲突）：

| 服务 | 地址 | 用户名/密码 | 数据库 |
|---|---|---|---|
| MySQL | `127.0.0.1:13306` | root / 来自 `.secret/ctl/local.env` | `ctl` |
| Redis | `127.0.0.1:16379` | 密码来自 `.secret/ctl/local.env` | - |

### 3. 启动 ctl API 服务

```bash
cd ctl
./conf/local/services.sh start
```

服务启动后：
- API 地址：`http://0.0.0.0:9590`
- 健康检查：`curl http://127.0.0.1:9590/health`
- Pprof：`http://127.0.0.1:9591/debug/pprof/`

其他服务入口（按需使用）：
```bash
bash ctl/scripts/render-secrets.sh --env local
go run ./main/service -conf-dir /tmp/mono-rendered/ctl/local
go run ./main/bypass  -conf-dir /tmp/mono-rendered/ctl/local
```

### 4. 初始化联调用配额

如果你是从空 volume 启动本地环境，推荐直接执行：

```bash
cd ctl
./conf/local/dev.sh reset-db
```

如果你已经启动好了容器，只想补 schema 和基础数据，执行：

```bash
cd ctl
./conf/local/dev.sh migrate
./conf/local/dev.sh seed-quota
```

当前 API 使用 `X-User-Id` 作为用户标识，联调前需要先保证该用户有实例配额。

可直接执行：

```bash
cd ctl
make seed-local-quota LOCAL_QUOTA_USER_ID=10001 LOCAL_QUOTA_TOTAL=5
```

等价 SQL 如下，密码需从 `.secret/ctl/local.env` 读取：

```sql
INSERT INTO user_resource_quota (
  user_id,
  resource_name,
  resource_key,
  resource_quota_total,
  resource_quota_available,
  created_time,
  updated_time
) VALUES (
  '10001',
  'OPENCLAW_INSTANCE',
  '',
  5,
  5,
  NOW(),
  NOW()
)
ON DUPLICATE KEY UPDATE
  resource_quota_total = VALUES(resource_quota_total),
  resource_quota_available = VALUES(resource_quota_available),
  updated_time = NOW();
```

### 5. 验证

```bash
# 检查依赖
docker ps --filter "name=ctl-dev"

# 检查 API
curl -s http://127.0.0.1:9590/health
# 期望输出: ok

# 检查数据库连接
source .secret/ctl/local.env
docker exec ctl-dev-mysql mysql -uroot -p"$CTL_LOCAL_MYSQL_ROOT_PASSWORD" ctl -e "SHOW TABLES;"

# 检查 Redis
docker exec ctl-dev-redis redis-cli -a "$CTL_LOCAL_REDIS_PASSWORD" ping
```

如果要直接回归本地 REST API 与 sandbox 联调链路，可执行：

```bash
# 在仓库根目录下执行
python3 ctl/scripts/tests/regression_local_api.py --user-id 10001 --template-id pool-c3
```

当前脚本会额外验证：

- Resume 不传 timeout 时默认使用 15 秒
- 重复 Pause / Resume 是否幂等或正确拒绝
- 配额打满后是否返回 `INSTANCE_QUOTA_EXCEEDED`

默认脚本会验证：

- `GET /health`
- `POST /v1/instances`
- `GET /v1/instances`
- `GET /v1/instances/{instance_id}`
- `POST /v1/instances/{instance_id}/pause`
- `POST /v1/instances/{instance_id}/resume`
- `POST /v1/instances/{instance_id}/timeout`
- `DELETE /v1/instances/{instance_id}`

查看帮助：

```bash
python3 ctl/scripts/tests/regression_local_api.py --help
```

## 配置说明

模板配置位于 `ctl/conf/local`，运行时配置会在启动前渲染到 `/tmp/mono-rendered/ctl/local`。以下是本地联调相关的关键配置项：

### 当前 API 风格（2026-03-21）

`ctl` 已移除 `mx-core` 和旧的 `POST /?Action=...` 调用方式，当前统一使用 REST JSON：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/instances` | 创建实例 |
| `GET` | `/v1/instances` | 查询实例列表 |
| `GET` | `/v1/instances/{instance_id}` | 查询实例详情 |
| `DELETE` | `/v1/instances/{instance_id}` | 销毁实例 |
| `POST` | `/v1/instances/{instance_id}/pause` | 暂停实例 |
| `POST` | `/v1/instances/{instance_id}/resume` | 恢复实例 |
| `POST` | `/v1/instances/{instance_id}/timeout` | 更新超时时间 |

请求头：

- `X-User-Id`
- 可选 `X-Request-Id`

示例：

```bash
curl -sS -X POST http://127.0.0.1:9590/v1/instances \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: usr_<your_user_id>' \
  -d '{"timeout":3600}'
```

### Sandbox 连接

```toml
[api.instance]
default_template_id = "pool-c3"    # 对应 sandbox 的 pool.ID
candidate_template_ids = ["pool-c0", "pool-c1", "pool-c2", "pool-c3", "pool-c4", "pool-c5"]

[adapter.sandbox]
baseUrl = "http://lb-a8iar6q7-6v49t2ofpg7zwed8.clb.bj-tencentclb.com"  # sandbox-api 公网 CLB
apiKey = ""                           # 可选，也可通过 SANDBOX_API_KEY 环境变量注入
timeout = 60                          # HTTP 超时（秒）
maxRetries = 3
retryInterval = 1000                  # 重试间隔（毫秒）
```

可用 template（pool）列表：

| templateID | pool.Name | Zone |
|---|---|---|
| `pool-bj8` | beijing-sandbox | ap-beijing-8 |
| `pool-c0` | claw-c0 | ap-beijing-4 |
| `pool-c1` | claw-c1 | ap-beijing-5 |
| `pool-c2` | claw-c2 | ap-beijing-6 |
| `pool-c3` | claw-c3 | ap-beijing-7 |
| `pool-c4` | claw-c4 | ap-beijing-6 |
| `pool-c5` | claw-c5 | ap-beijing-8 |

当前联调建议：

- `baseUrl` 优先使用本地 `port-forward` 地址 `http://127.0.0.1:18081`
- 当前测试环境 `ctl` 默认模板使用 `pool-c3`
- 当前测试环境 `ctl` 候选模板与 `ctl-conf-rewrite` 保持一致：`pool-c0~pool-c5`
- 如果只想挑当前更稳的池做联调，优先显式指定 `pool-c3` / `pool-c4` / `pool-c5`
- 暂不建议使用 `pool-c0` / `pool-c1`
- `pool-bj8` 当前不是 `ctl` 默认模板；如需使用，先以 `pools.base_image` 实时查询结果确认它是否仍承载目标镜像

设计上需要特别注意：

- sandbox 的每个 template/pool，本质上都是一组固定的云侧参数组合：`vpc_id + subnet_id + zone + base_image`
- 腾讯云 CVM 在同一个 VPC 下，不同可用区需要各自独立的子网
- 但“子网已经存在”不代表“当前账号一定还能在这个子网对应可用区买出机器”
- 本次在控制台上确认：当前账号购买页北京只能看到 `3/7/6/8`，看不到 `4/5`
- 因此 `pool-c0/c1` 绑定的北京四区/五区子网现在无法创建实例，是符合云侧现状的

本次确认到 `vpc-21gzr2dc`（`claw`）下的关键子网：

| subnet_id | 备注 | CIDR | Zone |
|---|---|---|---|
| `subnet-ieszm71b` | support | `10.15.224.0/19` | ap-beijing-8 |
| `subnet-apr9z44z` | c5 | `10.5.0.0/16` | ap-beijing-6 |
| `subnet-1iiuss0v` | c4 | `10.4.0.0/16` | ap-beijing-8 |
| `subnet-dsr6f02j` | c3 | `10.3.0.0/16` | ap-beijing-7 |
| `subnet-83va49sv` | c2 | `10.2.0.0/16` | ap-beijing-6 |
| `subnet-07q7chg3` | c0 | `10.0.0.0/16` | ap-beijing-4 |
| `subnet-642xx4yj` | c1 | `10.1.0.0/16` | ap-beijing-5 |

这带来的产品/调度启发是：

- 如果外部调用方追求更高创建成功率，不应只押注单个 `default_template_id`
- 更合理的策略是维护多个候选 template/pool，按优先级或轮询逐个尝试
- 当前 `ctl` 还没有内建这类多 template fallback 机制，现阶段仍由配置侧手工选择可用 pool
- 考虑到当前主要责任边界在 `ctl`，短期优先建议把兼容适配做在 `ctl`，不要急于直接修改 `sandbox` 的调度设计

实际联调时需要同时启动这两条命令：

```bash
cd ctl
go run ./main/api -conf-dir ./conf/local
```

```bash
KUBECONFIG=.secret/cls-8gnhos9p-config \
kubectl port-forward -n sandbox svc/sandbox-api 18081:80
```

## 常用调试命令速查

创建实例：

```bash
curl -sS -X POST http://127.0.0.1:9590/v1/instances \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: usr_<your_user_id>' \
  -d '{"timeout":3600}'
```

查询实例列表：

```bash
curl -sS 'http://127.0.0.1:9590/v1/instances?page=1&page_size=20' \
  -H 'X-User-Id: usr_<your_user_id>'
```

暂停实例：

```bash
curl -sS -X POST http://127.0.0.1:9590/v1/instances/<instance_id>/pause \
  -H 'X-User-Id: usr_<your_user_id>'
```

恢复实例：

```bash
curl -sS -X POST http://127.0.0.1:9590/v1/instances/<instance_id>/resume \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: usr_<your_user_id>' \
  -d '{"timeout":60}'
```

设置超时：

```bash
curl -sS -X POST http://127.0.0.1:9590/v1/instances/<instance_id>/timeout \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: usr_<your_user_id>' \
  -d '{"timeout":120}'
```

销毁实例：

```bash
curl -sS -X DELETE http://127.0.0.1:9590/v1/instances/<instance_id> \
  -H 'X-User-Id: usr_<your_user_id>'
```

查看本地 quota：

```bash
source .secret/ctl/local.env
docker exec -i ctl-dev-mysql mysql -uroot -p"$CTL_LOCAL_MYSQL_ROOT_PASSWORD" ctl -e \
  "SELECT user_id, resource_name, resource_quota_total, resource_quota_available FROM user_resource_quota;"
```

查看实例表：

```bash
source .secret/ctl/local.env
docker exec -i ctl-dev-mysql mysql -uroot -p"$CTL_LOCAL_MYSQL_ROOT_PASSWORD" ctl -e \
  "SELECT instance_id, sandbox_id, status, timeout_at, deleted_at FROM instances ORDER BY id DESC LIMIT 20;"
```

镜像联调专用测试池（2026-03-21）：

- `pool-bj8-imgfqud`
- name: `beijing-sandbox-imgfqud`
- `base_image = img-fqudgz8r`
- `vpc_id = vpc-21gzr2dc`
- `subnet_id = subnet-ieszm71b`
- `zone = ap-beijing-8`
- `security_groups = sg-hrhn5nf5`

后续凡是验证 `img-fqudgz8r` 或相关 sandbox 镜像问题，优先使用这个 pool，不要再复用 `pool-c0`。

`img-fqudgz8r` 当前结论（2026-03-21）：

- 在 `pool-bj8-imgfqud` 上，实例创建本身可以成功，不再出现 `InvalidZone.MismatchRegion`
- 但实例始终无法通过 `sandbox-clientproxy -> <private-ip>:49983/health` 健康检查
- `clientproxy` 稳定返回 `dial tcp <private-ip>:49983: connect: connection refused`
- 结合仓库文档和代码，当前 sandbox 假设镜像内已经具备并启动：
  - TAT
  - `envd`
  - `127.0.0.1:49983/health`
- 当前实现不会在创建实例后自动 bootstrap `envd`

这条镜像契约非常关键：

- sandbox 可用镜像不是“能启动一台 CVM”就够了
- 镜像必须实现 sandbox 约定的运行时接口，最关键的是实例内健康检查端点 `127.0.0.1:49983/health`
- 若镜像未自启动 `envd`/TAT，worker 会在健康检查阶段把实例判为失败并自动清理

因此，`img-fqudgz8r` 目前不作为 ctl 联调默认镜像使用。继续做功能联调时，请仍然使用可工作的默认池/镜像：

- `default_template_id = "pool-c3"`
- 当前测试环境主力池镜像请以 `pools.base_image` 实时查询结果为准，不要再假设 `pool-bj8` 是 ctl 默认池

`img-fqudgz8r` 相关问题需要找镜像维护同事进一步确认：

- 镜像内是否已预装并自启动 `envd`
- 镜像内 TAT 是否正常在线
- 该镜像是否本来就不是给 sandbox 直接作为 `base_image` 使用的

### 本地数据库

```toml
[db]
host = "127.0.0.1"
port = 13306
user = "root"
password = "${CTL_LOCAL_DB_PASSWORD_ENC}"
database = "ctl"

[redis]
host = "127.0.0.1"
pass = "${CTL_LOCAL_REDIS_PASSWORD_ENC}"
port = 16379
```

### 安全相关（本地已关闭）

```toml
[api]
enable_inner_sign = false    # 内网签名校验
```

## 密码加密

ctl 配置中的密码字段经过 AES 加密。生成加密密码：

```bash
cd ctl
go test -v -test.run=TestCipherEncrypt ./pkg/util/ -args "your_password"
# 输出: crypted your_password <base64_encoded_string>
# 将 base64 字符串填入 .secret/ctl/local.env 或 test.env 中对应的 *_ENC 变量
```

解密验证：
```bash
go test -v -test.run=TestCipherDecrypt ./pkg/util/ -args "<base64_string>"
```

## 数据库迁移

ctl 使用 `migrations/` 目录下的 SQL 文件管理数据库 schema。相关文件：

```
migrations/
├── 000001_init_schema.up.sql
├── 000002_create_instances.up.sql
└── 000003_create_user_resource_quota.up.sql
```

启动时 GORM 会根据 Entity 定义自动建表（`AutoMigrate`），无需手动执行迁移。如需手动执行迁移脚本，参考集成测试中的 `testutil.ApplyMigrations`。

## go.work 配置

monorepo 根目录的 `go.work` 已包含 ctl：

```go
go 1.26
use (
    ./ai-gateway
    ./ctl
)
```

如果在其他模块目录下执行 go 命令遇到 workspace 冲突，可临时设置 `GOWORK=off`。

## 调用链路

```
用户请求 POST /v1/instances
  → ctl API (localhost:9590)
    → logic.CreateInstance(defaultTemplate="pool-c3")
      → sandboxAdapter.CreateSandbox(templateID="pool-c3")
        → POST http://sandbox-api/sandboxes {templateID: "pool-c3"}
          → sandbox-api 从 pool-c3 分配 CLEAN Instance
            → 返回 sandboxID + 连接信息
```

## 常见问题

**Q: 启动报 `Access denied for user 'root'@'...' (using password: NO)`**
密码配置需要经过加密。检查 `password` 字段是否为 `EncryptString` 后的 base64 值。

**Q: 启动报 `directory ... is contained in a module that is not one of the workspace modules`**
在根目录执行 `go work use ./ctl`，或设置 `GOWORK=off`。

**Q: 修改了 database name 需要重建容器**
`MYSQL_DATABASE` 只在首次创建时生效，需要 `./conf/local/dev.sh restart`（会清除数据）。

**Q: sandbox API 公网 CLB 返回 502**
当前先不要直连公网 CLB。使用 `kubectl port-forward -n sandbox svc/sandbox-api 18081:80`，并把 `adapter.sandbox.baseUrl` 覆盖成 `http://127.0.0.1:18081`。

**Q: CreateInstance 返回 SANDBOX_STATUS_CONFLICT**
先检查 `default_template_id` 和 `candidate_template_ids`。当前测试环境默认模板是 `pool-c3`；如果某个池压力过大，优先在 `pool-c2~pool-c5` 之间切换，不要默认回退到 `pool-bj8`。

**Q: CVM 创建成功，但实例还是很快失败**
优先检查镜像是否满足 sandbox 运行时契约。详情见 `docs/sandbox-image-contract.md`。
