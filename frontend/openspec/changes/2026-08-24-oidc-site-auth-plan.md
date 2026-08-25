# 统一 OIDC 站点鉴权 Implementation Plan

**Size:** L，跨 UserAuth、site-gateway、frontend，涉及公共鉴权协议和数据库迁移。

- [x] **developer-auth**：在 `user/auth/internal/oidc/**`、`user/auth/internal/httpapi/oidc*.go`、`user/auth/migrations/**`、`user/auth/cmd/lightclaw-auth/**`、`user/auth/api/openapi.yaml` 与生成产物实现并测试 exact-only registry、PKCE、MySQL 单次 code、Ed25519 token、discovery/JWKS/authorize/token；运行 `go generate`，验收为 OpenAPI 路由存在、Go 定向测试和迁移测试通过。
- [x] **developer-frontend**：在 `frontend/src/pages/auth/federation-authorize-page.tsx`、Repository types/HTTP 实现和对应测试中切换 OIDC context/confirm，保留登录/切换账号交互；验收为页面与 Repository Vitest 通过。
- [x] **developer-site**：在 `site-gateway/internal/siteauth/**`、`site-gateway/internal/httpapi/siteauth.go`、config/main 和测试中实现 fixed-host start/callback、独立 AEAD keyring、OIDC exchange、二跳 handoff、Host-only Cookie；验收为 package 全量 Go 测试通过。
- [x] **developer-ctl**：在 `ctl/pkg/logic/website/**`、`ctl/main/api/website*` 的内部 token 保护站点视图中补充唯一 `user_id` 和契约测试；验收为 CTL website 定向测试通过，公网用户接口不新增该字段。
- [x] **developer-config**：更新 `user/auth`、`site-gateway` source-facing 配置模板与协议文档，明确 UserAuth signing key 与 site-gateway AEAD key归属，不写生产密钥；验收为配置解析测试和 `git diff --check` 通过。
- [x] **reviewer**：运行 UserAuth/site-gateway Go 全量测试、frontend 定向测试与 `pnpm check`/i18n；执行 `.tech/.site` fixed-host callback、code replay、launch/state 篡改、跨站 handoff、Cookie 无 Domain 的跨服务集成夹具和安全 review；验收为无 P0/P1 finding。
- [x] **developer-site-endpoints**：在 `site-gateway/**` 将 fixed OIDC endpoints 与静态内容门禁解耦，增加 concrete site 显式 auth start；验收为 public+enabled、required+enabled、public+disabled 三矩阵测试和全量 Go 测试通过。
- [ ] **leader**：汇总 diff、验证和剩余发布依赖，展示提交内容并等待用户确认；不自动 commit/push/MR。
