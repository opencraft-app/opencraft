# 独立 k3s Backend 发布运行手册

本手册描述 Backend 的 migration/rollout 正式顺序。它不发布 Web、Computer catalog 或 TUI，也不提供一键脚本。当前目标事实见 [`k3s-release.md`](./k3s-release.md)。

## 发布前分类

发布前必须先判断 migration 是否向后兼容：

- **向后兼容**：追加 nullable 列、带安全默认值的列、旧 Backend 可以继续读取的新增对象。允许先 migrate，再切新 Backend；新 rollout 失败时可以恢复旧 image。
- **非向后兼容**：删除/重命名字段、改变旧进程必需语义、旧 image 无法在新 schema 上启动。必须设计只能前滚的独立切换，禁止把旧 image 当作 rollback。

无法证明向后兼容时，按非向后兼容处理。

## 固定顺序

```text
clean pushed commit
→ Backend gates
→ immutable linux/amd64 image push
→ migration Job
→ verify Job
→ Backend digest rollout
→ Pod imageID + HTTP verification
```

不得并行运行 migration Job 和 Backend rollout。migration Job 完成不等于数据库正确，必须再运行独立 verify Job；verify 成功也不等于 Backend 已发布。

## 1. 源码与 Backend 门禁

```bash
git fetch origin
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)"

cd backend
go test ./...
go vet ./...
go test -race ./...
./scripts/check-generated.sh
./scripts/check-migration-release.sh
./scripts/check-openapi-compatibility.sh
go run ./cmd/migrationgen --dialect tdsql --verify
./scripts/scan-secrets.sh .
```

镜像 tag 只用于定位，Deployment 必须使用 Registry 返回的真实 digest。Builder 必须单独验证 Docker daemon、Buildx、`linux/amd64` 和 Registry 状态；Docker CLI 存在不代表 daemon 可用。

## 2. Live 与 Secret 引用预检

使用显式 target identity 登录目标主机，读取并保存：

- Backend 当前不可变 image；
- Deployment generation、策略、1/1 Ready 状态；
- 当前 Secret 和 Computer catalog ConfigMap 的**名称**；
- 当前 source commit/release 注解；
- Pod imageID、Ready 和 restartCount。

不得输出或复制 Secret 内容。migration/verify Job 只复用 live Secret 引用和现有 imagePullSecrets。

## 3. migration Job

使用新 Backend digest 创建唯一 Job：

```text
chatserver-migrate-<commit12>
```

容器参数固定为：

```text
database migrate --database-driver tdsql --database-dsn-file /var/run/secrets/chatserver/tdsql.dsn
```

Job 必须 `backoffLimit: 0`、有 `activeDeadlineSeconds`、以非 root 身份运行，并只读挂载 live Secret。保存 Job YAML、状态和日志；失败时禁止切 Backend image。

## 4. verify Job

migration 成功后，以相同新 digest 和 Secret 引用运行新的唯一 verify Job：

```text
chatserver-verify-<commit12>
database verify --database-driver tdsql --database-dsn-file /var/run/secrets/chatserver/tdsql.dsn
```

要求 verify Job `Complete 1/1`，日志确认当前 migration version、待执行为 0 且校验通过。

## 5. Backend digest rollout

保存原 image 后，只修改 `chatserver` container image 和 source/release 注解。不得修改副本数、Recreate 策略、Secret、Computer catalog、资源限制或网络暴露方式。

轮询 Deployment JSON，要求 generation 完全收敛、1/1 updated/ready/available、0 unavailable。随后验证唯一 Pod：

- Running、Ready；
- `restartCount=0`；
- `imageID` 精确命中新 digest。

外部至少验证 `/healthz`、`/readyz`、`/install`，并确认 `/v1/me` 未认证返回 401。涉及本次 API 的路径还必须验证相应身份域和错误语义。

## 6. 回滚边界

对于已证明向后兼容的 migration，rollout 或 HTTP 验收失败时恢复原 Backend digest，并重新验证原 Pod 与 HTTP。数据库 migration 保留，不执行逆向 SQL。

对于非向后兼容 migration，旧 image 不是合法回滚目标；必须执行预先审查的前滚修复。没有该方案时禁止开始发布。

## 发布证据

至少保存：commit、tag/digest、migration/verify Job YAML/状态/日志、Deployment 前后快照、Pod imageID/Ready/restartCount、HTTP 状态矩阵和 rollback 结论。任何凭据、DSN、Secret data、cookie 或 presigned URL 都不得进入证据。
