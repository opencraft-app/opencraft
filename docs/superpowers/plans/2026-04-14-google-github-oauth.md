# 实现计划：Google & GitHub OAuth 登录

**分支**: `feature/oauth-google-github`  
**规格文档**: `docs/superpowers/specs/2026-04-14-google-github-oauth-design.md`  
**参考实现**: `user/auth/internal/httpapi/qq_oauth.go`

---

## 概览

为 `user/auth` 服务新增 Google 和 GitHub OAuth 授权登录。模式与现有 QQ OAuth 完全一致：独立文件、Cookie CSRF 保护、invite code 校验、avatar 同步。使用 `golang.org/x/oauth2` 标准库做 token 交换。

---

## Task 1：添加 golang.org/x/oauth2 依赖

**工作目录**: `user/auth/`

```bash
cd user/auth && go get golang.org/x/oauth2@latest
```

验证：`go.mod` 中出现 `golang.org/x/oauth2`。

---

## Task 2：实现 google_oauth.go

**新建文件**: `user/auth/internal/httpapi/google_oauth.go`

设计要点：
- `GoogleOAuthClient` 接口：`ExchangeCode(ctx, code, redirectURI) (*GoogleOAuthToken, error)` + `ResolveIdentity(ctx, accessToken) (service.OAuthSignInInput, error)`
- `GoogleOAuthConfig` 结构体：`ClientID`, `ClientSecret`, `RedirectURI`, `FrontendBaseURL`, `PublicBaseURL`, `StateTTL`, `Client GoogleOAuthClient`
- `googleOAuth` 内部结构体（同 `qqOAuth` 模式）
- `newGoogleOAuth(config *GoogleOAuthConfig) *googleOAuth`：nil 返回 nil，空字段校验
- state cookie 名：`lc_google_oauth_state`，path：`/auth/oauth/google/callback`
- `StartGoogleOAuth` handler：生成 state → 写 cookie → 重定向到 Google OAuth URL
  - authorize URL：`https://accounts.google.com/o/oauth2/v2/auth`
  - scope：`openid email profile`
  - 额外参数：`access_type=offline`
- `HandleGoogleOAuthCallback` handler：校验 state → 交换 code → 获取用户信息 → SignInWithOAuth → 同步 avatar → 设置 session cookie → 重定向前端
- 错误重定向 query 参数：`oauth_error=google_state_mismatch | google_exchange_failed | google_identity_failed | invite_required | google_sign_in_failed`
- `clearGoogleOAuthStateCookie` 方法
- `googleOAuth` 的辅助方法（复用 `frontendURL`, `successFrontendURL`, `redirectURIForRequest`, `frontendBaseURLForRequest` — 直接抄 qqOAuth 的实现，不做跨文件共享）
- HTTP 客户端实现 `googleOAuthHTTPClient`：
  - `ExchangeCode`：POST `https://oauth2.googleapis.com/token`，form body，返回 JSON
  - `ResolveIdentity`：GET `https://www.googleapis.com/oauth2/v3/userinfo`，Bearer token
  - `provider = "google"`，`ProviderSubject = sub 字段`
  - `EmailVerified` 从 userinfo 的 `email_verified` 字段读取

---

## Task 3：实现 github_oauth.go

**新建文件**: `user/auth/internal/httpapi/github_oauth.go`

设计要点：
- `GitHubOAuthClient` 接口：`ExchangeCode(ctx, code, redirectURI) (*GitHubOAuthToken, error)` + `ResolveIdentity(ctx, accessToken) (service.OAuthSignInInput, error)`
- `GitHubOAuthConfig` 结构体：`ClientID`, `ClientSecret`, `RedirectURI`, `FrontendBaseURL`, `PublicBaseURL`, `StateTTL`, `Client GitHubOAuthClient`
- `githubOAuth` 内部结构体
- `newGitHubOAuth(config *GitHubOAuthConfig) *githubOAuth`
- state cookie 名：`lc_github_oauth_state`，path：`/auth/oauth/github/callback`
- `StartGitHubOAuth` handler
  - authorize URL：`https://github.com/login/oauth/authorize`
  - scope：`read:user user:email`
- `HandleGitHubOAuthCallback` handler
- 错误重定向：`oauth_error=github_state_mismatch | github_exchange_failed | github_identity_failed | invite_required | github_sign_in_failed`
- `clearGitHubOAuthStateCookie` 方法
- HTTP 客户端 `gitHubOAuthHTTPClient`：
  - `ExchangeCode`：POST `https://github.com/login/oauth/access_token`，JSON body，`Accept: application/json`
  - `ResolveIdentity`：
    - GET `https://api.github.com/user` 获取基本信息
    - 若 `user.Email` 为空，则调用 GET `https://api.github.com/user/emails`，取 `primary=true AND verified=true` 的邮箱
    - `provider = "github"`，`ProviderSubject = strconv.FormatInt(user.ID, 10)`
    - `EmailVerified = true`（GitHub 已验证邮箱才能用于登录）
  - 所有 API 请求带 `Authorization: token <accessToken>` 和 `Accept: application/vnd.github+json`

---

## Task 4：编写单元测试

**新建文件**: `user/auth/internal/httpapi/google_oauth_test.go`

