# Chatserver K8s + TDSQL 部署设计

## 目标

将 Chatserver 后台部署到用户提供的 Kubernetes `dep` 命名空间，使用
`21.6.115.40:3306` 的 TDSQL MySQL 实例。首版单副本运行，通过内网
LoadBalancer IP 提供 HTTP Canary 服务。

## 架构

```text
内网客户端 / Agent
        │ HTTP（Canary）
        ▼
TKE 内网 LoadBalancer
        ▼
chatserver Deployment（1 replica）
        ├── HTTP API / Worker / Scheduler
        ├── 腾讯云 IM/TAT API
        └── TDSQL MySQL

chatserver-migrate Job ──► TDSQL MySQL
```

## 数据库

- `config.Database` 支持 `sqlite` 与 `mysql` 两种明确方言；不按字符串猜方言。
- MySQL DSN 仅从 `0600` Secret 文件读取，不放入参数、环境变量、ConfigMap 或日志。
- 使用 `go-sql-driver/mysql` 和 Ent MySQL dialect。
- 增加独立 `migrations/mysql/`，不复用 SQLite SQL；禁止外键，兼容 MySQL 5.7.8
  及 TDSQL。
- migration 由独立 Job 执行；Deployment 启动只校验 migration 已完成，不在每个
  Pod 启动时抢跑 DDL。
- 首次创建并使用 `chatserver` database；若 root 无建库权限则稳定失败，不改用
  其他库。

## 容器与配置

- 多阶段构建：Go 1.25.12 构建，distroless/nonroot 运行。
- 只包含 `chatserver` 后台二进制和 CA 证书。
- 非敏感参数由 Deployment args/ConfigMap 提供。
- JWT、IM、TAT、TDSQL 凭据通过 Kubernetes Secret 文件挂载。
- 容器只读根文件系统、非 root、禁用 privilege escalation、丢弃 Linux capabilities。

## 服务与健康

- `/healthz`：进程 HTTP loop 可用。
- `/readyz`：数据库可 Ping，且当前 migration 无 pending/dirty 状态。
- Service 优先复用集群现有内网 LoadBalancer subnet；若分配失败，回退 ClusterIP。
- Canary 暂用内网 HTTP/IP；正式生产必须补 TLS 域名后再处理公网 Bearer 流量。

## 部署顺序

1. 收紧 kubeconfig 权限。
2. 在 `dep` 创建一次性 MySQL 8.4 探针，验证 TDSQL 白名单和账号。
3. 完成并验证 MySQL/TDSQL 代码与 migration。
4. 构建、扫描并推送不可变镜像。
5. 创建/更新 Secret 和非敏感 ConfigMap。
6. 执行 migration Job；失败即停止 rollout。
7. 部署单副本 Deployment 和内网 LoadBalancer Service。
8. 验证 health/readiness、数据库 schema、API 和 worker；记录镜像 digest 与回滚命令。

## 回滚

- Deployment 保留上一 ReplicaSet，按镜像 digest 回滚。
- migration 单向前滚，不自动 down；本轮只允许向空库初始化。
- 迁移失败不会启动新 Deployment，也不会删除数据库。
