# Raft Platform 双 Pod 部署

生产形态由两个完全独立的工作负载组成：

- `raft-web-static`：只运行 Nginx，托管 Expo 导出的静态文件；
- `raft-api`：运行本仓库 `backend/` 的 OpenAPI-first Go 后台，SQLite 数据位于独立 CBS 云盘。

公网 Ingress 将 `/v1`、`/internal`、`/healthz`、`/readyz` 转发给后台，其他路径转发给静态站。前端因此使用同源 API，不依赖后台 Pod 托管文件，也不需要跨域配置。

当前 Canary 地址为 `https://raft.lightvela.com`。DNS 使用 CNAME 指向独立 CLB；TLS 复用 `*.lightvela.com` 证书。腾讯云默认 CLB 域名不能作为用户访问地址。

后台使用单副本和 `Recreate` 更新策略，防止两个进程同时打开 SQLite。未来迁移到 TDSQL 后，可再改为多副本滚动更新。

## 构建顺序

1. 在仓库根目录执行 `bun run --cwd web build:web`；
2. 以 `web/` 为上下文构建 `web/deploy/static/Dockerfile`，并以 `backend/` 为上下文构建 `backend/Dockerfile`；
3. 在集群中以 `raft-api-secrets` 保存 JWT 私钥、腾讯云 IM 密钥和回调 Token；
4. 以只读 TCR 服务账号创建 `tcr-raft-platform` 镜像拉取凭证；
5. 以腾讯云证书 ID 创建 `lightvela-wildcard` Secret；
6. 更新清单中的镜像标签，执行 `kubectl apply -k deploy/k8s`。

真实密钥不得写入这些部署清单或提交到仓库。