测试用例（table-driven）：
- `TestStartGoogleOAuth`：
  - googleOAuth 未配置 → 404
  - 正常启动 → 302，Location 含 Google authorize URL，写了 state cookie
- `TestHandleGoogleOAuthCallback`：
  - state 不匹配 → 重定向含 `google_state_mismatch`
  - ExchangeCode 失败 → 重定向含 `google_exchange_failed`
  - ResolveIdentity 失败 → 重定向含 `google_identity_failed`
  - invite_required → 重定向含 `invite_required`
  - 成功 → 设置 session cookie，重定向前端

**新建文件**: `user/auth/internal/httpapi/github_oauth_test.go`

测试用例（同 Google，调整 provider 细节）：
- `TestStartGitHubOAuth`
- `TestHandleGitHubOAuthCallback`

测试基础设施：使用 `httptest.NewRecorder` + gin test engine；mock 实现 `GoogleOAuthClient` / `GitHubOAuthClient` 接口。

---

## Task 5：修改 handler.go — 增加字段和构造函数参数

**修改文件**: `user/auth/internal/httpapi/handler.go`

1. `Handler` struct 新增字段：
   ```go
   googleOAuth *googleOAuth
   githubOAuth *githubOAuth
   ```
2. `NewHandler` 参数新增 `googleConfig *GoogleOAuthConfig, githubConfig *GitHubOAuthConfig`
3. 构造函数内调用 `newGoogleOAuth(googleConfig)` 和 `newGitHubOAuth(githubConfig)`

---

## Task 6：修改 server.go — 注册路由和更新 ServerConfig

**修改文件**: `user/auth/internal/httpapi/server.go`

1. `ServerConfig` 新增：
   ```go
   GoogleOAuth *GoogleOAuthConfig
   GitHubOAuth *GitHubOAuthConfig
   ```
2. `NewRouter` 中 `NewHandler` 调用更新参数
3. 条件注册新路由：
   ```go
   if handler.googleOAuth != nil {
       router.GET("/auth/oauth/google/start", handler.StartGoogleOAuth)
       router.GET("/auth/oauth/google/callback", handler.HandleGoogleOAuthCallback)
   }
   if handler.githubOAuth != nil {
       router.GET("/auth/oauth/github/start", handler.StartGitHubOAuth)
       router.GET("/auth/oauth/github/callback", handler.HandleGitHubOAuthCallback)
   }
   ```

---

## Task 7：修改 main.go — 环境变量读取

**修改文件**: `user/auth/cmd/lightclaw-auth/main.go`

1. 新增 `buildGoogleOAuthConfig() *httpapi.GoogleOAuthConfig`：
   - 读取 `LIGHTCLAW_GOOGLE_CLIENT_ID` + `LIGHTCLAW_GOOGLE_CLIENT_SECRET`
   - 为空则返回 nil
   - `RedirectURI` 默认 `https://lightclaw.tech/auth/oauth/google/callback`
   - `FrontendBaseURL` 使用 `LIGHTCLAW_FRONTEND_BASE_URL`
   - `PublicBaseURL` 使用 `LIGHTCLAW_PUBLIC_BASE_URL`

2. 新增 `buildGitHubOAuthConfig() *httpapi.GitHubOAuthConfig`：
   - 读取 `LIGHTCLAW_GITHUB_CLIENT_ID` + `LIGHTCLAW_GITHUB_CLIENT_SECRET`
   - 为空则返回 nil
   - `RedirectURI` 默认 `https://lightclaw.tech/auth/oauth/github/callback`

3. `ServerConfig` 中新增：
   ```go
   GoogleOAuth: buildGoogleOAuthConfig(),
   GitHubOAuth:  buildGitHubOAuthConfig(),
   ```

---

## Task 8：更新 secret-templates/test.env.example

**修改文件**: `user/auth/secret-templates/test.env.example`

在 QQ OAuth 块下方新增：
```
# Google OAuth. Leave blank to disable Google OAuth.
LIGHTCLAW_GOOGLE_CLIENT_ID=
LIGHTCLAW_GOOGLE_CLIENT_SECRET=
LIGHTCLAW_GOOGLE_REDIRECT_URI=

# GitHub OAuth. Leave blank to disable GitHub OAuth.
LIGHTCLAW_GITHUB_CLIENT_ID=
LIGHTCLAW_GITHUB_CLIENT_SECRET=
LIGHTCLAW_GITHUB_REDIRECT_URI=
```

---

## Task 9：构建验证

```bash
cd user/auth && go build ./...
cd user/auth && go test ./internal/httpapi/...
```

确保无编译错误、所有测试通过。

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| CREATE | `user/auth/internal/httpapi/google_oauth.go` |
| CREATE | `user/auth/internal/httpapi/github_oauth.go` |
| CREATE | `user/auth/internal/httpapi/google_oauth_test.go` |
| CREATE | `user/auth/internal/httpapi/github_oauth_test.go` |
| MODIFY | `user/auth/internal/httpapi/handler.go` |
| MODIFY | `user/auth/internal/httpapi/server.go` |
| MODIFY | `user/auth/cmd/lightclaw-auth/main.go` |
| MODIFY | `user/auth/secret-templates/test.env.example` |
| MODIFY | `user/auth/go.mod` + `go.sum` (添加 oauth2 依赖) |
