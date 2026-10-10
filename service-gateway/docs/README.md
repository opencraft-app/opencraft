# 公共 Service Gateway

`service-gateway` 是国内/国际站公共 API 的入口层，组合站点路由、鉴权与后端 upstream；它不拥有被代理服务的业务状态。

## 权威入口

- [服务说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- 路由代码：`../internal/gateway/`
- [账号到 Agent Journey](../../docs/engineering/journeys/account-to-agent.md)

## 关键边界

公共路径验证不能被后端直连替代。`admin-gateway` 有独立流水线和镜像，不能通过本服务夹带发布。`platform.env` 是 infra 派生输入，运行时 Secret 走 GitOps Secret 主线。

## Collaboration upstream

OpenCraft 通过现有 LightVela 账户会话访问 Collaboration，不增加第二套登录账户。启用组件时，在目标环境生成的 gateway 配置中加入：

```yaml
collaboration:
  upstream: http://collaboration.lightvela-collaboration.svc.cluster.local
  upstream_bearer_token_env: COLLABORATION_GATEWAY_TOKEN
  allowed_origins:
    - http://localhost:*
    - http://127.0.0.1:*
```

`service-gateway-runtime-secrets` 中的 `COLLABORATION_GATEWAY_TOKEN` 必须与 Collaboration Secret 挂载的 `gateway.token` 相同。Gateway 先校验 Human 会话、覆盖调用方伪造的身份头，再将 `/v1/collaboration` 重写为 `/v1` 并使用内部 Bearer 请求上游。内置 allowlist 不开放旧的外部 Computer/TAT bootstrap surface。
北京首次接线由 Collaboration SSM 的同一个 `gateway.token` 只投影出专用
`collaboration-gateway-token` Secret，不复制数据库或 IM 密钥。配置 Collaboration upstream
但缺少该环境变量时，Gateway 必须启动失败，不能以 Healthy Pod 承载稳定 `502`。
`allowed_origins` 必须限定本地预览和明确产品域名，不能继承北京环境的全局 `*`。

## 验证

### 内嵌 OpenCraft 语音输入

可选 `speech` 配置启用 `GET /api/speech/capabilities` 与
`POST /api/speech/transcriptions`。浏览器只携现有登录态；Gateway 每次内省会话，
以权威用户 ID 调用 VelaGW 管理 API 的 default-purpose Key 接口，
再以该用户 Key 原样流式转发 multipart 至 VelaGW `/v1/audio/transcriptions`。
不转发用户自报身份、Cookie、查询参数或管理令牌，不解析 multipart 到临时文件。

```yaml
speech:
  control_url: http://velagw-control.example.internal
  traffic_url: http://velagw-traffic.example.internal
  admin_token_env: VELAGW_SPEECH_ADMIN_TOKEN
  allowed_origins:
    - https://lightvela.com
```

地址必须是同一区域的固定 origin，不接受客户端 upstream；管理令牌由运行时 Secret 提供。
上海与新加坡分别通过本地域的 `service-gateway-speech-secrets` 投影令牌；
`scripts/ssm_manifest.service-gateway.{shprod,sgprod}.yaml` 从现有区域 SSM 凭据仅映射
`CTL_LLMGATEWAY_ADMIN_TOKEN`，不复制 CTL 的其他密钥，也不引入第二凭据真源。
上海使用 `token-admin.lightvela.com` / `token.lightvela.com`，新加坡使用
`token-admin.lightvela.ai` / `token.lightvela.ai`，分别晋级区域配置与加密 Secret。
未配置时路由不启用，配置但没有令牌时启动失败。默认 Key 存在时复用；缺失时
现有管理接口可能创建 Key，但不重置实例配置或自行授予套餐权益。
202 只代表 Key 请求受理，缓存其未就绪结果 60 秒，不自动重复提交或重放音频。
正向缓存 TTL 60 秒、容量 4096，同用户请求合并，最多 64 个并行 Key lookup，
单次 lookup 限时 5 秒；一个调用方取消不取消其他等待者。
缓存不替代 VelaGW 鉴权；数据面拒绝 Key 时条件失效缓存，并将上游认证失败映射为服务暂不可用，
不能误判为浏览器登录过期。音频请求最多 4 MiB、95 秒，无自动重试；供应商原始错误正文不返回浏览器。

本能力仍需配置、构建与独立 GitOps 发布后才可用于线上；源码不自动启用生产配置。

运行 `go test ./...`，并对每个路由变更验证目标站点、鉴权/实名失败、上游成功与错误传播；发布另核对独立 Argo 应用。
