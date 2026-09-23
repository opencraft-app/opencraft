# lightclaw-auth

OpenCraft 第一方客户端登录契约：[native-login.openapi.yaml](api/native-login.openapi.yaml)。
该扩展与 Google OAuth 路由一样在 `internal/httpapi/server.go` 手动注册；不由主
OpenAPI 的 strict handler 生成。原生客户端只接收 PKCE 一次性授权码，不接收 URL
中的会话 token。生产需同步网关精确公开 GET `/auth/native/start` 和 POST
`/auth/session/exchange`（`/auth/native/token` 仅为已发布客户端保留兼容别名）；详见[身份与访问设计](../../docs/engineering/domains/identity-access.md)。

CI trigger note: 2026-07-21 rebuild after GitOps validation fix.

CI trigger note: 2026-09-23 recompile pipeline definition onto cn-pool runner (see MR !4562).
