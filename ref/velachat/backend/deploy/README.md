# Chatserver Canary 部署

本目录只保存无密钥的部署模板。生产 Secret 必须在部署时从受限本地文件创建，禁止写入 YAML、命令参数、日志或镜像层。

发布顺序固定为：

1. 构建并推送 Linux AMD64 镜像，记录 registry digest。
2. 用 digest 替换 Deployment 和 migration Job 的镜像引用。
3. 从受限文件创建 `chatserver-canary-sharded-secrets`，其中 `tdsql.dsn` 只指向全新
   `chatserver_canary_sharded_v1`；旧 `chatserver-canary-secrets` 保留作回滚。
4. 先运行一次 `migration-job.yaml`，成功后再应用 Deployment 与 Service。
5. 验证 `/healthz`、`/readyz` 和数据库 `verify`。

TDSQL 必须先允许 Kubernetes 工作节点/出口网段访问。当前已观测到的节点来源是 `21.91.127.116`；白名单未放开时迁移 Job 会稳定失败，不应反复重试。

禁止把旧 `chatserver_canary` 原地改造成分片表。分片版只允许在空库执行 baseline，
`database verify --database-driver tdsql` 通过后才能切换 Deployment。
