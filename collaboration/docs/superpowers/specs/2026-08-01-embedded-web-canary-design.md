# Chatserver 内嵌 Web Canary 设计

日期：2026-08-01

## 目标

将 `/Users/skipzhang/new-api/raft-web/reconstructed` 的现有平台 v1 React 客户端构建为静态资源，并嵌入 Chatserver 单一二进制。继续使用当前 `dep/chatserver-canary`、单 Pod、单内网 CLB，不增加 Nginx、Ingress 或第二套前端服务。

## 外部行为

- `/v1/*` 继续由 Go 平台 API 处理。
- `/healthz`、`/readyz` 保持现有语义。
- `/static/*` 和其他已存在的构建产物由嵌入文件系统返回。
- `/` 及无扩展名的浏览器路由回退到 `index.html`。
- 整个 `/v1` 命名空间永远交给 API；未知 API 也不得回退 HTML。
- `/static/*` 下任何缺失路径以及其他缺失的带扩展名资源返回 404，不以 HTML 冒充脚本或样式；错误响应不得携带 immutable 缓存头。
- 静态页面只接受 GET/HEAD；其他方法返回 405。
- `index.html` 使用 `no-cache`；带内容哈希的 `/static/*` 资源使用长期 immutable 缓存。

## 浏览器连接

前端默认使用 `window.location.origin`。因此 Canary 页面通过同一地址访问 `/v1`，无 CORS；腾讯云 IM SDK 继续凭短期 UserSig 直连腾讯 WSS。只有当页面与目标地址都属于 loopback 时，开发环境才允许通过 `?backend=http://127.0.0.1:18080` 或 sessionStorage 覆盖。非 loopback 页面必须忽略并清除已有覆盖值，防止密码、Bearer 或 refresh token 被发送到第三方源。

## 构建与发布

1. 固定 Bun 版本，使用 frozen lockfile；记录 Raft Web Git revision、实际输入内容 SHA-256 和 Chatserver 输入 SHA-256。
2. 在 `raft-web/reconstructed` 清空旧输出，用 Bun 运行类型检查、测试、安全扫描和生产构建。
3. 将生成的 `dist/` 以删除陈旧文件的方式同步到 Chatserver 的 `internal/webui/dist/`；生成逐文件 SHA-256 清单。该目录是发布输入，不保存任何账号或运行时配置。
4. Go 通过 `embed.FS` 把静态资源编入现有二进制。
5. Dockerfile 固定 Go builder 与 distroless 镜像 digest，构建 Linux AMD64 镜像并推送不可变 digest。
6. 先完成本地 handler、发布目录、最终二进制/镜像扫描，再更新 Kubernetes Deployment；数据库无需再次迁移。

## 安全与回滚

- 不向静态资源写入腾讯云密钥、UserSig、Bearer 或 API 地址。
- 发布扫描显式覆盖 `internal/webui/dist/` 和最终二进制，禁止固定后端地址、source map 与疑似凭据；不能依赖会跳过 `dist` 的前端源码扫描器。
- API 路由优先于 SPA fallback，避免认证错误被前端 HTML 吞掉。
- 资源路径在嵌入文件系统内解析，不访问宿主文件系统。
- 保留上一版镜像 digest；发布失败时只需恢复 Deployment 镜像。
- Deployment 使用 `Recreate`，避免一次发布中旧 HTML 与新哈希资源交叉命中；接受单副本数秒短暂中断。

## 验收

- Go handler 测试覆盖首页、资源、SPA fallback、`/static` 无扩展名缺失资源 404、GET/HEAD、未知 `/v1` 不回退、API 路由优先级与成功/错误缓存头。
- 前端测试覆盖同源默认值、仅 loopback 覆盖、清除生产遗留覆盖，以及已有 session 时恶意 backend 不改变目标源。
- `go test ./...`、`go vet ./...`、`bun run typecheck`、`bun run test`、`bun run build`、前后端凭据扫描全部通过。
- 内网 CLB 的 `/` 返回 HTML，静态资源 200，深链刷新 200；`/v1/me` 未认证仍返回 401；健康检查保持 `ok/ready`。Recreate 发布在限定超时内恢复，失败则恢复上一 digest。
